/** Public entry points for the per-book tutor chat bridge. */

export * from './types.js'
export { buildAgentPrompt, stripContextHeader, extractCitations, TUTOR_GUIDANCE, TEXTBOOK_TOOL_NAMES } from './prompt.js'
export { ChatStore, type ChatSessionRecord, type ReadingState } from './store.js'
export { applyToolCall, MAX_TOOL_CALLS } from './tool-calls.js'
export {
  BookChatService,
  type AgentBackend,
  type AgentConnection,
  type BookChatServiceOptions,
} from './service.js'
export { DshAgentBackend, type DshAgentBackendOptions } from './dsh-backend.js'
