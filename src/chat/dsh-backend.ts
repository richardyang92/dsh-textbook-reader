/**
 * DSH Agent backend for the per-book tutor chat.
 *
 * The bridge deliberately touches only the public Agent surface documented by
 * `@deepseek-ai/dsh-agent`:
 *   ctx.agents.create/resume  -> AgentHandle
 *   agent.followup({content}) -> queue a user message
 *   agent/assistant-stream    -> streamed text/tool frames
 *   ctx.sessions.get(id)      -> derived message history
 *
 * Everything is structurally typed so the plugin does not add a runtime
 * dependency on DSH core packages.
 */

import { randomUUID } from 'node:crypto'
import type { DataPaths } from '../config.js'
import type { Book } from '../types.js'
import { randomId } from '../store/atomic.js'
import { ChatError, type AgentRuntimeEvent, type ChatAgentMode, type ChatMessage, type ChatProbeResult, type ChatTurnEndReason } from './types.js'
import type { AgentBackend, AgentConnection } from './service.js'
import { TUTOR_GUIDANCE, TEXTBOOK_TOOL_NAMES, extractCitations, stripContextHeader } from './prompt.js'

interface ModelSelectionLike {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/**
 * A complete DSH user message. The Agent loop appends this object to the
 * Session log verbatim, so omitting `id`/`role` corrupts the durable log
 * (the loader rejects a `user/message` event without an identified message).
 */
interface UserMessageLike {
  readonly id: string
  readonly role: 'user'
  readonly content: Array<{ type: 'text'; text: string }>
  readonly source: { kind: 'user' }
}

interface AgentLike {
  readonly id: string
  status?: string
  followup?(input: UserMessageLike): unknown
  cancel?(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): unknown
}

interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void> | void
}

interface AgentsLike {
  get(id: string): AgentLike | undefined
  roots?(): AgentLike[]
  create(options: Record<string, unknown>): Promise<AgentHandleLike>
  resume(options: Record<string, unknown>): Promise<AgentHandleLike>
}

interface MessageLike {
  id?: string
  role?: string
  content?: unknown
}

interface SessionLike {
  deriveMessages?(): MessageLike[]
}

interface SessionsLike {
  get(id: string): SessionLike | undefined
}

interface ToolsLike {
  schemas?(): Array<{ name: string }>
  restrict?(filter: { allow?: readonly string[]; deny?: readonly string[] }): unknown
}

interface SystemPromptLike {
  section?(input: { name: string; order: number; text: string }): unknown
}

interface AgentCtxLike {
  on?(event: string, listener: (payload: any) => void): unknown
  tools?: ToolsLike
  systemPrompt?: SystemPromptLike
}

interface HostContextLike {
  get?(name: string): any
}

export interface DshAgentBackendOptions {
  ctx: HostContextLike
  paths: DataPaths
  /** Override for tests or profile-level model defaults. */
  getModel?: () => ModelSelectionLike | undefined
  logger?: { warn?: (message: string) => void }
}

export class DshAgentBackend implements AgentBackend {
  private readonly ctx: HostContextLike
  private readonly paths: DataPaths
  private readonly getModel: () => ModelSelectionLike | undefined
  private readonly logger: { warn?: (message: string) => void }

  constructor(options: DshAgentBackendOptions) {
    this.ctx = options.ctx
    this.paths = options.paths
    this.getModel = options.getModel ?? (() => resolveDefaultModel(this.ctx))
    this.logger = options.logger ?? {}
  }

  describe(): { available: boolean; model?: { provider: string; model: string } } {
    const agents = this.agents()
    const model = this.model()
    return {
      available: Boolean(agents),
      ...(model ? { model: { provider: model.provider, model: model.model } } : {}),
    }
  }

