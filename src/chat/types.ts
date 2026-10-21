/**
 * Chat protocol shared by the host bridge, the reader HTTP surface and the
 * future browser chat panel. These types are deliberately independent of DSH
 * Agent internals so the bridge can be tested with a fake backend.
 */

export interface ChatCitation {
  page: number
  blockId?: string
}

export interface ChatSelection {
  text: string
  page?: number
  pageFrom?: number
  pageTo?: number
  blockIds?: string[]
}

/** The reading position the reader wants the agent to see. */
export interface ChatContext {
  bookId: string
  bookTitle: string
  nodeId?: string
  nodeTitle?: string
  page?: number
  pageFrom?: number
  pageTo?: number
  selection?: ChatSelection
  /** Optional one-line progress summary, e.g. "已读 8/32 节". */
  progress?: string
}

/** One tool call made while producing an assistant message. */
export interface ChatToolCall {
  id: string
  name: string
  status: 'start' | 'end'
  /** One-line digest of the arguments (start) or result (end). */
  summary?: string
  error?: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt?: string
  citations?: ChatCitation[]
  /**
   * Tool calls that led to this assistant message. Persisting them with the
   * message keeps the collapsed call summary visible after the transcript is
   * reloaded or an older conversation is opened.
   */
  toolCalls?: ChatToolCall[]
  pending?: boolean
}

export type ChatTurnEndReason = 'completed' | 'aborted' | 'error' | 'max-tokens'

/** Agent setup variants used by the C0 diagnostic bisect. */
export type ChatAgentMode = 'full' | 'minimal' | 'restrict' | 'tutor'

export type ChatEvent =
  | { type: 'snapshot'; sessionId: string; messages: ChatMessage[] }
  | { type: 'user'; message: ChatMessage }
  | { type: 'assistant-start'; turn: number; step: number }
  | { type: 'assistant-delta'; text: string }
  | { type: 'assistant'; message: ChatMessage }
  | { type: 'tool'; status: 'start' | 'end'; name: string; callId?: string; summary?: string; error?: boolean }
  | { type: 'turn-end'; reason: ChatTurnEndReason; message?: string }
  | { type: 'status'; status: 'running' | 'idle' }
  | { type: 'error'; code: string; message: string; hint?: string }

export interface ChatStatus {
  available: boolean
  sessionId?: string
  running: boolean
  model?: { provider: string; model: string }
  error?: { code: string; message: string; hint?: string }
}

/** Diagnostic result from a direct model call, used by the C0 spike. */
export interface ChatProbeResult {
  ok: boolean
  text?: string
  error?: { code?: string; message: string; cause?: string }
}

/** Raw events a backend emits for one book agent; the service maps them to ChatEvent. */
export type AgentRuntimeEvent =
  | { type: 'start'; turn: number; step: number }
  | { type: 'delta'; text: string }
  | { type: 'tool'; status: 'start' | 'end'; name: string; callId?: string; summary?: string; error?: boolean }
  | { type: 'finish'; reason: ChatTurnEndReason; message?: string }
  | { type: 'end'; seq?: number }
  | { type: 'status'; status: 'running' | 'idle' }
  | { type: 'error'; code: string; message: string; hint?: string }

export class ChatError extends Error {
  readonly code: string
  readonly hint?: string

  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'ChatError'
    this.code = code
    if (hint) this.hint = hint
  }
}
