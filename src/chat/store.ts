/** Per-book chat binding and reading position, stored beside the parse data. */

import { join } from 'node:path'
import type { DataPaths } from '../config.js'
import type { ChatMessage, ChatSelection, ChatToolCall } from './types.js'
import { MAX_TOOL_CALLS } from './tool-calls.js'
import { assertBookId } from '../store/books.js'
import { ensureDir, readJsonFile, writeJsonAtomic } from '../store/atomic.js'

export interface ChatSessionRecord {
  version: 1
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
}

/** One conversation in the per-book history list. */
export interface ChatHistoryEntry {
  id: string
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

/**
 * The per-book conversation index. The active conversation still lives in
 * chat.json/transcript.json for backward compatibility; older conversations
 * are archived under ai/history/<id>.json.
 */
export interface ChatHistoryRecord {
  version: 1
  activeId: string
  sessions: ChatHistoryEntry[]
}

/**
 * The plugin-owned chat transcript. It is the source of truth for the reading
 * panel; the subagent session is only the answer engine.
 */
export interface ChatTranscriptRecord {
  /** 2 = assistant messages may carry their tool calls. */
  version: number
  bookId: string
  messages: ChatMessage[]
  updatedAt: string
}

export interface ReadingState {
  version: 1
  bookId: string
  nodeId?: string
  nodeTitle?: string
  page?: number
  pageFrom?: number
  pageTo?: number
  selection?: ChatSelection
  progress?: string
  updatedAt: string
}

export class ChatStore {
  readonly paths: DataPaths

  constructor(paths: DataPaths) {
    this.paths = paths
  }

  private async aiDir(bookId: string): Promise<string> {
    assertBookId(bookId)
    const dir = join(this.paths.books, bookId, 'ai')
    await ensureDir(dir, 0o700)
    return dir
  }

  private async historyDir(bookId: string): Promise<string> {
    assertBookId(bookId)
    const dir = join(this.paths.books, bookId, 'ai', 'history')
    await ensureDir(dir, 0o700)
    return dir
  }

  async readSession(bookId: string): Promise<ChatSessionRecord | undefined> {
    const file = join(await this.aiDir(bookId), 'chat.json')
    const record = await readJsonFile<ChatSessionRecord>(file)
    if (!record || typeof record !== 'object') return undefined
    if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) return undefined
    return { ...record, sessionId: record.sessionId.trim() }
  }

  async writeSession(bookId: string, record: ChatSessionRecord): Promise<void> {
    const file = join(await this.aiDir(bookId), 'chat.json')
    await writeJsonAtomic(file, record, 0o600)
  }

