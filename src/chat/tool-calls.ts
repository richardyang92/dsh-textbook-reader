/**
 * Merge streamed tool events into the list persisted with one assistant
 * message.
 *
 * Both the host transcript and the browser's live turn use the same reducer so
 * a reloaded conversation groups calls exactly like the live transcript did.
 */

import type { ChatToolCall } from './types.js'

/** Upper bound for calls kept on one turn; older calls fall off first. */
export const MAX_TOOL_CALLS = 100

export interface ToolCallEventLike {
  status: 'start' | 'end'
  name: string
  callId?: string
  summary?: string
  error?: boolean
}

/** Return a new list with one start/end event applied (never mutates). */
export function applyToolCall(list: ChatToolCall[], event: ToolCallEventLike): ChatToolCall[] {
  const id = resolveId(list, event)
  const index = list.findIndex((item) => item.id === id)
  const next: ChatToolCall = {
    id,
    name: event.name,
    status: event.status,
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.error ? { error: true } : {}),
  }
  if (index < 0) return [...list, next].slice(-MAX_TOOL_CALLS)
  const copy = list.slice()
  copy[index] = { ...copy[index], ...next }
  return copy
}

/**
 * Prefer the transport call id. Older event sources omit it, so an end event
 * settles the last matching running call instead of appending a duplicate.
 */
function resolveId(list: ChatToolCall[], event: ToolCallEventLike): string {
  if (event.callId) return event.callId
  if (event.status === 'end') {
    let named: ChatToolCall | undefined
    let last: ChatToolCall | undefined
    for (const item of list) {
      if (item.status !== 'start') continue
      last = item
      if (item.name === event.name) named = item
    }
    const match = named ?? last
    if (match) return match.id
  }
  let count = list.length
  for (;;) {
    const id = `${event.name}:${count}`
    if (!list.some((item) => item.id === id)) return id
    count += 1
  }
}
