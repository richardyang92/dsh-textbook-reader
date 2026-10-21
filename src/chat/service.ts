/**
 * Per-book chat service.
 *
 * One book owns one DSH Agent session. This service owns the low-level Agent
 * connection through a small backend interface, so the bridge can be tested
 * without a running DSH host. It also persists the session id and reading
 * position, and fans streamed Agent events out to SSE subscribers.
 */

import type { DataPaths } from '../config.js'
import type { Book } from '../types.js'
import { randomId } from '../store/atomic.js'
import type {
  AgentRuntimeEvent,
  ChatAgentMode,
  ChatContext,
  ChatEvent,
  ChatMessage,
  ChatProbeResult,
  ChatStatus,
  ChatToolCall,
  ChatTurnEndReason,
} from './types.js'
import { ChatError } from './types.js'
import { buildAgentPrompt, extractCitations } from './prompt.js'
import { applyToolCall } from './tool-calls.js'
import {
  ChatStore,
  type ChatHistoryEntry,
  type ChatHistoryRecord,
  type ReadingState,
} from './store.js'

const MAX_HISTORY = 50
const MAX_QUESTION = 8000
const MAX_SELECTION = 2000

export interface AgentConnection {
  readonly sessionId: string
  send(prompt: string): Promise<void> | void
  cancel(): void
  history(limit?: number): ChatMessage[]
  dispose(): Promise<void>
  onEvent(listener: (event: AgentRuntimeEvent) => void): () => void
  isRunning(): boolean
}

export interface AgentBackend {
  open(input: { book: Book; sessionId?: string; mode?: ChatAgentMode; parentSessionId?: string }): Promise<{
    connection: AgentConnection
    sessionId: string
    created: boolean
  }>
  describe?(): { available: boolean; model?: { provider: string; model: string } }
  /** Read a legacy child session's durable book-chat history for migration. */
  history?(sessionId: string): Promise<ChatMessage[]>
  /** Optional direct model probe; the C0 spike uses it to expose transport causes. */
  probe?(sessionId?: string, mode?: 'stream' | 'prepare'): Promise<ChatProbeResult>
  /** Live root agents, excluding this service's own book chats. */
  listRoots?(): Array<{ id: string; status?: string }>
}

export interface BookChatLogger {
  warn?: (message: string) => void
}

export interface BookChatServiceOptions {
  paths: DataPaths
  backend: AgentBackend
  logger?: BookChatLogger
}

interface Entry {
  book: Book
  sessionId: string
  conversationId: string
  title: string
  titleDraft: boolean
  connection: AgentConnection
  messages: ChatMessage[]
  /** Tool calls of the turn currently being produced (persisted on its answer). */
  tools: ChatToolCall[]
  created: boolean
  listeners: Set<(event: ChatEvent) => void>
  pending: string
  finishReason?: ChatTurnEndReason
  finishMessage?: string
  running: boolean
  unsubscribe: () => void
  persisting: Promise<void>
}

export interface ChatConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  active: boolean
}

export class BookChatService {
  private readonly store: ChatStore
  private readonly backend: AgentBackend
  private readonly logger: BookChatLogger
  private readonly entries = new Map<string, Entry>()
  private readonly opening = new Map<string, Promise<Entry>>()

  constructor(options: BookChatServiceOptions) {
    this.store = new ChatStore(options.paths)
    this.backend = options.backend
    this.logger = options.logger ?? {}
  }

  /** Ensure the book has a live Agent session and return its snapshot. */
  async ensure(
    book: Book,
    options: { mode?: ChatAgentMode; parentSessionId?: string } = {},
  ): Promise<{ sessionId: string; messages: ChatMessage[]; created: boolean }> {
    const entry = await this.ensureEntry(book, options)
    return {
      sessionId: entry.sessionId,
      messages: this.historyOf(entry),
      created: false,
    }
  }

  /** Subscribe to snapshots and live events; returns an unsubscribe function. */
  async subscribe(book: Book, listener: (event: ChatEvent) => void): Promise<() => void> {
    const entry = await this.ensureEntry(book)
    entry.listeners.add(listener)
    try {
      listener({ type: 'snapshot', sessionId: entry.sessionId, messages: this.historyOf(entry) })
    } catch {
      entry.listeners.delete(listener)
      throw new ChatError('chat_subscribe_failed', '聊天连接已关闭。')
    }
    return () => {
      entry.listeners.delete(listener)
    }
  }

