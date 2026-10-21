/**
 * Subagent-backed tutor chat.
 *
 * The account model route cannot authenticate a root Agent created through
 * `ctx.agents.create` in this DSH build, but it does authenticate continuable
 * subagents created by the `spawn` provider under a live parent session. This
 * backend therefore:
 *   - resolves the current live root Agent as the parent,
 *   - starts the book tutor with `subagents.startActivation({ provider: 'spawn' })`,
 *   - sends later turns with `subagents.sendMessage`,
 *   - follows the child session for streaming,
 *   - reads history from the child Session.
 *
 * It intentionally touches only documented Host services and is structurally
 * typed so the plugin keeps no runtime dependency on DSH core packages.
 */

import { randomUUID } from 'node:crypto'
import { join, resolve as resolvePath } from 'node:path'
import type { DataPaths } from '../config.js'
import type { Book } from '../types.js'
import { ensureDir, randomId, readJsonFile, writeJsonAtomic } from '../store/atomic.js'
import {
  ChatError,
  type AgentRuntimeEvent,
  type ChatAgentMode,
  type ChatMessage,
  type ChatProbeResult,
  type ChatToolCall,
} from './types.js'
import type { AgentBackend, AgentConnection } from './service.js'
import { extractCitations, stripContextHeader, TEXTBOOK_TOOL_NAMES } from './prompt.js'
import { summarizeToolArgs, summarizeToolResult } from './tool-summary.js'
import { applyToolCall } from './tool-calls.js'

const PRIMER = '[[tbr-primer]] 只回复 READY，不要调用任何工具。'
const PRIMER_MARK = '[[tbr-primer]]'
const TUTOR_MARK = '【教材伴读模式】'
const TUTOR_PREFIX =
  '【教材伴读模式】你只使用 textbook_* 工具核对教材；禁止使用 bash、文件、网络或代码执行工具。每个事实后给出真实页码引用；先给结论再解释，回答保持简洁。\n\n'

interface ModelSelectionLike {
  provider?: string
  model?: string
  reasoningEffort?: string
}

interface ToolRestrictionLike {
  schemas?(): Array<{ name: string }>
  restrict?(filter: { allow?: readonly string[]; deny?: readonly string[] }): unknown
}

interface AgentLike {
  readonly id: string
  status?: string
  ctx?: { tools?: ToolRestrictionLike }
  session?: { header?: { cwd?: string } }
}

interface AgentsLike {
  get(id: string): AgentLike | undefined
  roots?(): AgentLike[]
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

interface SubagentActivationLike {
  readonly childId: string
  readonly messageId?: string
  readonly result: Promise<{ output?: unknown; stopReason?: string }>
  dispose(): Promise<void> | void
}

interface SubagentsLike {
  startActivation(spec: Record<string, unknown>): Promise<SubagentActivationLike>
  sendMessage(sender: AgentLike, targetId: string, content: unknown[], options: { signal: AbortSignal }): Promise<string>
  interrupt(targetId: string, authority: unknown): void
}

interface SessionInspectionLike {
  readonly events?: ReadonlyArray<{ readonly type?: string; readonly seq?: number; readonly data?: any }>
  readonly inheritedEventCount?: number
  readonly meta?: { readonly parentSession?: string }
}

interface SessionControllerLike {
  inspect?(sessionId: string, signal?: AbortSignal): Promise<SessionInspectionLike | undefined>
  follow?(request: Record<string, unknown>, signal: AbortSignal): AsyncIterable<any>
  create?(request: Record<string, unknown>): Promise<{ readonly sessionId?: string } | undefined>
  resolveAgent?(sessionId: string): Promise<{ readonly agent?: AgentLike; readonly error?: unknown } | undefined>
  rename?(request: Record<string, unknown>): Promise<unknown>
}

/**
 * The tiny slice of `workspaceRegistry` this backend needs. A tutor Session
 * lives in a dedicated Workspace, so DSH groups it under one sidebar entry
 * instead of dropping every book into "未分组".
 */
interface WorkspaceLike {
  readonly id?: string
  readonly path?: string
  readonly sessionIds?: readonly string[]
  attachSession?(sessionId: string): Promise<void>
}

interface WorkspaceRegistryLike {
  create?(path: string, title: string): Promise<WorkspaceLike | undefined>
  get?(id: string): WorkspaceLike | undefined
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
}

interface StoredSessionHeaderLike {
  readonly id?: string
  readonly cwd?: string
}

interface SessionPersistenceLike {
  list?(options?: { signal?: AbortSignal }): Promise<ReadonlyArray<{ header?: StoredSessionHeaderLike }>>
}

interface HostContextLike {
  get?(name: string): any
}

export interface SubagentChatBackendOptions {
  ctx: HostContextLike
  paths: DataPaths
  getModel?: () => ModelSelectionLike | undefined
  agentPreset?: string
  logger?: { warn?: (message: string) => void }
}

interface ConnectionOptions {
  parent: AgentLike
  parentSessionId: string
  childId: string
  agents: AgentsLike
  sessions: SessionsLike
  subagents: SubagentsLike
  controller: SessionControllerLike | undefined
  model: { provider: string; model: string; reasoningEffort?: string }
  label: string
  agentPreset?: string
  workspace?: WorkspaceLike
  exists: boolean
  logger: { warn?: (message: string) => void }
}

export class SubagentChatBackend implements AgentBackend {
  private readonly ctx: HostContextLike
  private readonly paths: DataPaths
  private readonly getModel: () => ModelSelectionLike | undefined
  private readonly agentPreset: string | undefined
  private readonly logger: { warn?: (message: string) => void }
  private workspaceReady:
    | Promise<{ id?: string; path: string; workspace?: WorkspaceLike } | undefined>
    | undefined