  /** Direct model call, bypassing the Agent loop, to expose transport causes. */
  async probe(sessionId?: string, mode?: 'stream' | 'prepare'): Promise<ChatProbeResult> {
    const llm = this.ctx.get?.('llm')
    const model = this.model()
    if (!llm || typeof llm.stream !== 'function' || !model) {
      return { ok: false, error: { code: 'chat_unavailable', message: '模型服务不可用。' } }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let text = ''
    try {
      const options = {
        provider: model.provider,
        model: model.model,
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Reply with the single word OK.' }] }],
        maxTokens: 32,
        ...(sessionId ? { sessionId } : {}),
        signal: controller.signal,
      }
      let stream
      if (mode === 'prepare' && typeof llm.prepareCall === 'function') {
        const prepared = await llm.prepareCall(
          { provider: model.provider, model: model.model, maxTokens: 32 },
          controller.signal,
        )
        stream = prepared.stream({ ...options, ...prepared.config })
      } else {
        stream = llm.stream(options)
      }
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          const failure = chunk.reason.failure ?? {}
          return {
            ok: false,
            error: {
              ...(failure.code ? { code: String(failure.code) } : {}),
              message: String(failure.message ?? '模型请求失败。'),
            },
          }
        }
      }
      return { ok: true, text: text.trim() }
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined
      return {
        ok: false,
        error: {
          ...(error && typeof error === 'object' && 'code' in error ? { code: String(error.code) } : {}),
          message: describeError(error),
          ...(cause
            ? { cause: cause instanceof Error ? cause.stack ?? cause.message : String(cause) }
            : {}),
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async open(input: { book: Book; sessionId?: string; mode?: ChatAgentMode; parentSessionId?: string }): Promise<{
    connection: AgentConnection
    sessionId: string
    created: boolean
  }> {
    const agents = this.agents()
    if (!agents) {
      throw new ChatError(
        'chat_unavailable',
        '当前 DSH 环境没有提供 Agent 服务。',
        '确认 DSH 版本与插件版本匹配后重启。',
      )
    }
    const model = this.model()
    if (!model) {
      throw new ChatError('model_missing', '尚未选择可用的对话模型。', '在 DSH 设置中选择默认模型后重试。')
    }

    const connection = new DshAgentConnection({
      model,
      getSessions: () => this.sessions(),
      logger: this.logger,
    })
    const setup = (agentCtx: AgentCtxLike, agent: AgentLike): void => {
      connection.attachAgent(agent)
      const mode = input.mode ?? 'full'
      if (mode === 'full' || mode === 'restrict') this.applyRestriction(agentCtx)
      if (mode === 'full' || mode === 'tutor') {
        try {
          agentCtx.systemPrompt?.section?.({
            name: 'plugin:dsh-textbook-reader:tutor',
            order: 160,
            text: TUTOR_GUIDANCE,
          })
        } catch (error) {
          this.logger.warn?.(`[dsh-textbook-reader] tutor prompt scope failed: ${describeError(error)}`)
        }
      }
      try {
        agentCtx.on?.('agent/assistant-stream', (payload) => connection.handleStream(payload?.frame))
        agentCtx.on?.('agent/status', (payload) => connection.handleStatus(payload?.status))
      } catch (error) {
        this.logger.warn?.(`[dsh-textbook-reader] agent stream scope failed: ${describeError(error)}`)
      }
    }

    const agentOptions = modelOptions(model)
    const meta = { cwd: this.defaultCwd() }
    const requested =
      input.sessionId && !input.sessionId.startsWith('tbr-') ? input.sessionId : undefined
    let created = false
    let handle: AgentHandleLike | undefined

    if (requested) {
      const live = agents.get(requested)
      if (live) {
        connection.attachAgent(live)
        connection.setSessionId(live.id)
        return { connection, sessionId: live.id, created: false }
      }
      try {
        handle = await agents.resume({
          resumeSessionId: requested,
          agentOptions,
          setup,
        })
      } catch (error) {
        this.logger.warn?.(
          `[dsh-textbook-reader] chat resume failed, creating a new session: ${describeError(error)}`,
        )
      }
    }

    if (!handle) {
      created = true
      const sessionId = makeSessionId()
      const parent = input.parentSessionId ? agents.get(input.parentSessionId) : undefined
      if (input.parentSessionId && !parent) {
        this.logger.warn?.(
          `[dsh-textbook-reader] parent session ${input.parentSessionId} is not live; creating a root agent`,
        )
      }
      try {
        handle = await agents.create({
          sessionId,
          agentOptions,
          meta: {
            ...meta,
            ...(parent ? { parentSession: parent.id } : {}),
          },
          ...(parent ? { parentAgent: parent } : {}),
          setup,
        })
      } catch (error) {
        throw new ChatError(
          'chat_open_failed',
          `无法创建伴读会话：${describeError(error)}`,
          '确认当前模型可用后重试。',
        )
      }
    }

    connection.attachHandle(handle)
    connection.attachAgent(handle.agent)
    connection.setSessionId(handle.agent.id)
    this.rename(handle.agent.id, input.book)
    return { connection, sessionId: handle.agent.id, created }
  }

  private agents(): AgentsLike | undefined {
    const value = this.ctx.get?.('agents')
    return value && typeof value.create === 'function' && typeof value.resume === 'function'
      ? (value as AgentsLike)
      : undefined
  }

  private sessions(): SessionsLike | undefined {
    const value = this.ctx.get?.('sessions')
    return value && typeof value.get === 'function' ? (value as SessionsLike) : undefined
  }

  listRoots(): Array<{ id: string; status?: string }> {
    const agents = this.agents()
    if (!agents?.roots) return []
    return agents.roots().map((agent) => ({
      id: agent.id,
      ...(agent.status ? { status: agent.status } : {}),
    }))
  }

  /**
   * A plugin-created Agent must live in a real workspace: the account session
   * log extension is keyed by the session's cwd. The book directory is not a
   * registered workspace, so use the deployment's default directory instead.
   */
  private defaultCwd(): string {
    try {
      const workingDirectory = this.ctx.get?.('workingDirectory')
      if (workingDirectory && typeof workingDirectory.defaultDirectory === 'string') {
        const value = workingDirectory.defaultDirectory.trim()
        if (value) return value
      }
    } catch {
      // Fall through to the process directory.
    }
    return process.cwd()
  }

  private model(): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const value = this.getModel()
    if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined
    const provider = value.provider.trim()
    const model = value.model.trim()
    if (!provider || !model) return undefined
    return {
      provider,
      model,
      ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim()
        ? { reasoningEffort: value.reasoningEffort.trim() }
        : {}),
    }
  }

  private applyRestriction(agentCtx: AgentCtxLike): void {
    const tools = agentCtx.tools
    if (!tools?.restrict || !tools.schemas) return
    try {
      const available = new Set(tools.schemas().map((tool) => tool.name))
      const allow = TEXTBOOK_TOOL_NAMES.filter((name) => available.has(name))
      if (allow.length === 0) {
        this.logger.warn?.('[dsh-textbook-reader] no textbook tools registered; tutor restriction skipped')
        return
      }
      tools.restrict({ allow })
    } catch (error) {
      this.logger.warn?.(`[dsh-textbook-reader] tutor tool restriction failed: ${describeError(error)}`)
    }
  }

  private rename(sessionId: string, book: Book): void {
    try {
      const controller = this.ctx.get?.('sessionController')
      if (!controller || typeof controller.rename !== 'function') return
      void Promise.resolve(controller.rename({ sessionId, title: `教材伴读 · ${book.title}` })).catch(
        () => {},
      )
    } catch {
      // Title is cosmetic; a failure never blocks chat.
    }
  }
}

class DshAgentConnection implements AgentConnection {
  readonly model: { provider: string; model: string }
  private readonly getSessions: () => SessionsLike | undefined
  private readonly logger: { warn?: (message: string) => void }
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>()
  private readonly toolCalls = new Set<string>()
  private sessionIdValue = ''
  private agent: AgentLike | undefined
  private handle: AgentHandleLike | undefined
  private pending = ''
  private running = false
  private disposed = false