  /** Send one user question with the current reading context. */
  async send(
    book: Book,
    text: string,
    context: ChatContext,
    options: { raw?: boolean } = {},
  ): Promise<{ accepted: true; sessionId: string }> {
    const display = String(text ?? '').trim().slice(0, MAX_QUESTION)
    if (!display) throw new ChatError('empty_message', '消息不能为空。')
    const entry = await this.ensureEntry(book)
    const prior = entry.created ? entry.messages.slice(-6) : []
    const prompt = options.raw ? display : buildAgentPrompt(display, context, prior)
    const message: ChatMessage = {
      id: randomId('msg'),
      role: 'user',
      text: display,
      createdAt: new Date().toISOString(),
    }
    entry.messages = [...entry.messages, message].slice(-200)
    entry.tools = []
    if (entry.titleDraft) {
      entry.title = titleFromText(display)
      entry.titleDraft = false
    }
    this.persistMessages(entry)
    this.emit(entry, { type: 'user', message })
    try {
      await entry.connection.send(prompt)
      entry.created = false
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit(entry, { type: 'error', code: 'send_failed', message })
      throw error instanceof ChatError
        ? error
        : new ChatError('send_failed', `消息发送失败：${message}`, '确认当前模型可用后重试。')
    }
    return { accepted: true, sessionId: entry.sessionId }
  }

  async history(book: Book, limit = MAX_HISTORY): Promise<{ sessionId: string; messages: ChatMessage[] }> {
    const entry = await this.ensureEntry(book)
    return { sessionId: entry.sessionId, messages: this.historyOf(entry, limit) }
  }

  /** List every conversation of this book, newest active first. */
  async listSessions(
    book: Book,
  ): Promise<{ activeId: string; sessions: ChatConversationSummary[] }> {
    const entry = await this.ensureEntry(book)
    const history = await this.ensureHistory(book)
    const active = history.sessions.find((item) => item.id === history.activeId)
    let changed = false
    if (active) {
      if (active.sessionId !== entry.sessionId) {
        active.sessionId = entry.sessionId
        changed = true
      }
      if (active.messageCount !== entry.messages.length) {
        active.messageCount = entry.messages.length
        changed = true
      }
      if (active.title !== entry.title) {
        active.title = entry.title
        changed = true
      }
      if (changed) await this.store.writeHistory(book.id, history).catch(() => {})
    }
    const sessions = history.sessions.map((item) => ({
      id: item.id,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      messageCount: item.messageCount,
      active: item.id === history.activeId,
    }))
    sessions.sort((left, right) =>
      left.active === right.active
        ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        : left.active
          ? -1
          : 1,
    )
    return { activeId: history.activeId, sessions }
  }