  constructor(options: SubagentChatBackendOptions) {
    this.ctx = options.ctx
    this.paths = options.paths
    this.getModel = options.getModel ?? (() => resolveDefaultModel(this.ctx))
    this.agentPreset = options.agentPreset
    this.logger = options.logger ?? {}
  }

  /** `<data root>/workspace`; tutor sessions are grouped here, not in "未分组". */
  private tutorWorkspacePath(): string | undefined {
    const root = this.paths?.root
    return typeof root === 'string' && root.trim() ? join(root, 'workspace') : undefined
  }

  /**
   * Register (or reuse) the dedicated tutor Workspace. DSH groups Sessions by
   * their stored cwd; without a registered Workspace for that cwd they all
   * land in the sidebar's "未分组" bucket.
   */
  async ensureWorkspace(
    registry?: unknown,
  ): Promise<{ id?: string; path: string; workspace?: WorkspaceLike } | undefined> {
    if (this.workspaceReady) return this.workspaceReady
    this.workspaceReady = (async () => {
      const path = this.tutorWorkspacePath()
      if (!path) return undefined
      try {
        await ensureDir(path, 0o700)
      } catch (error) {
        this.logger.warn?.(
          `[dsh-textbook-reader] tutor workspace directory failed: ${describeError(error)}`,
        )
        return undefined
      }
      const service = (registry && typeof registry === 'object'
        ? registry
        : this.workspaceRegistry()) as WorkspaceRegistryLike | undefined
      if (typeof service?.create !== 'function') return { path }
      try {
        const workspace = await service.create(path, '教材伴读')
        if (workspace) await this.attachWorkspaceSessions(workspace)
        return {
          ...(typeof workspace?.id === 'string' && workspace.id ? { id: workspace.id } : {}),
          path: typeof workspace?.path === 'string' && workspace.path ? workspace.path : path,
          ...(workspace ? { workspace } : {}),
        }
      } catch (error) {
        // Registration is cosmetic: chat still works with the cwd fallback.
        this.logger.warn?.(
          `[dsh-textbook-reader] tutor workspace registration failed: ${describeError(error)}`,
        )
        return { path }
      }
    })()
    return this.workspaceReady
  }

  /**
   * Attach Sessions already stamped with this cwd to the Workspace. DSH's
   * registry bootstraps membership only on a fresh install; Sessions moved in
   * later (or created by a subagent) need an explicit attach or they stay in
   * the "未分组" bucket even though their cwd matches.
   */
  private async attachWorkspaceSessions(workspace: WorkspaceLike): Promise<void> {
    if (!workspace.attachSession || typeof workspace.path !== 'string') return
    const persistence = this.sessionPersistence()
    if (!persistence?.list) return
    let snapshots: ReadonlyArray<{ header?: StoredSessionHeaderLike }>
    try {
      snapshots = await persistence.list()
    } catch (error) {
      this.logger.warn?.(
        `[dsh-textbook-reader] tutor workspace session scan failed: ${describeError(error)}`,
      )
      return
    }
    const known = new Set(workspace.sessionIds ?? [])
    for (const snapshot of snapshots) {
      const header = snapshot?.header
      if (!header || typeof header.id !== 'string' || !header.id) continue
      if (known.has(header.id)) continue
      if (header.cwd !== workspace.path) continue
      try {
        await workspace.attachSession(header.id)
        known.add(header.id)
      } catch (error) {
        this.logger.warn?.(
          `[dsh-textbook-reader] tutor workspace attach failed for ${header.id}: ${describeError(error)}`,
        )
      }
    }
  }

  private sessionPersistence(): SessionPersistenceLike | undefined {
    try {
      const value = this.ctx.get?.('sessionPersistence')
      return value && typeof value === 'object' ? (value as SessionPersistenceLike) : undefined
    } catch {
      return undefined
    }
  }