  constructor(options: {
    model: { provider: string; model: string; reasoningEffort?: string }
    getSessions: () => SessionsLike | undefined
    logger: { warn?: (message: string) => void }
  }) {
    this.model = { provider: options.model.provider, model: options.model.model }
    this.getSessions = options.getSessions
    this.logger = options.logger
  }

  get sessionId(): string {
    return this.sessionIdValue
  }

  setSessionId(sessionId: string): void {
    this.sessionIdValue = sessionId
  }

  attachAgent(agent: AgentLike): void {
    this.agent = agent
    if (!this.sessionIdValue) this.sessionIdValue = agent.id
  }

  attachHandle(handle: AgentHandleLike): void {
    this.handle = handle
  }

  async send(prompt: string): Promise<void> {
    const agent = this.agent
    if (!agent || typeof agent.followup !== 'function') {
      throw new ChatError('chat_unavailable', '伴读会话尚未就绪。', '重开聊天面板后重试。')
    }
    // `followup` does not create an identity; it commits the message object
    // into the Session log as-is. Always send the complete UserMessage shape
    // (id + role + content + source) or the durable log becomes unloadable.
    const message: UserMessageLike = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }
    try {
      await Promise.resolve(agent.followup(message))
    } catch (error) {
      throw new ChatError('send_failed', `消息发送失败：${describeError(error)}`)
    }
  }