  /** Switch the book to an older conversation without losing the current one. */
  async activate(
    book: Book,
    conversationId: string,
  ): Promise<{ sessionId: string; activeId: string; messages: ChatMessage[] }> {
    if (!conversationId) {
      throw new ChatError('chat_session_missing', '缺少要打开的对话。', '刷新对话记录后重试。')
    }
    const current = await this.ensureEntry(book)
    const history = await this.ensureHistory(book)
    const target = history.sessions.find((item) => item.id === conversationId)
    if (!target) {
      throw new ChatError('chat_session_missing', '找不到这个对话。', '刷新对话记录后重试。')
    }
    if (history.activeId === target.id && current.conversationId === target.id) {
      return { sessionId: current.sessionId, activeId: target.id, messages: this.historyOf(current) }
    }

    this.entries.delete(book.id)
    current.unsubscribe()
    await current.persisting.catch(() => {})
    await this.archiveAndDrop(book, history, current)
    current.listeners.clear()
    await current.connection.dispose().catch(() => {})

    const archived = await this.store
      .readArchivedTranscriptWithVersion(book.id, target.id)
      .catch(() => ({ version: 1, messages: [] as ChatMessage[] }))
    let messages = archived.messages
    let transcriptVersion = archived.version
    if (messages.length === 0) {
      const active = await this.store
        .readTranscriptWithVersion(book.id)
        .catch(() => ({ version: 1, messages: [] as ChatMessage[] }))
      messages = active.messages
      transcriptVersion = active.version
    }
    if (transcriptVersion < 2 && target.sessionId && messages.length > 0) {
      messages = await this.backfillToolCalls(target.sessionId, messages)
    }
    const now = new Date().toISOString()
    await this.store.writeTranscript(book.id, messages).catch(() => {})
    await this.store
      .writeSession(book.id, {
        version: 1,
        sessionId: target.sessionId,
        title: target.title,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt || now,
      })
      .catch(() => {})
    history.activeId = target.id
    target.updatedAt = now
    target.messageCount = messages.length
    await this.store.writeHistory(book.id, history).catch(() => {})

    let opened: Awaited<ReturnType<AgentBackend['open']>>
    try {
      opened = await this.backend.open({
        book,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      })
    } catch (error) {
      if (error instanceof ChatError) throw error
      throw new ChatError(
        'chat_open_failed',
        `无法恢复这个对话：${describeError(error)}`,
        '确认当前模型可用后重试。',
      )
    }

    target.sessionId = opened.sessionId
    const entry = this.attachEntry(book, opened, messages, target.id, target.title, isDraftTitle(target.title))
    if (entry.messages.length !== messages.length) {
      target.messageCount = entry.messages.length
      this.persistMessages(entry)
    }
    await this.store
      .writeSession(book.id, {
        version: 1,
        sessionId: entry.sessionId,
        title: entry.title,
        createdAt: target.createdAt,
        updatedAt: now,
      })
      .catch(() => {})
    await this.store.writeHistory(book.id, history).catch(() => {})
    return { sessionId: entry.sessionId, activeId: target.id, messages: this.historyOf(entry) }
  }

  async cancel(book: Book): Promise<void> {
    const entry = this.entries.get(book.id)
    if (!entry) return
    try {
      entry.connection.cancel()
    } catch (error) {
      this.logger.warn?.(`[dsh-textbook-reader] chat cancel failed: ${describeError(error)}`)
    }
  }

  /** Start a fresh conversation; the previous one stays in the history list. */
  async reset(
    book: Book,
    mode?: ChatAgentMode,
    parentSessionId?: string,
  ): Promise<{ sessionId: string; conversationId: string }> {
    const existing = this.entries.get(book.id)
    const history = await this.ensureHistory(book)
    if (existing) {
      this.entries.delete(book.id)
      existing.unsubscribe()
      await existing.persisting.catch(() => {})
      await this.archiveAndDrop(book, history, existing)
      existing.listeners.clear()
      await existing.connection.dispose().catch(() => {})
    } else {
      await this.archiveStoredActive(book, history)
    }
    await this.store.writeTranscript(book.id, []).catch(() => {})
    const opened = await this.openAndRecord(book, true, mode, parentSessionId)
    return { sessionId: opened.sessionId, conversationId: opened.conversationId }
  }

  async status(book: Book): Promise<ChatStatus> {
    const record = await this.store.readSession(book.id).catch(() => undefined)
    const entry = this.entries.get(book.id)
    const described = this.backend.describe?.()
    return {
      available: described?.available !== false,
      ...(entry?.sessionId || record?.sessionId
        ? { sessionId: entry?.sessionId ?? record?.sessionId }
        : {}),
      running: entry?.running ?? false,
      ...(described?.model ? { model: described.model } : {}),
    }
  }

  /** Run one direct model call to separate provider/transport failures from Agent failures. */
  async probe(sessionId?: string, mode?: 'stream' | 'prepare'): Promise<ChatProbeResult> {
    return this.backend.probe
      ? this.backend.probe(sessionId, mode)
      : { ok: false, error: { code: 'chat_unavailable', message: '当前后端不支持模型探针。' } }
  }

  /** Live root sessions a diagnostic client can use as a parent for the book agent. */
  liveRoots(): Array<{ id: string; status?: string }> {
    const own = new Set([...this.entries.values()].map((entry) => entry.sessionId))
    return (this.backend.listRoots?.() ?? []).filter((root) => !own.has(root.id))
  }

  async readReadingState(bookId: string): Promise<ReadingState | undefined> {
    return this.store.readReadingState(bookId)
  }