  private workspaceRegistry(): WorkspaceRegistryLike | undefined {
    try {
      const value = this.ctx.get?.('workspaceRegistry')
      return value && typeof value === 'object' ? (value as WorkspaceRegistryLike) : undefined
    } catch {
      return undefined
    }
  }

  describe(): { available: boolean; model?: { provider: string; model: string } } {
    const agents = this.agents()
    const model = this.model()
    return {
      available: Boolean(agents && this.subagents()),
      ...(model ? { model: { provider: model.provider, model: model.model } } : {}),
    }
  }

  listRoots(): Array<{ id: string; status?: string }> {
    const agents = this.agents()
    if (!agents?.roots) return []
    return agents.roots().map((agent) => ({
      id: agent.id,
      ...(agent.status ? { status: agent.status } : {}),
    }))
  }

  async history(sessionId: string): Promise<ChatMessage[]> {
    const controller = this.controller()
    if (!controller?.inspect) return []
    try {
      const inspection = await controller.inspect(sessionId)
      const inherited = Number(inspection?.inheritedEventCount ?? 0)
      const own = (inspection?.events ?? []).filter((event) => Number(event.seq ?? 0) >= inherited)
      return deriveHistoryFromEvents(own)
    } catch (error) {
      this.logger.warn?.(`[dsh-textbook-reader] legacy chat history read failed: ${describeError(error)}`)
      return []
    }
  }

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
          ...(cause ? { cause: cause instanceof Error ? cause.stack ?? cause.message : String(cause) } : {}),
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async open(input: {
    book: Book
    sessionId?: string
    mode?: ChatAgentMode
    parentSessionId?: string
  }): Promise<{ connection: AgentConnection; sessionId: string; created: boolean }> {
    const agents = this.agents()
    const subagents = this.subagents()
    if (!agents || !subagents) {
      throw new ChatError(
        'chat_unavailable',
        '当前 DSH 环境没有提供 subagent 服务。',
        '确认 DSH 版本与插件版本匹配后重启。',
      )
    }
    const model = this.model()
    if (!model) {
      throw new ChatError('model_missing', '尚未选择可用的对话模型。', '在 DSH 设置中选择默认模型后重试。')
    }
    const controller = this.controller()
    const parent = await this.ensureTutorParent(agents, controller, input.parentSessionId)
    if (!parent) {
      throw new ChatError(
        'parent_missing',
        '没有可用的父会话。',
        '先在 DSH 里打开或新建一个对话，再打开教材伴读聊天。',
      )
    }
    const workspace = (await this.ensureWorkspace())?.workspace
    if (workspace) await this.attachWorkspaceSessions(workspace)

    let childId = input.sessionId && isSessionId(input.sessionId) ? input.sessionId : makeSessionId()
    let exists = input.sessionId ? await this.childExists(childId) : false
    if (exists) {
      const owner = await this.childOwner(childId, controller)
      if (owner && owner !== parent.id) {
        // The stored child belonged to another parent (for example the
        // development session or a tutor parent that is gone). Retire it
        // instead of leaving an orphaned duplicate in the sidebar.
        await this.archiveSession(childId)
        childId = makeSessionId()
        exists = false
      }
    }
    const connection = new SubagentConnection({
      parent,
      parentSessionId: parent.id,
      childId,
      agents,
      sessions: this.sessions() ?? { get: () => undefined },
      subagents,
      controller,
      model,
      label: `教材伴读 · ${input.book.title}`,
      ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}),
      ...(workspace ? { workspace } : {}),
      exists,
      logger: this.logger,
    })
    await connection.start()
    return { connection, sessionId: childId, created: !exists }
  }

  private agents(): AgentsLike | undefined {
    const value = this.ctx.get?.('agents')
    return value && typeof value.get === 'function' ? (value as AgentsLike) : undefined
  }

  private subagents(): SubagentsLike | undefined {
    const value = this.ctx.get?.('subagents')
    return value && typeof value.startActivation === 'function' && typeof value.sendMessage === 'function'
      ? (value as SubagentsLike)
      : undefined
  }

  private sessions(): SessionsLike | undefined {
    const value = this.ctx.get?.('sessions')
    return value && typeof value.get === 'function' ? (value as SessionsLike) : undefined
  }

  private controller(): SessionControllerLike | undefined {
    const value = this.ctx.get?.('sessionController')
    return value && typeof value === 'object' ? (value as SessionControllerLike) : undefined
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

  private resolveParent(agents: AgentsLike, parentSessionId?: string): AgentLike | undefined {
    if (parentSessionId) {
      const exact = agents.get(parentSessionId)
      if (exact) return exact
    }
    const roots = agents.roots?.() ?? []
    return roots.find((agent) => agent.status === 'running') ?? roots[0]
  }

  private async ensureTutorParent(
    agents: AgentsLike,
    controller: SessionControllerLike | undefined,
    explicitParentId?: string,
  ): Promise<AgentLike | undefined> {
    if (explicitParentId) {
      const exact = agents.get(explicitParentId)
      if (exact) return exact
      const resumed = await this.resolveSessionAgent(controller, explicitParentId)
      if (resumed) return resumed
    }

    const workspace = await this.ensureWorkspace()
    let staleParent: AgentLike | undefined
    const stored = await this.readTutorSessionId()
    if (stored) {
      const live = agents.get(stored)
      const resumed = live ?? (await this.resolveSessionAgent(controller, stored))
      if (resumed) {
        // Sessions created by older builds live in the profile directory.
        // Children inherit the parent cwd, so reusing such a parent would put
        // every new book chat straight back into 未分组.
        const cwd = resumed.session?.header?.cwd
        if (!workspace?.path || !cwd || sameDirectory(cwd, workspace.path)) return resumed
        staleParent = resumed
        this.logger.warn?.(
          `[dsh-textbook-reader] tutor session ${stored} is outside the tutor workspace; creating a fresh parent`,
        )
      }
    }

    if (controller?.create) {
      const cwd = workspace?.path ?? this.tutorCwd()
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const created = await controller.create({
            // Prefer the registered Workspace so DSH groups the session and
            // its book children under one sidebar entry. `workspaceId` and
            // `cwd` are mutually exclusive in the session controller.
            ...(workspace?.id ? { workspaceId: workspace.id } : cwd ? { cwd } : {}),
            ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}),
          })
          const sessionId = created?.sessionId
          if (sessionId) {
            await this.writeTutorSession(sessionId).catch(() => {})
            const resumed = await this.resolveSessionAgent(controller, sessionId)
            if (resumed) {
              void Promise.resolve(controller.rename?.({ sessionId, title: '教材伴读导师' })).catch(() => {})
              return resumed
            }
          }
        } catch (error) {
          this.logger.warn?.(`[dsh-textbook-reader] tutor session create failed: ${describeError(error)}`)
          if (attempt === 0) await delay(200)
        }
      }
    }

    // Creating a grouped parent failed; keep the old parent working rather
    // than switching to an unrelated root session.
    if (staleParent) return staleParent

    const fallback = this.resolveParent(agents)
    if (fallback) {
      this.logger.warn?.(
        '[dsh-textbook-reader] dedicated tutor session unavailable; falling back to the current root session.',
      )
    }
    return fallback
  }

  private async resolveSessionAgent(
    controller: SessionControllerLike | undefined,
    sessionId: string,
  ): Promise<AgentLike | undefined> {
    if (!controller?.resolveAgent) return undefined
    try {
      const resolved = await controller.resolveAgent(sessionId)
      return resolved?.agent
    } catch (error) {
      this.logger.warn?.(`[dsh-textbook-reader] tutor session resume failed: ${describeError(error)}`)
      return undefined
    }
  }

  private tutorCwd(): string | undefined {
    const workingDirectory = this.ctx.get?.('workingDirectory') as
      | { defaultDirectory?: unknown }
      | undefined
    const value = workingDirectory?.defaultDirectory
    return typeof value === 'string' && value.startsWith('/') ? value : undefined
  }

  private tutorFile(): string {
    return join(this.paths.root, 'tutor-session.json')
  }

  private async readTutorSessionId(): Promise<string | undefined> {
    try {
      const record = await readJsonFile<{ sessionId?: unknown }>(this.tutorFile())
      return typeof record?.sessionId === 'string' && !record.sessionId.startsWith('tbr-')
        ? record.sessionId
        : undefined
    } catch {
      return undefined
    }
  }

  private async writeTutorSession(sessionId: string): Promise<void> {
    await writeJsonAtomic(this.tutorFile(), {
      version: 1,
      sessionId,
      title: '教材伴读导师',
      createdAt: new Date().toISOString(),
    })
  }

  /** Best effort: hide a replaced child from the sidebar without deleting its log. */
  private async archiveSession(sessionId: string): Promise<void> {
    const registry = this.workspaceRegistry()
    if (!registry?.archiveSession) return
    try {
      await registry.archiveSession(sessionId)
    } catch (error) {
      this.logger.warn?.(
        `[dsh-textbook-reader] replaced chat session archive failed: ${describeError(error)}`,
      )
    }
  }

  private async childOwner(
    childId: string,
    controller: SessionControllerLike | undefined,
  ): Promise<string | undefined> {
    if (!controller?.inspect) return undefined
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 2_000)
    try {
      const inspection = await controller.inspect(childId, abort.signal)
      return typeof inspection?.meta?.parentSession === 'string'
        ? inspection.meta.parentSession
        : undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  private async childExists(childId: string): Promise<boolean> {
    const sessions = this.sessions()
    if (sessions?.get(childId)) return true
    const controller = this.controller()
    if (!controller?.inspect) return false
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 2_000)
    try {
      await controller.inspect(childId, abort.signal)
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}

class SubagentConnection implements AgentConnection {
  readonly sessionId: string
  private readonly parent: AgentLike
  private readonly parentSessionId: string
  private readonly agents: AgentsLike
  private readonly sessions: SessionsLike
  private readonly subagents: SubagentsLike
  private readonly controller: SessionControllerLike | undefined
  private readonly model: { provider: string; model: string; reasoningEffort?: string }
  private readonly label: string
  private readonly agentPreset: string | undefined
  private readonly workspace: WorkspaceLike | undefined
  private readonly logger: { warn?: (message: string) => void }
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>()
  private readonly abort = new AbortController()
  private readonly knownPrompts: string[] = []
  private historyCache: ChatMessage[] = []
  private readonly toolNames = new Map<string, string>()
  private readonly streamedTools = new Set<string>()
  private activation: SubagentActivationLike | undefined
  private started: boolean
  private running = false
  private disposed = false
  private armed = false
  private followStarted = false
  private sawTurnEnd = false
  private sawDelta = false

  constructor(options: ConnectionOptions) {
    this.sessionId = options.childId
    this.parent = options.parent
    this.parentSessionId = options.parentSessionId
    this.agents = options.agents
    this.sessions = options.sessions
    this.subagents = options.subagents
    this.controller = options.controller
    this.model = options.model
    this.label = options.label
    this.agentPreset = options.agentPreset
    this.workspace = options.workspace
    this.logger = options.logger
    this.started = options.exists
  }

  async start(): Promise<void> {
    if (this.started) {
      // A continuable child is cold between turns; the live session store is
      // empty then, so read the persisted child log before serving history.
      await this.loadHistory()
      // Resumed continuable children keep their old tool surface; re-apply the
      // tutor restriction when the chat reopens.
      this.restrictTools(this.sessionId)
      this.attachWorkspaceChild(this.sessionId)
      this.renameChild()
      void this.pumpFollow()
    }
  }

  async send(prompt: string): Promise<void> {
    if (this.disposed) throw new ChatError('chat_unavailable', '会话已关闭。')
    this.knownPrompts.push(prompt)
    const childPrompt = `${TUTOR_PREFIX}${prompt}`
    try {
      if (!this.started) {
        await this.startActivation(childPrompt)
        return
      }
      try {
        await this.subagents.sendMessage(this.parent, this.sessionId, [{ type: 'text', text: childPrompt }], {
          signal: this.abort.signal,
        })
      } catch (error) {
        // A cold or missing child can be re-created with the same id.
        if (!this.activation) {
          await this.startActivation(childPrompt)
          return
        }
        throw error
      }
    } catch (error) {
      if (error instanceof ChatError) throw error
      throw new ChatError('send_failed', `消息发送失败：${describeError(error)}`)
    }
  }

  cancel(): void {
    try {
      this.subagents.interrupt(this.sessionId, { kind: 'ancestor', agent: this.parent })
    } catch (error) {
      this.logger.warn?.(`[dsh-textbook-reader] subagent interrupt failed: ${describeError(error)}`)
    }
  }

  history(limit = 50): ChatMessage[] {
    if (this.historyCache.length > 0) return this.historyCache.slice(-Math.max(1, limit))
    const session = this.sessions.get(this.sessionId)
    const messages = session?.deriveMessages?.() ?? []
    return deriveHistoryFromMessages(messages).slice(-Math.max(1, limit))
  }

  /** Read the child's own persisted events, skipping the seeded parent prefix. */
  private async loadHistory(): Promise<void> {
    try {
      const inspection = await this.controller?.inspect?.(this.sessionId, this.abort.signal)
      const events = inspection?.events
      if (events && events.length > 0) {
        const inherited = Number(inspection?.inheritedEventCount ?? 0)
        const own = events.filter((event) => Number(event.seq ?? 0) >= inherited)
        this.historyCache = deriveHistoryFromEvents(own)
        if (this.historyCache.length > 0) return
      }
    } catch (error) {
      this.logger.warn?.(`[dsh-textbook-reader] chat history read failed: ${describeError(error)}`)
    }
    const session = this.sessions.get(this.sessionId)
    const next = deriveHistoryFromMessages(session?.deriveMessages?.() ?? [])
    if (next.length > 0 || this.historyCache.length === 0) this.historyCache = next
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.abort.abort()
    this.listeners.clear()
    const activation = this.activation
    this.activation = undefined
    if (activation) await Promise.resolve(activation.dispose()).catch(() => {})
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

  private async startActivation(firstPrompt: string): Promise<void> {
    this.sawTurnEnd = false
    this.sawDelta = false
    const request = {
      parent: this.parent,
      prompt: [{ type: 'text' as const, text: firstPrompt }],
      agentOptions: {
        provider: this.model.provider,
        model: this.model.model,
        ...(this.model.reasoningEffort ? { reasoningEffort: this.model.reasoningEffort } : {}),
      },
    }
    const candidates: Array<{ delivery: 'caller' | 'parent'; preset?: string }> = [
      { delivery: 'caller', ...(this.agentPreset ? { preset: this.agentPreset } : {}) },
      { delivery: 'parent', ...(this.agentPreset ? { preset: this.agentPreset } : {}) },
    ]
    if (this.agentPreset) candidates.push({ delivery: 'caller' })

    let activation: SubagentActivationLike | undefined
    let lastError: unknown
    for (const candidate of candidates) {
      try {
        activation = await this.subagents.startActivation({
          provider: 'spawn',
          label: this.label,
          childId: this.sessionId,
          request: {
            ...request,
            ...(candidate.preset ? { agentPreset: candidate.preset } : {}),
          },
          signal: this.abort.signal,
          delivery: candidate.delivery,
        })
        break
      } catch (error) {
        lastError = error
        this.logger.warn?.(
          `[dsh-textbook-reader] subagent start rejected (${candidate.delivery}${candidate.preset ? `, preset ${candidate.preset}` : ', no preset'}): ${describeError(error)}`,
        )
      }
    }
    if (!activation) throw lastError ?? new ChatError('chat_open_failed', '无法启动伴读子会话。')
    this.activation = activation
    this.started = true
    this.restrictTools(activation.childId)
    this.attachWorkspaceChild(activation.childId)
    this.renameChild()
    void activation.result.then((result) => this.finishFromActivation(result)).catch(() => {})
    this.armPrompt(firstPrompt)
    void this.pumpFollow()
  }

  /** Give a book child a stable, readable sidebar title instead of its first prompt. */
  private renameChild(): void {
    if (!this.controller?.rename) return
    void Promise.resolve(this.controller.rename({ sessionId: this.sessionId, title: this.label })).catch(
      () => {},
    )
  }

  /** Deregistered subagent children inherit cwd but not Workspace membership. */
  private attachWorkspaceChild(childId: string): void {
    if (!this.workspace?.attachSession) return
    void Promise.resolve(this.workspace.attachSession(childId)).catch((error: unknown) => {
      this.logger.warn?.(
        `[dsh-textbook-reader] tutor workspace child attach failed: ${describeError(error)}`,
      )
    })
  }

  /** Best effort: the spawn provider ignores agentPreset in some builds, so
   * restrict the live child's global tool surface to the textbook set. */
  private restrictTools(childId: string, attempt = 0): void {
    if (this.disposed) return
    const child = this.agents.get(childId)
    const tools = child?.ctx?.tools
    if (!tools?.restrict || !tools.schemas) {
      if (attempt < 6) setTimeout(() => this.restrictTools(childId, attempt + 1), 40)
      return
    }
    try {
      const available = new Set(tools.schemas().map((tool) => tool.name))
      const allow = TEXTBOOK_TOOL_NAMES.filter((name) => available.has(name))
      if (available.has('send_message')) allow.push('send_message')
      if (allow.length > 0) tools.restrict({ allow })
    } catch (error) {
      this.logger.warn?.(`[dsh-textbook-reader] tutor tool restriction failed: ${describeError(error)}`)
    }
  }

  /** First-turn fallback when the follow stream missed the whole turn. */
  private finishFromActivation(result: { output?: unknown } | undefined): void {
    if (this.sawTurnEnd || this.sawDelta) return
    const text = extractText(result?.output).trim()
    if (!text) return
    this.sawTurnEnd = true
    this.emit({ type: 'start', turn: 1, step: 1 })
    this.emit({ type: 'delta', text })
    this.emit({ type: 'finish', reason: 'completed' })
    this.emit({ type: 'end' })
    void this.loadHistory()
  }

  private armPrompt(prompt: string): void {
    this.armed = true
    this.knownPrompts.push(prompt)
  }

  private async pumpFollow(): Promise<void> {
    if (this.followStarted || !this.controller?.follow) return
    this.followStarted = true
    const request = {
      address: {
        kind: 'subagent',
        parentSessionId: this.parentSessionId,
        childSessionId: this.sessionId,
        mode: 'continuable',
      },
      assistantStream: true,
    }
    try {
      for await (const frame of this.controller.follow(request, this.abort.signal)) {
        if (this.disposed) return
        this.handleFollowFrame(frame)
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.emit({ type: 'error', code: 'stream_failed', message: `会话流中断：${describeError(error)}` })
      }
    }
  }

  private handleFollowFrame(frame: any): void {
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'assistant-stream') {
      this.handleAssistantFrame(frame.frame)
      return
    }
    if (frame.type !== 'event') return
    const event = frame.event
    if (!event || typeof event !== 'object') return
    if (event.type === 'user/message') {
      const text = extractText(event.data?.content)
      if (text) this.handleUserMessage(text)
      return
    }
    if (event.type === 'tool/call') {
      const name = String(event.data?.name ?? 'tool')
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
      if (callId) this.toolNames.set(callId, name)
      this.emitTool('start', name, callId || undefined, summarizeToolArgs(name, event.data?.arguments))
      return
    }
    if (event.type === 'tool/result') {
      const callId =
        typeof event.data?.message?.source?.callId === 'string' ? event.data.message.source.callId : ''
      const name = (callId && this.toolNames.get(callId)) || 'tool'
      const error = Boolean(event.data?.error) || Boolean(event.data?.message?.isError)
      const summary = summarizeToolResult(name, extractText(event.data?.message?.content), error)
      this.emitTool('end', name, callId || undefined, summary, error)
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      const kind = reason?.kind
      const failure = reason?.error
      this.running = false
      this.sawTurnEnd = true
      this.emit({
        type: 'finish',
        reason: kind === 'error' ? 'error' : kind === 'aborted' ? 'aborted' : kind === 'max-tokens' ? 'max-tokens' : 'completed',
        ...(failure?.message ? { message: String(failure.message) } : {}),
      })
      this.emit({ type: 'end' })
      this.armed = false
      void this.loadHistory()
    }
  }

  private handleUserMessage(text: string): void {
    if (text.includes(PRIMER_MARK)) return
    const match = this.knownPrompts.find((prompt) => text.includes(prompt))
    if (match) this.armed = true
  }

  private handleAssistantFrame(frame: any): void {
    if (!frame || typeof frame !== 'object') return
    if (!this.armed) return
    if (frame.type === 'start') {
      this.running = true
      this.emit({ type: 'start', turn: Number(frame.turn) || 0, step: Number(frame.step) || 0 })
      return
    }
    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (!chunk || typeof chunk !== 'object') return
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        this.sawDelta = true
        this.emit({ type: 'delta', text: chunk.text })
        return
      }
      if (chunk.type === 'tool-call-delta') {
        const name = typeof chunk.name === 'string' ? chunk.name : ''
        const callId = typeof chunk.id === 'string' ? chunk.id : ''
        if (name && callId && !this.streamedTools.has(callId)) {
          this.streamedTools.add(callId)
          this.toolNames.set(callId, name)
          this.emitTool('start', name, callId)
        }
        return
      }
      if (chunk.type === 'finish') {
        this.emitFinish(chunk.reason)
      }
      return
    }
    if (frame.type === 'end') {
      // One assistant attempt ends here, not the turn: the agent loop emits a
      // separate stream per step, including tool-call-only steps. Finalize on
      // the session `turn/end` event instead.
      this.running = false
    }
  }

  private emitFinish(reason: any): void {
    const kind = reason && typeof reason === 'object' ? reason.kind : undefined
    if (kind === 'stop') {
      this.emit({ type: 'finish', reason: 'completed' })
    } else if (kind === 'max-tokens') {
      this.emit({ type: 'finish', reason: 'max-tokens', message: '回答达到输出上限。' })
    } else if (kind === 'aborted' || kind === 'error') {
      const message = failureMessage(reason.failure) ?? (kind === 'aborted' ? '本轮已停止。' : '模型请求失败。')
      this.emit({ type: 'finish', reason: kind === 'aborted' ? 'aborted' : 'error', message })
    }
  }

  private emitTool(
    status: 'start' | 'end',
    name: string,
    callId?: string,
    summary?: string,
    error?: boolean,
  ): void {
    this.emit({
      type: 'tool',
      status,
      name,
      ...(callId ? { callId } : {}),
      ...(summary ? { summary } : {}),
      ...(error ? { error: true } : {}),
    })
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

function makeSessionId(): string {
  return `session-${randomUUID()}`
}

function isSessionId(value: string): boolean {
  return /^session-[A-Za-z0-9-]+$/.test(value)
}

function stripTutorPrefix(text: string): string {
  const index = text.indexOf(TUTOR_MARK)
  if (index < 0) return text
  const rest = text.slice(index + TUTOR_MARK.length)
  const newline = rest.indexOf('\n')
  return newline >= 0 ? rest.slice(newline + 1).trim() : rest.trim()
}

function deriveHistoryFromEvents(
  events: ReadonlyArray<{ readonly type?: string; readonly data?: any }>,
): ChatMessage[] {
  const out: ChatMessage[] = []
  const toolNames = new Map<string, string>()
  let turn: { user?: string; answer: string; tools: ChatToolCall[] } | undefined
  const flush = (): void => {
    if (turn?.user) {
      out.push({ id: randomId('hist'), role: 'user', text: turn.user })
      const text = turn.answer.trim()
      // Keep a tool-only turn (aborted before answering) so its call summary
      // survives a transcript rebuild.
      if (text || turn.tools.length > 0) {
        const citations = extractCitations(text)
        out.push({
          id: randomId('hist'),
          role: 'assistant',
          text,
          ...(citations.length ? { citations } : {}),
          ...(turn.tools.length ? { toolCalls: turn.tools } : {}),
        })
      }
    }
    turn = undefined
  }
  for (const event of events) {
    if (event.type === 'turn/start') {
      flush()
      turn = { answer: '', tools: [] }
      continue
    }
    if (event.type === 'user/message') {
      const text = tutorUserText(extractText(event.data?.content))
      if (text) {
        if (!turn) turn = { answer: '', tools: [] }
        // The tutor prompt is the turn's question; runtime-context user
        // messages in the same turn are ignored.
        if (!turn.user) turn.user = text
      }
      continue
    }
    if (event.type === 'tool/call') {
      if (!turn) turn = { answer: '', tools: [] }
      const name = String(event.data?.name ?? 'tool')
      const callId =
        typeof event.data?.callId === 'string' && event.data.callId ? event.data.callId : undefined
      if (callId) toolNames.set(callId, name)
      turn.tools = applyToolCall(turn.tools, {
        status: 'start',
        name,
        ...(callId ? { callId } : {}),
        summary: summarizeToolArgs(name, event.data?.arguments),
      })
      continue
    }
    if (event.type === 'tool/result') {
      if (!turn) continue
      const callId =
        typeof event.data?.message?.source?.callId === 'string'
          ? event.data.message.source.callId
          : undefined
      const name = (callId && toolNames.get(callId)) || 'tool'
      const error = Boolean(event.data?.error) || Boolean(event.data?.message?.isError)
      turn.tools = applyToolCall(turn.tools, {
        status: 'end',
        name,
        ...(callId ? { callId } : {}),
        summary: summarizeToolResult(name, extractText(event.data?.message?.content), error),
        ...(error ? { error: true } : {}),
      })
      continue
    }
    if (event.type === 'assistant/message') {
      if (!turn?.user) continue
      const text = extractText(event.data?.message?.content).trim()
      if (text) turn.answer = text
      continue
    }
    if (event.type === 'turn/end') {
      flush()
    }
  }
  flush()
  return out
}

/**
 * Keep only the book-chat turns: a tutor-marked user prompt followed by the
 * child's final assistant text. Seeded parent messages and runtime-context
 * injections have no tutor mark and are dropped.
 */
function tutorUserText(raw: string): string | undefined {
  if (raw.includes(PRIMER_MARK)) return undefined
  if (raw.includes(TUTOR_MARK)) {
    const text = stripContextHeader(stripTutorPrefix(raw)).trim()
    return text || undefined
  }
  const sent = raw.indexOf('sent a message:')
  if (sent >= 0) {
    const text = stripContextHeader(raw.slice(sent + 'sent a message:'.length)).trim()
    return text || undefined
  }
  if (raw.includes('<reading-context>') || raw.includes('用户问题：')) {
    const text = stripContextHeader(raw).trim()
    return text || undefined
  }
  const trimmed = raw.trim()
  if (
    /^(Current runtime context\.|Time sampled|Approval prompts|You are a delegated subagent|Your permission scope|<system-reminder>|<available_skills>)/.test(
      trimmed,
    )
  ) {
    return undefined
  }
  const text = stripContextHeader(raw).trim()
  return text || undefined
}

function deriveHistoryFromMessages(
  messages: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>,
): ChatMessage[] {
  const out: ChatMessage[] = []
  let pendingUser: ChatMessage | undefined
  let answer = ''
  const flush = (): void => {
    if (pendingUser) out.push(pendingUser)
    const text = answer.trim()
    if (text) {
      const citations = extractCitations(text)
      out.push({
        id: randomId('hist'),
        role: 'assistant',
        text,
        ...(citations.length ? { citations } : {}),
      })
    }
    pendingUser = undefined
    answer = ''
  }
  for (const message of messages) {
    if (message.role === 'user') {
      const text = tutorUserText(extractText(message.content))
      if (!text) continue
      flush()
      pendingUser = { id: randomId('hist'), role: 'user', text }
      continue
    }
    if (message.role === 'assistant' && pendingUser) {
      const text = extractText(message.content).trim()
      if (text) answer = text
    }
  }
  flush()
  return out
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

function failureMessage(failure: any): string | undefined {
  if (!failure || typeof failure !== 'object') return undefined
  return typeof failure.message === 'string' && failure.message.trim() ? failure.message.trim() : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sameDirectory(left: string, right: string): boolean {
  return resolvePath(left) === resolvePath(right)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