  cancel(): void {
    try {
      this.agent?.cancel?.({ kind: 'user' })
    } catch (error) {
      this.logger.warn?.(`[dsh-textbook-reader] agent cancel failed: ${describeError(error)}`)
    }
  }

  history(limit = 50): ChatMessage[] {
    const session = this.getSessions()?.get(this.sessionIdValue)
    const messages = session?.deriveMessages?.() ?? []
    const out: ChatMessage[] = []
    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue
      const text = extractText(message.content)
      if (!text.trim()) continue
      const display = message.role === 'user' ? stripContextHeader(text) : text.trim()
      if (!display) continue
      const citations = extractCitations(display)
      out.push({
        id: typeof message.id === 'string' && message.id ? message.id : randomId('hist'),
        role: message.role,
        text: display,
        ...(citations.length ? { citations } : {}),
      })
    }
    return out.slice(-Math.max(1, limit))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.listeners.clear()
    const handle = this.handle
    this.handle = undefined
    this.agent = undefined
    if (handle) await Promise.resolve(handle.dispose()).catch(() => {})
  }

  isRunning(): boolean {
    return this.running
  }

  onEvent(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  handleStatus(status: unknown): void {
    if (this.disposed) return
    const next = status === 'running' ? 'running' : status === 'idle' ? 'idle' : undefined
    if (!next) return
    this.running = next === 'running'
    this.emit({ type: 'status', status: next })
  }

  handleStream(frame: any): void {
    if (this.disposed || !frame || typeof frame !== 'object') return
    if (frame.type === 'start') {
      this.pending = ''
      this.running = true
      this.toolCalls.clear()
      this.emit({ type: 'start', turn: Number(frame.turn) || 0, step: Number(frame.step) || 0 })
      return
    }
    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (!chunk || typeof chunk !== 'object') return
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        this.pending += chunk.text
        this.emit({ type: 'delta', text: chunk.text })
        return
      }
      if (chunk.type === 'tool-call-delta') {
        const name = typeof chunk.name === 'string' ? chunk.name : ''
        const callId = typeof chunk.id === 'string' ? chunk.id : ''
        if (name && callId && !this.toolCalls.has(callId)) {
          this.toolCalls.add(callId)
          this.emit({ type: 'tool', status: 'start', name, callId })
        }
        return
      }
      if (chunk.type === 'finish') {
        const mapped = mapFinish(chunk.reason)
        if (mapped) {
          this.emit({
            type: 'finish',
            reason: mapped.reason,
            ...(mapped.message ? { message: mapped.message } : {}),
          })
        }
      }
      return
    }
    if (frame.type === 'end') {
      const seq = frame.outcome && typeof frame.outcome.seq === 'number' ? frame.outcome.seq : undefined
      this.running = false
      this.emit({ type: 'end', ...(seq !== undefined ? { seq } : {}) })
    }
  }

  private emit(event: AgentRuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        this.listeners.delete(listener)
      }
    }
  }
}

function resolveDefaultModel(ctx: HostContextLike): ModelSelectionLike | undefined {
  try {
    const service = ctx.get?.('agentDefaultModel')
    if (!service || typeof service.currentSelection !== 'function') return undefined
    const selection = service.currentSelection()
    if (!selection || typeof selection !== 'object') return undefined
    return selection as ModelSelectionLike
  } catch {
    return undefined
  }
}

function modelOptions(model: {
  provider: string
  model: string
  reasoningEffort?: string
}): Record<string, unknown> {
  return {
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
  }
}

function makeSessionId(): string {
  return `session-${randomUUID()}`
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n')
}

function mapFinish(reason: any): { reason: ChatTurnEndReason; message?: string } | undefined {
  const kind = reason && typeof reason === 'object' ? reason.kind : undefined
  if (kind === 'stop') return { reason: 'completed' }
  if (kind === 'max-tokens') return { reason: 'max-tokens', message: '回答达到输出上限。' }
  if (kind === 'aborted') {
    return { reason: 'aborted', message: failureMessage(reason.failure) ?? '本轮已停止。' }
  }
  if (kind === 'error') {
    return { reason: 'error', message: failureMessage(reason.failure) ?? '模型请求失败。' }
  }
  // `tool-calls` is not a terminal turn: tool execution continues.
  return undefined
}

function failureMessage(failure: any): string | undefined {
  if (!failure || typeof failure !== 'object') return undefined
  return typeof failure.message === 'string' && failure.message.trim() ? failure.message.trim() : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