  async writeReadingState(
    bookId: string,
    input: Omit<ReadingState, 'version' | 'bookId' | 'updatedAt'>,
  ): Promise<ReadingState> {
    const state: ReadingState = {
      version: 1,
      bookId,
      updatedAt: new Date().toISOString(),
      ...(sanitizeText(input.nodeId) ? { nodeId: sanitizeText(input.nodeId) } : {}),
      ...(sanitizeText(input.nodeTitle) ? { nodeTitle: sanitizeText(input.nodeTitle) } : {}),
      ...(integer(input.page) ? { page: integer(input.page) } : {}),
      ...(integer(input.pageFrom) ? { pageFrom: integer(input.pageFrom) } : {}),
      ...(integer(input.pageTo) ? { pageTo: integer(input.pageTo) } : {}),
      ...(input.selection?.text
        ? {
            selection: {
              text: sanitizeText(input.selection.text).slice(0, MAX_SELECTION),
              ...(integer(input.selection.page) ? { page: integer(input.selection.page) } : {}),
              ...(integer(input.selection.pageFrom) ? { pageFrom: integer(input.selection.pageFrom) } : {}),
              ...(integer(input.selection.pageTo) ? { pageTo: integer(input.selection.pageTo) } : {}),
              ...(input.selection.blockIds?.length
                ? { blockIds: input.selection.blockIds.filter(Boolean).slice(0, 32) }
                : {}),
            },
          }
        : {}),
      ...(sanitizeText(input.progress) ? { progress: sanitizeText(input.progress) } : {}),
    }
    await this.store.writeReadingState(bookId, state)
    return state
  }

  /** Wait for queued transcript/history writes of the active conversation. */
  async flush(book: Book): Promise<void> {
    await this.entries.get(book.id)?.persisting
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    this.opening.clear()
    await Promise.all(entries.map(async (entry) => {
      entry.unsubscribe()
      await entry.persisting.catch(() => {})
      entry.listeners.clear()
      await entry.connection.dispose().catch(() => {})
    }))
  }

  private async ensureEntry(
    book: Book,
    options: { mode?: ChatAgentMode; parentSessionId?: string } = {},
  ): Promise<Entry> {
    const existing = this.entries.get(book.id)
    if (existing) return existing
    const pending = this.opening.get(book.id)
    if (pending) return pending
    const promise = this.openAndRecord(book, false, options.mode, options.parentSessionId).finally(() =>
      this.opening.delete(book.id),
    )
    this.opening.set(book.id, promise)
    return promise
  }