  /** Read the conversation index, or undefined when the book predates it. */
  async readHistory(bookId: string): Promise<ChatHistoryRecord | undefined> {
    const file = join(await this.aiDir(bookId), 'history.json')
    const value = await readJsonFile<unknown>(file)
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    const entries = Array.isArray(record.sessions)
      ? record.sessions
          .map((item) => normalizeHistoryEntry(item))
          .filter((item): item is ChatHistoryEntry => item !== undefined)
      : []
    const seen = new Set<string>()
    const sessions = entries.filter((entry) => {
      if (seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })
    const activeId =
      typeof record.activeId === 'string' && sessions.some((entry) => entry.id === record.activeId)
        ? record.activeId
        : (sessions[0]?.id ?? '')
    return { version: 1, activeId, sessions }
  }

  async writeHistory(bookId: string, record: ChatHistoryRecord): Promise<void> {
    const file = join(await this.aiDir(bookId), 'history.json')
    await writeJsonAtomic(
      file,
      {
        version: 1,
        activeId: record.activeId,
        sessions: record.sessions.slice(-50),
      } satisfies ChatHistoryRecord,
      0o600,
    )
  }

  async readTranscript(bookId: string): Promise<ChatMessage[]> {
    return (await this.readTranscriptWithVersion(bookId)).messages
  }

  async readTranscriptWithVersion(
    bookId: string,
  ): Promise<{ version: number; messages: ChatMessage[] }> {
    return readTranscriptFile(join(await this.aiDir(bookId), 'transcript.json'))
  }

  async writeTranscript(bookId: string, messages: ChatMessage[]): Promise<void> {
    await writeTranscriptFile(join(await this.aiDir(bookId), 'transcript.json'), bookId, messages)
  }

  async readArchivedTranscript(bookId: string, conversationId: string): Promise<ChatMessage[]> {
    return (await this.readArchivedTranscriptWithVersion(bookId, conversationId)).messages
  }

  async readArchivedTranscriptWithVersion(
    bookId: string,
    conversationId: string,
  ): Promise<{ version: number; messages: ChatMessage[] }> {
    if (!isHistoryId(conversationId)) return { version: 2, messages: [] }
    return readTranscriptFile(join(await this.historyDir(bookId), `${conversationId}.json`))
  }

  async writeArchivedTranscript(
    bookId: string,
    conversationId: string,
    messages: ChatMessage[],
  ): Promise<void> {
    if (!isHistoryId(conversationId)) throw new Error(`invalid chat conversation id: ${conversationId}`)
    await writeTranscriptFile(join(await this.historyDir(bookId), `${conversationId}.json`), bookId, messages)
  }

  async readReadingState(bookId: string): Promise<ReadingState | undefined> {
    const file = join(await this.aiDir(bookId), 'reading-state.json')
    return readJsonFile<ReadingState>(file)
  }

  async writeReadingState(bookId: string, state: ReadingState): Promise<void> {
    const file = join(await this.aiDir(bookId), 'reading-state.json')
    await writeJsonAtomic(file, state, 0o600)
  }
}

async function readTranscriptFile(
  file: string,
): Promise<{ version: number; messages: ChatMessage[] }> {
  const record = await readJsonFile<ChatTranscriptRecord>(file)
  if (!record || !Array.isArray(record.messages)) return { version: 2, messages: [] }
  const version =
    typeof record.version === 'number' && Number.isFinite(record.version) ? record.version : 1
  const messages: ChatMessage[] = []
  for (const message of record.messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.text !== 'string'
    ) {
      continue
    }
    const toolCalls = normalizeToolCalls((message as ChatMessage).toolCalls)
    messages.push(toolCalls ? { ...message, toolCalls } : message)
  }
  return { version, messages }
}

/** Keep transcripts written by newer/older builds from breaking the panel. */
function normalizeToolCalls(value: unknown): ChatToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls: ChatToolCall[] = []
  for (const item of value.slice(0, MAX_TOOL_CALLS)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || !record.name.trim()) continue
    const name = record.name.trim().slice(0, 120)
    const id =
      typeof record.id === 'string' && record.id.trim()
        ? record.id.trim().slice(0, 160)
        : `${name}:${calls.length}`
    if (calls.some((call) => call.id === id)) continue
    calls.push({
      id,
      name,
      status: record.status === 'start' ? 'start' : 'end',
      ...(typeof record.summary === 'string' && record.summary.trim()
        ? { summary: record.summary.trim().slice(0, 400) }
        : {}),
      ...(record.error === true ? { error: true } : {}),
    })
  }
  return calls.length > 0 ? calls : undefined
}

async function writeTranscriptFile(file: string, bookId: string, messages: ChatMessage[]): Promise<void> {
  const record: ChatTranscriptRecord = {
    version: 2,
    bookId,
    messages: messages.slice(-200),
    updatedAt: new Date().toISOString(),
  }
  await writeJsonAtomic(file, record, 0o600)
}

function normalizeHistoryEntry(value: unknown): ChatHistoryEntry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !isHistoryId(record.id)) return undefined
  if (typeof record.sessionId !== 'string') return undefined
  const createdAt =
    typeof record.createdAt === 'string' && record.createdAt ? record.createdAt : new Date().toISOString()
  const messageCount =
    typeof record.messageCount === 'number' && Number.isInteger(record.messageCount) && record.messageCount >= 0
      ? record.messageCount
      : 0
  return {
    id: record.id,
    sessionId: record.sessionId.trim(),
    title:
      typeof record.title === 'string' && record.title.trim() ? record.title.trim() : '教材伴读对话',
    createdAt,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : createdAt,
    messageCount,
  }
}

function isHistoryId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value)
}