  private async openAndRecord(
    book: Book,
    fresh = false,
    mode?: ChatAgentMode,
    parentSessionId?: string,
  ): Promise<Entry> {
    const stored = fresh ? undefined : await this.store.readSession(book.id).catch(() => undefined)
    // Migrate sessions created by the first C0 build: their `tbr-` ids were
    // rejected by the account transport.
    const record = stored && stored.sessionId.startsWith('tbr-') ? undefined : stored
    const persisted = fresh
      ? { version: 2, messages: [] as ChatMessage[] }
      : await this.store
          .readTranscriptWithVersion(book.id)
          .catch(() => ({ version: 1, messages: [] as ChatMessage[] }))
    let transcriptVersion = persisted.version
    let initialMessages = persisted.messages
    if (initialMessages.length === 0 && !fresh && record?.sessionId) {
      const legacy = await this.backend.history?.(record.sessionId).catch(() => [])
      if (legacy && legacy.length > 0) {
        initialMessages = legacy
        transcriptVersion = 2
        await this.store.writeTranscript(book.id, initialMessages).catch(() => {})
      }
    }
    // Transcripts written before tool calls were persisted can be enriched
    // from the session log, so an existing conversation does not lose the
    // call summary that was visible when it was created.
    if (!fresh && transcriptVersion < 2 && initialMessages.length > 0 && record?.sessionId) {
      initialMessages = await this.backfillToolCalls(record.sessionId, initialMessages)
      // The rewrite also stamps the transcript as version 2, so a conversation
      // with no tool calls does not inspect the session log on every open.
      await this.store.writeTranscript(book.id, initialMessages).catch(() => {})
    }
    let opened: Awaited<ReturnType<AgentBackend['open']>>
    try {
      opened = await this.backend.open({
        book,
        ...(record?.sessionId ? { sessionId: record.sessionId } : {}),
        ...(mode ? { mode } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
      })
    } catch (error) {
      if (error instanceof ChatError) throw error
      throw new ChatError(
        'chat_open_failed',
        `无法打开本书的伴读会话：${describeError(error)}`,
        '确认已在设置中选择模型，并重启插件后重试。',
      )
    }

    const history = await this.ensureHistory(book)
    const now = new Date().toISOString()
    let target: ChatHistoryEntry | undefined
    if (!fresh) {
      target =
        history.sessions.find((item) => item.id === history.activeId) ??
        history.sessions.find((item) => item.sessionId === opened.sessionId)
    }
    if (!target) {
      target = {
        id: randomId('conv'),
        sessionId: opened.sessionId,
        title: fresh ? defaultChatTitle() : resolveConversationTitle(record?.title, initialMessages),
        createdAt: now,
        updatedAt: now,
        messageCount: initialMessages.length,
      }
      history.sessions.push(target)
    } else {
      target.sessionId = opened.sessionId
      if (fresh) {
        target.title = defaultChatTitle()
        target.messageCount = 0
      } else if (initialMessages.length > 0 && isDraftTitle(target.title)) {
        target.title = titleFromMessages(initialMessages, target.title)
      }
      target.updatedAt = now
    }
    history.activeId = target.id

    const entry = this.attachEntry(
      book,
      opened,
      initialMessages,
      target.id,
      target.title,
      isDraftTitle(target.title),
    )
    if (entry.titleDraft && entry.messages.length > 0) {
      entry.title = titleFromMessages(entry.messages, entry.title)
      entry.titleDraft = false
    }
    target.title = entry.title
    target.sessionId = entry.sessionId
    target.messageCount = entry.messages.length
    await this.store.writeHistory(book.id, history).catch((error: unknown) => {
      this.logger.warn?.(`[dsh-textbook-reader] chat history persist failed: ${describeError(error)}`)
    })
    await this.store
      .writeSession(book.id, {
        version: 1,
        sessionId: entry.sessionId,
        title: entry.title,
        createdAt: target.createdAt,
        updatedAt: now,
      })
      .catch((error: unknown) => {
        this.logger.warn?.(`[dsh-textbook-reader] chat session persist failed: ${describeError(error)}`)
      })
    if (entry.messages.length !== initialMessages.length) this.persistMessages(entry)
    return entry
  }

  private attachEntry(
    book: Book,
    opened: Awaited<ReturnType<AgentBackend['open']>>,
    initialMessages: ChatMessage[],
    conversationId: string,
    title: string,
    titleDraft: boolean,
  ): Entry {
    const entry: Entry = {
      book,
      sessionId: opened.sessionId,
      conversationId,
      title,
      titleDraft,
      connection: opened.connection,
      messages: initialMessages.slice(-200),
      tools: [],
      created: opened.created,
      listeners: new Set(),
      pending: '',
      running: opened.connection.isRunning(),
      unsubscribe: () => {},
      persisting: Promise.resolve(),
    }
    if (entry.messages.length === 0) entry.messages = this.migrateHistory(opened.connection)
    entry.unsubscribe = opened.connection.onEvent((event) => this.handleRuntimeEvent(entry, event))
    this.entries.set(book.id, entry)
    return entry
  }

  /** Read the per-book conversation index, migrating the legacy single session. */
  private async ensureHistory(book: Book): Promise<ChatHistoryRecord> {
    const existing = await this.store.readHistory(book.id).catch(() => undefined)
    if (existing) return existing
    const session = await this.store.readSession(book.id).catch(() => undefined)
    const messages = await this.store.readTranscript(book.id).catch(() => [])
    const now = new Date().toISOString()
    let entry: ChatHistoryEntry | undefined
    if (session) {
      entry = {
        id: randomId('conv'),
        sessionId: session.sessionId,
        title: resolveConversationTitle(session.title, messages),
        createdAt: session.createdAt || now,
        updatedAt: session.updatedAt || now,
        messageCount: messages.length,
      }
    } else if (messages.length > 0) {
      entry = {
        id: randomId('conv'),
        sessionId: '',
        title: titleFromMessages(messages, defaultChatTitle()),
        createdAt: now,
        updatedAt: now,
        messageCount: messages.length,
      }
    }
    const history: ChatHistoryRecord = {
      version: 1,
      activeId: entry?.id ?? '',
      sessions: entry ? [entry] : [],
    }
    await this.store.writeHistory(book.id, history).catch(() => {})
    return history
  }

  /** Archive the live conversation before switching away or starting a new one. */
  private async archiveAndDrop(book: Book, history: ChatHistoryRecord, entry: Entry): Promise<void> {
    const target = history.sessions.find((item) => item.id === entry.conversationId)
    if (target) {
      if (entry.messages.length > 0) {
        await this.store.writeArchivedTranscript(book.id, target.id, entry.messages).catch(() => {})
        target.sessionId = entry.sessionId
        target.title = entry.title
        target.messageCount = entry.messages.length
        target.updatedAt = new Date().toISOString()
      } else {
        history.sessions = history.sessions.filter((item) => item.id !== target.id)
      }
    }
    if (history.activeId === entry.conversationId) history.activeId = ''
    await this.store.writeHistory(book.id, history).catch(() => {})
  }

  /** Archive a persisted active conversation when no live entry was opened. */
  private async archiveStoredActive(book: Book, history: ChatHistoryRecord): Promise<void> {
    const target = history.sessions.find((item) => item.id === history.activeId)
    if (!target) return
    const messages = await this.store.readTranscript(book.id).catch(() => [])
    if (messages.length > 0) {
      await this.store.writeArchivedTranscript(book.id, target.id, messages).catch(() => {})
      target.messageCount = messages.length
      target.updatedAt = new Date().toISOString()
    } else {
      history.sessions = history.sessions.filter((item) => item.id !== target.id)
    }
    history.activeId = ''
    await this.store.writeHistory(book.id, history).catch(() => {})
  }

  /**
   * Attach tool calls from the durable Agent session log to old transcript
   * messages. New transcripts already carry them; this only helps conversations
   * recorded before the browser panel learned to persist the call summary.
   */
  private async backfillToolCalls(
    sessionId: string,
    messages: ChatMessage[],
  ): Promise<ChatMessage[]> {
    if (!messages.some((message) => message.role === 'assistant' && !message.toolCalls?.length)) {
      return messages
    }
    const derived = await this.backend.history?.(sessionId).catch(() => [])
    if (!derived || derived.length === 0) return messages
    let cursor = 0
    return messages.map((message) => {
      if (message.role !== 'assistant') return message
      const text = message.text.trim()
      for (let index = cursor; index < derived.length; index += 1) {
        const candidate = derived[index]
        if (candidate.role !== 'assistant' || candidate.text.trim() !== text) continue
        cursor = index + 1
        if (!message.toolCalls?.length && candidate.toolCalls?.length) {
          return { ...message, toolCalls: candidate.toolCalls }
        }
        return message
      }
      return message
    })
  }

  private async persistSessionMeta(entry: Entry): Promise<void> {
    const history = await this.ensureHistory(entry.book)
    const target = history.sessions.find((item) => item.id === entry.conversationId)
    if (!target) return
    const now = new Date().toISOString()
    target.sessionId = entry.sessionId
    target.title = entry.title
    target.messageCount = entry.messages.length
    target.updatedAt = now
    history.activeId = entry.conversationId
    await this.store.writeHistory(entry.book.id, history)
    await this.store.writeSession(entry.book.id, {
      version: 1,
      sessionId: entry.sessionId,
      title: entry.title,
      createdAt: target.createdAt,
      updatedAt: now,
    })
  }

  private handleRuntimeEvent(entry: Entry, event: AgentRuntimeEvent): void {
    switch (event.type) {
      case 'start':
        entry.pending = ''
        entry.finishReason = undefined
        entry.finishMessage = undefined
        entry.running = true
        this.emit(entry, { type: 'assistant-start', turn: event.turn, step: event.step })
        return
      case 'delta':
        entry.pending += event.text
        this.emit(entry, { type: 'assistant-delta', text: event.text })
        return
      case 'tool':
        entry.tools = applyToolCall(entry.tools, event)
        this.emit(entry, {
          type: 'tool',
          status: event.status,
          name: event.name,
          ...(event.callId ? { callId: event.callId } : {}),
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.error ? { error: true } : {}),
        })
        return
      case 'finish':
        entry.finishReason = event.reason
        entry.finishMessage = event.message
        if (event.reason !== 'completed') {
          entry.running = false
          this.emit(entry, {
            type: 'turn-end',
            reason: event.reason,
            ...(event.message ? { message: event.message } : {}),
          })
          this.emit(entry, { type: 'status', status: 'idle' })
        }
        return
      case 'end':
        this.finishTurn(entry)
        return
      case 'status':
        entry.running = event.status === 'running'
        this.emit(entry, { type: 'status', status: event.status })
        return
      case 'error':
        entry.running = false
        this.emit(entry, {
          type: 'error',
          code: event.code,
          message: event.message,
          ...(event.hint ? { hint: event.hint } : {}),
        })
        return
      default:
        return
    }
  }

  private finishTurn(entry: Entry): void {
    entry.running = false
    let text = entry.pending.trim()
    const tools = entry.tools
    if (!text) {
      const last = entry.connection.history(1).at(-1)
      if (last?.role === 'assistant') {
        const previous = [...entry.messages].reverse().find((message) => message.role === 'assistant')
        if (last.text.trim() && last.text.trim() !== previous?.text.trim()) text = last.text.trim()
      }
    }
    // A turn that only made tool calls (aborted or failed before answering)
    // still produces a message, so its call summary survives a reload.
    if (text || tools.length > 0) {
      const citations = extractCitations(text)
      const message: ChatMessage = {
        id: randomId('msg'),
        role: 'assistant',
        text,
        createdAt: new Date().toISOString(),
        ...(citations.length ? { citations } : {}),
        ...(tools.length ? { toolCalls: tools } : {}),
      }
      entry.messages = [...entry.messages, message].slice(-200)
      this.persistMessages(entry)
      this.emit(entry, { type: 'assistant', message })
    }
    entry.tools = []
    const reason = entry.finishReason ?? 'completed'
    if (reason === 'completed') this.emit(entry, { type: 'turn-end', reason })
    this.emit(entry, { type: 'status', status: 'idle' })
    entry.pending = ''
    entry.finishReason = undefined
    entry.finishMessage = undefined
  }

  private migrateHistory(connection: AgentConnection): ChatMessage[] {
    try {
      return connection
        .history(MAX_HISTORY)
        .filter((message) => message.text.trim() || message.toolCalls?.length)
    } catch (error) {
      this.logger.warn?.(`[dsh-textbook-reader] chat history migration failed: ${describeError(error)}`)
      return []
    }
  }

  private persistMessages(entry: Entry): void {
    entry.persisting = entry.persisting
      .then(async () => {
        await this.store.writeTranscript(entry.book.id, entry.messages)
        await this.persistSessionMeta(entry)
      })
      .catch((error: unknown) => {
        this.logger.warn?.(`[dsh-textbook-reader] chat transcript persist failed: ${describeError(error)}`)
      })
  }

  private historyOf(entry: Entry, limit = MAX_HISTORY): ChatMessage[] {
    return entry.messages.slice(-Math.max(1, limit))
  }

  private emit(entry: Entry, event: ChatEvent): void {
    for (const listener of [...entry.listeners]) {
      try {
        listener(event)
      } catch {
        entry.listeners.delete(listener)
      }
    }
  }
}

function defaultChatTitle(date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `新对话 · ${hours}:${minutes}`
}

function titleFromText(text: string): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return defaultChatTitle()
  return clean.length > 28 ? `${clean.slice(0, 28)}…` : clean
}

function titleFromMessages(messages: ChatMessage[], fallback: string): string {
  const first = messages.find((message) => message.role === 'user' && message.text.trim())
  return first ? titleFromText(first.text) : fallback
}

function isDraftTitle(title: string): boolean {
  return title.startsWith('新对话') || title.startsWith('教材伴读 · ')
}

function resolveConversationTitle(stored: string | undefined, messages: ChatMessage[]): string {
  if (stored && !isDraftTitle(stored)) return stored
  return titleFromMessages(messages, '') || defaultChatTitle()
}

function sanitizeText(value: string | undefined): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function integer(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
