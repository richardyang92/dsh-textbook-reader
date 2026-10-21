/**
 * Browser half: sidebar entry + a split main panel.
 *
 * The left pane keeps the standalone reader iframe; the right pane is the
 * per-book tutor chat. The reader publishes its current book/page/section over
 * postMessage, and citation chips in the chat jump the iframe back to the page.
 */

import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react'
import { summarizeToolArgs, summarizeToolResult } from '../chat/tool-summary.js'
import { applyToolCall } from '../chat/tool-calls.js'
import type { ChatToolCall } from '../chat/types.js'

const NS = 'dsh-textbook-reader'
const PANEL_ID = 'textbook-reader'
const READER_PATH = '/textbook-reader/'
const SELECTION_PROMPT =
  '解释选中的这段内容：先引用原文，再逐句解释关键词和它在上下文里的作用，最后用一个问题检查我是否理解。'

interface ReaderSelection {
  text: string
  page?: number
  pageFrom?: number
  pageTo?: number
  blockIds?: string[]
}

interface ReaderContext {
  bookId: string
  bookTitle: string
  page: number
  pageCount?: number
  nodeId?: string
  nodeTitle?: string
  selection?: ReaderSelection
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  citations?: Array<{ page: number; blockId?: string }>
  toolCalls?: ChatActivity[]
}

interface ChatConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  active: boolean
}

type ChatActivity = ChatToolCall

type ChatEvent =
  | { type: 'snapshot'; sessionId: string; messages: ChatMessage[] }
  | { type: 'user'; message: ChatMessage }
  | { type: 'assistant-start'; turn: number; step: number }
  | { type: 'assistant-delta'; text: string }
  | { type: 'assistant'; message: ChatMessage }
  | { type: 'tool'; status: 'start' | 'end'; name: string; callId?: string; summary?: string; error?: boolean }
  | { type: 'turn-end'; reason: string; message?: string }
  | { type: 'status'; status: 'running' | 'idle' }
  | { type: 'error'; code: string; message: string; hint?: string }

let iframe: HTMLIFrameElement | null = null
let iframeReady = false
let pending: { book?: string; page: number; blocks: string[] } | null = null
let layout: { selectPanel?: (id: string | null) => void } | null = null
let lastContext: ReaderContext | null = null
let lastChatCollapsed = false
let pendingAsk: string | null = null
const contextListeners = new Set<(context: ReaderContext | null) => void>()
const chatOpenListeners = new Set<() => void>()
const askListeners = new Set<(prompt: string) => void>()

function takePendingAsk(): string | null {
  const value = pendingAsk
  pendingAsk = null
  return value
}

export const inject = ['slots', 'locale', 'layout']

export function apply(ctx: any): void {
  layout = ctx.layout ?? null
  const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key: string) => key
  try {
    ctx.locale?.register?.(NS, {
      zh: { panel: '教材伴读', reader: '教材伴读阅读器' },
      en: { panel: 'Textbook Reader', reader: 'Textbook reader' },
    })
  } catch (error) {
    console.warn('[dsh-textbook-reader] locale registration failed:', error)
  }

  const onMessage = (event: MessageEvent): void => {
    if (!iframe || event.source !== iframe.contentWindow) return
    const data = event.data as Record<string, unknown> | null
    if (!data || typeof data !== 'object') return
    if (data.type === 'tbr:ready') {
      iframeReady = true
      flushPending()
      postChatState()
      return
    }
    if (data.type === 'tbr:context') {
      const next = normalizeContext(data.context)
      lastContext = next
      for (const listener of [...contextListeners]) {
        try {
          listener(next)
        } catch {
          contextListeners.delete(listener)
        }
      }
      return
    }
    if (data.type === 'tbr:ask') {
      const prompt =
        typeof data.prompt === 'string' && data.prompt.trim() ? data.prompt.trim() : SELECTION_PROMPT
      const selection = normalizeSelection(data.selection, lastContext?.page)
      if (selection && lastContext) {
        lastContext = { ...lastContext, selection }
        for (const listener of [...contextListeners]) {
          try {
            listener(lastContext)
          } catch {
            contextListeners.delete(listener)
          }
        }
      }
      pendingAsk = prompt
      for (const listener of [...chatOpenListeners]) {
        try {
          listener()
        } catch {
          chatOpenListeners.delete(listener)
        }
      }
      if (askListeners.size > 0) {
        const value = takePendingAsk()
        if (value) {
          for (const listener of [...askListeners]) {
            try {
              listener(value)
            } catch {
              askListeners.delete(listener)
            }
          }
        }
      }
      return
    }
    if (data.type === 'tbr:chat-open') {
      for (const listener of [...chatOpenListeners]) {
        try {
          listener()
        } catch {
          chatOpenListeners.delete(listener)
        }
      }
      return
    }
    if (data.type === 'tbr:back') selectPanel(null)
  }

  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target as Element | null
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    let url: URL
    try {
      url = new URL(anchor.href, window.location.href)
    } catch {
      return
    }
    if (url.pathname !== '/textbook-reader' && !url.pathname.startsWith(READER_PATH)) return
    const page = Number(url.searchParams.get('page'))
    if (!Number.isInteger(page) || page < 1) return
    const blocks = (url.searchParams.get('block') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const book = url.searchParams.get('book') ?? undefined
    event.preventDefault()
    event.stopPropagation()
    openReaderAt({ ...(book ? { book } : {}), page, blocks })
  }

  window.addEventListener('message', onMessage)
  document.addEventListener('click', onClick, true)
  ctx.effect?.(() => () => {
    window.removeEventListener('message', onMessage)
    document.removeEventListener('click', onClick, true)
    iframe = null
    iframeReady = false
    pending = null
    layout = null
    contextListeners.clear()
    chatOpenListeners.clear()
    askListeners.clear()
    pendingAsk = null
    lastContext = null
    lastChatCollapsed = false
  })

  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, TextbookPanel))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 50, locale: NS, label: () => t('panel') },
      TextbookIcon,
    ),
  )
}

function normalizeContext(value: unknown): ReaderContext | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.bookId !== 'string' || !record.bookId) return null
  if (typeof record.bookTitle !== 'string') return null
  const page = Number(record.page)
  if (!Number.isInteger(page) || page < 1) return null
  const selection = normalizeSelection(record.selection, page)
  return {
    bookId: record.bookId,
    bookTitle: record.bookTitle,
    page,
    ...(Number.isInteger(record.pageCount) ? { pageCount: Number(record.pageCount) } : {}),
    ...(typeof record.nodeId === 'string' ? { nodeId: record.nodeId } : {}),
    ...(typeof record.nodeTitle === 'string' ? { nodeTitle: record.nodeTitle } : {}),
    ...(selection ? { selection } : {}),
  }
}

function normalizeSelection(value: unknown, fallbackPage?: number): ReaderSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.text !== 'string') return undefined
  const text = record.text.replace(/\s+/g, ' ').trim().slice(0, 2000)
  if (!text) return undefined
  const page = positiveInt(record.page) ?? positiveInt(fallbackPage)
  const pageFrom = positiveInt(record.pageFrom)
  const pageTo = positiveInt(record.pageTo)
  const blockIds = Array.isArray(record.blockIds)
    ? record.blockIds
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .slice(0, 32)
    : []
  return {
    text,
    ...(page ? { page } : {}),
    ...(pageFrom && pageTo && pageFrom !== pageTo ? { pageFrom, pageTo } : {}),
    ...(blockIds.length ? { blockIds } : {}),
  }
}

function positiveInt(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function openReaderAt(request: { book?: string; page: number; blocks: string[] }): void {
  pending = request
  selectPanel(PANEL_ID)
  flushPending()
}

function selectPanel(id: string | null): void {
  try {
    layout?.selectPanel?.(id)
  } catch (error) {
    console.warn('[dsh-textbook-reader] cannot select panel:', error)
  }
}

function flushPending(): void {
  if (!pending || !iframeReady || !iframe?.contentWindow) return
  const request = pending
  pending = null
  iframe.contentWindow.postMessage(
    { type: 'tbr:jump', book: request.book, page: request.page, blockIds: request.blocks, block: request.blocks.join(',') },
    '*',
  )
}

/** Tell the embedded reader whether its toolbar should show the chat toggle. */
function postChatState(): void {
  if (!iframe?.contentWindow) return
  iframe.contentWindow.postMessage({ type: 'tbr:chat-state', collapsed: lastChatCollapsed }, '*')
}

function TextbookPanel(): ReactNode {
  const ref = useRef<HTMLIFrameElement | null>(null)
  const [context, setContext] = useState<ReaderContext | null>(lastContext)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const listener = (): void => setCollapsed(false)
    chatOpenListeners.add(listener)
    return () => {
      chatOpenListeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    lastChatCollapsed = collapsed
    postChatState()
  }, [collapsed])

  useEffect(() => {
    const listener = (next: ReaderContext | null): void => setContext(next)
    contextListeners.add(listener)
    return () => {
      contextListeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    iframe = ref.current
    iframeReady = false
    ref.current?.contentWindow?.postMessage({ type: 'tbr:ping' }, '*')
    return () => {
      if (iframe === ref.current) iframe = null
      iframeReady = false
    }
  }, [])

  const jump = (page: number, blockId?: string): void => {
    const target = ref.current?.contentWindow
    if (!target) return
    target.postMessage(
      { type: 'tbr:jump', page, blockIds: blockId ? [blockId] : [], block: blockId ?? '' },
      '*',
    )
  }

  const clearSelection = (): void => {
    ref.current?.contentWindow?.postMessage({ type: 'tbr:clear-selection' }, '*')
    if (!lastContext?.selection) return
    const { selection: _selection, ...rest } = lastContext
    lastContext = rest
    for (const listener of [...contextListeners]) {
      try {
        listener(lastContext)
      } catch {
        contextListeners.delete(listener)
      }
    }
  }

  return h(
    'div',
    {
      className: 'tbr-workspace',
      'data-dsh-plugin': 'dsh-textbook-reader',
      'data-dsh-surface': 'textbook-reader-panel',
    },
    h('style', { key: 'style' }, CHAT_CSS),
    h(
      'div',
      { className: 'tbr-reader-pane', key: 'reader' },
      h('iframe', {
        ref,
        src: `${READER_PATH}?embed=1`,
        title: '教材伴读',
        className: 'tbr-reader-frame',
        onLoad: () => {
          iframe = ref.current
          iframeReady = false
          ref.current?.contentWindow?.postMessage({ type: 'tbr:ping' }, '*')
        },
      }),
    ),
    collapsed
      ? null
      : h(ChatPanel, {
          key: 'chat',
          context,
          onJump: jump,
          onCollapse: () => setCollapsed(true),
          onClearSelection: clearSelection,
        }),
  )
}

function ChatPanel(props: {
  context: ReaderContext | null
  onJump: (page: number, blockId?: string) => void
  onCollapse: () => void
  onClearSelection: () => void
}): ReactNode {
  const { context, onJump, onCollapse, onClearSelection } = props
  const bookId = context?.bookId
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingText, setPendingText] = useState('')
  const [activities, setActivities] = useState<ChatActivity[]>([])
  const [streaming, setStreaming] = useState(false)
  const [sending, setSending] = useState(false)
  const [ready, setReady] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [switching, setSwitching] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  // Mirrors `activities` synchronously: a burst of tool + assistant SSE events
  // can be batched into one render, and React state would still be stale.
  const activitiesRef = useRef<ChatActivity[]>([])

  useEffect(() => {
    const listener = (prompt: string): void => {
      setInput(prompt)
      setTimeout(() => {
        const node = composerRef.current
        if (!node) return
        node.focus()
        try {
          node.setSelectionRange(node.value.length, node.value.length)
        } catch {
          // Selection APIs are unavailable in some test runners.
        }
      }, 0)
    }
    askListeners.add(listener)
    const pending = takePendingAsk()
    if (pending) listener(pending)
    return () => {
      askListeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (!bookId) {
      setMessages([])
      setPendingText('')
      activitiesRef.current = []
      setActivities([])
      setReady(false)
      setError('')
      setHistoryOpen(false)
      setConversations([])
      setHistoryError('')
      setSwitching('')
      return
    }
    const controller = new AbortController()
    setMessages([])
    setPendingText('')
    activitiesRef.current = []
    setActivities([])
    setStreaming(false)
    setSending(false)
    setReady(false)
    setError('')
    setHistoryOpen(false)
    setConversations([])
    setHistoryError('')
    setSwitching('')
    const handle = (event: ChatEvent): void => {
      if (event.type === 'snapshot') {
        setMessages(event.messages)
        activitiesRef.current = []
        setActivities([])
        setReady(true)
        return
      }
      if (event.type === 'user') {
        setSending(false)
        activitiesRef.current = []
        setActivities([])
        setMessages((current) => [...current, event.message])
        return
      }
      if (event.type === 'assistant-start') {
        setStreaming(true)
        setPendingText('')
        return
      }
      if (event.type === 'assistant-delta') {
        setPendingText((current) => current + event.text)
        return
      }
      if (event.type === 'assistant') {
        setPendingText('')
        setStreaming(false)
        // The host attaches this turn's calls to the message. If an older host
        // does not, keep the live list by moving it onto the message so a page
        // refresh cannot hide calls mid-upgrade.
        const fallback = event.message.toolCalls?.length ? undefined : activitiesRef.current
        const message =
          fallback && fallback.length > 0
            ? { ...event.message, toolCalls: fallback }
            : event.message
        activitiesRef.current = []
        setActivities([])
        setMessages((current) => [...current, message])
        return
      }
      if (event.type === 'tool') {
        const next = applyToolCall(activitiesRef.current, event)
        activitiesRef.current = next
        setActivities(next)
        return
      }
      if (event.type === 'turn-end') {
        setStreaming(false)
        setSending(false)
        setPendingText('')
        return
      }
      if (event.type === 'status') {
        if (event.status === 'idle') setStreaming(false)
        return
      }
      if (event.type === 'error') {
        setError(event.hint ? `${event.message}（${event.hint}）` : event.message)
        setStreaming(false)
        setSending(false)
      }
    }
    void openStream(bookId, controller.signal, handle).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setReady(false)
    })
    return () => controller.abort()
  }, [bookId, reload])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages, pendingText, activities])

  const send = async (text: string): Promise<void> => {
    const value = text.trim()
    if (!value || !context || !ready || sending) return
    const sentSelection = Boolean(context.selection)
    setSending(true)
    setError('')
    setInput('')
    try {
      const response = await fetch(`${READER_PATH}api/books/${encodeURIComponent(context.bookId)}/chat/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: value,
          context: {
            page: context.page,
            ...(context.nodeId ? { nodeId: context.nodeId } : {}),
            ...(context.nodeTitle ? { nodeTitle: context.nodeTitle } : {}),
            ...(context.selection ? { selection: context.selection } : {}),
          },
        }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined)
        const error = payload?.error ?? {}
        throw new Error(error.message ?? `发送失败（HTTP ${response.status}）`)
      }
      if (sentSelection) onClearSelection()
    } catch (cause) {
      setSending(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const stop = async (): Promise<void> => {
    if (!context) return
    try {
      await fetch(`${READER_PATH}api/books/${encodeURIComponent(context.bookId)}/chat/cancel`, { method: 'POST' })
    } catch {
      // The next stream event reports failure.
    }
  }

  const reset = async (): Promise<void> => {
    if (!context) return
    try {
      const response = await fetch(`${READER_PATH}api/books/${encodeURIComponent(context.bookId)}/chat/reset`, {
        method: 'POST',
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined)
        throw new Error(payload?.error?.message ?? `新建对话失败（HTTP ${response.status}）`)
      }
      setHistoryOpen(false)
      setReload((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const openHistory = async (): Promise<void> => {
    if (!context) return
    if (historyOpen) {
      setHistoryOpen(false)
      return
    }
    setHistoryOpen(true)
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const response = await fetch(
        `${READER_PATH}api/books/${encodeURIComponent(context.bookId)}/chat/sessions`,
      )
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `读取对话记录失败（HTTP ${response.status}）`)
      }
      setConversations(Array.isArray(payload?.sessions) ? payload.sessions : [])
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setHistoryLoading(false)
    }
  }

  const switchConversation = async (conversation: ChatConversation): Promise<void> => {
    if (!context || conversation.active || switching) return
    setSwitching(conversation.id)
    setHistoryError('')
    try {
      const response = await fetch(`${READER_PATH}api/books/${encodeURIComponent(context.bookId)}/chat/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: conversation.id }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined)
        throw new Error(payload?.error?.message ?? `切换对话失败（HTTP ${response.status}）`)
      }
      setHistoryOpen(false)
      setReload((value) => value + 1)
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSwitching('')
    }
  }

  const selection = context?.selection
  const selectionPage = selection
    ? selection.pageFrom && selection.pageTo
      ? `pp.${selection.pageFrom}-${selection.pageTo}`
      : selection.page
        ? `p.${selection.page}`
        : ''
    : ''
  const selectionExcerpt = selection
    ? selection.text.length > 34
      ? `${selection.text.slice(0, 34)}…`
      : selection.text
    : ''
  const quick = [
    ...(selection ? [{ label: '解释选中', text: SELECTION_PROMPT }] : []),
    { label: '本章导读', text: '用 3 句话导读当前这一章：核心问题、前置知识、阅读路线，并给出页码引用。' },
    { label: '本节小结', text: '用 200 字总结当前这一节，列出 3 个关键概念，每条带页码引用。' },
    { label: '考考我', text: '根据当前这一节出 5 道自测题，先不要给答案。' },
  ]

  const messageNode = (message: ChatMessage): ReactNode => {
    if (message.role === 'user') {
      return h('div', { key: message.id, className: 'tbr-msg tbr-msg-user' }, h('div', { className: 'tbr-bubble' }, message.text))
    }
    const tools = message.toolCalls ?? []
    return h(
      'div',
      { key: message.id, className: 'tbr-msg tbr-msg-ai' },
      // Calls replayed from the transcript render exactly like the live turn.
      tools.length > 0 ? h(ActivityTimeline, { key: 'flow', items: tools }) : null,
      message.text.trim()
        ? h('div', { className: 'tbr-bubble' }, renderMarkdown(message.text, onJump))
        : null,
    )
  }

  return h(
    'aside',
    { className: 'tbr-chat', 'data-dsh-surface': 'textbook-reader-chat' },
    h(
      'header',
      { className: 'tbr-chat-head' },
      h('div', { className: 'tbr-chat-title' }, 'AI 伴读'),
      h(
        'div',
        { className: 'tbr-chat-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'tbr-icon-btn',
            title: '对话记录',
            'aria-label': '对话记录',
            'aria-expanded': historyOpen,
            disabled: !context,
            onClick: () => void openHistory(),
          },
          h(
            'svg',
            {
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
            h('path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }),
            h('path', { d: 'M3 3v5h5' }),
            h('path', { d: 'M12 7v5l3 2' }),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'tbr-icon-btn',
            title: '新对话',
            'aria-label': '新对话',
            onClick: () => void reset(),
          },
          h(
            'svg',
            {
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
            h('path', { d: 'M12 5v14M5 12h14' }),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'tbr-icon-btn',
            title: '收起聊天',
            'aria-label': '收起聊天',
            onClick: onCollapse,
          },
          h(
            'svg',
            {
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
            h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
            h('path', { d: 'M15 4v16' }),
            h('path', { d: 'M9 9l3 3-3 3' }),
          ),
        ),
      ),
    ),
    historyOpen
      ? h('div', {
          key: 'history-backdrop',
          className: 'tbr-history-backdrop',
          onClick: () => setHistoryOpen(false),
        })
      : null,
    historyOpen
      ? h(
          'div',
          { key: 'history', className: 'tbr-history', role: 'dialog', 'aria-label': '对话记录' },
          h(
            'div',
            { className: 'tbr-history-head' },
            h('div', { className: 'tbr-history-heading' }, '对话记录'),
            h(
              'button',
              {
                type: 'button',
                className: 'tbr-history-close',
                'aria-label': '关闭',
                title: '关闭',
                onClick: () => setHistoryOpen(false),
              },
              '×',
            ),
          ),
          historyLoading
            ? h('div', { className: 'tbr-history-hint' }, '正在读取…')
            : historyError
              ? h('div', { className: 'tbr-error' }, historyError)
              : conversations.length === 0
                ? h('div', { className: 'tbr-history-hint' }, '还没有对话记录。')
                : h(
                    'div',
                    { className: 'tbr-history-list' },
                    conversations.map((conversation) =>
                      h(
                        'button',
                        {
                          key: conversation.id,
                          type: 'button',
                          className: `tbr-history-row${conversation.active ? ' active' : ''}`,
                          disabled: Boolean(switching) || streaming,
                          onClick: () => void switchConversation(conversation),
                        },
                        h(
                          'div',
                          { className: 'tbr-history-row-top' },
                          h('span', { className: 'tbr-history-title' }, conversation.title),
                          conversation.active
                            ? h('span', { className: 'tbr-history-badge' }, '当前')
                            : null,
                        ),
                        h(
                          'div',
                          { className: 'tbr-history-meta' },
                          switching === conversation.id
                            ? '正在切换…'
                            : `${formatConversationTime(conversation.updatedAt)} · ${conversation.messageCount} 条消息`,
                        ),
                      ),
                    ),
                  ),
        )
      : null,
    h(
      'div',
      { className: 'tbr-context-bar' },
      h(
        'div',
        { className: 'tbr-context-row' },
        context
          ? h(
              'div',
              { className: 'tbr-context-chip' },
              h('b', null, context.bookTitle),
              h('span', null, context.nodeTitle ? ` · ${context.nodeTitle}` : ''),
              h('span', null, ` · p.${context.page}`),
            )
          : h('div', { className: 'tbr-context-chip muted' }, '打开一本教材，我会自动带入当前页。'),
        selection
          ? h(
              'div',
              { className: 'tbr-selection-chip', title: selection.text },
              h('span', { className: 'tbr-selection-text' }, `“${selectionExcerpt}”`),
              selectionPage ? h('span', { className: 'tbr-selection-meta' }, selectionPage) : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'tbr-selection-action',
                  title: '解释选中原文',
                  disabled: !ready || sending,
                  onClick: () => void send(SELECTION_PROMPT),
                },
                '解释',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tbr-selection-clear',
                  title: '清除选中',
                  'aria-label': '清除选中',
                  onClick: onClearSelection,
                },
                '×',
              ),
            )
          : null,
      ),
    ),
    h(
      'div',
      { className: 'tbr-messages', ref: scrollRef },
      messages.length === 0 && !pendingText && activities.length === 0
        ? h(
            'div',
            { className: 'tbr-empty' },
            h('div', { className: 'tbr-empty-title' }, context ? '想怎么读？' : '还没有打开的教材'),
            h(
              'div',
              { className: 'tbr-empty-sub' },
              context
                ? selection
                  ? '已带入选中原文，可直接提问或点「解释选中」。'
                  : '可以直接提问，或在 PDF 上拖选原文带入聊天。'
                : '先在上方阅读器里打开一本已解析的教材。',
            ),
            context
              ? h(
                  'div',
                  { className: 'tbr-quick' },
                  quick.map((item) =>
                    h(
                      'button',
                      {
                        key: item.label,
                        type: 'button',
                        className: 'tbr-quick-btn',
                        disabled: !ready || sending,
                        onClick: () => void send(item.text),
                      },
                      item.label,
                    ),
                  ),
                )
              : null,
          )
        : null,
      messages.map(messageNode),
      activities.length > 0 ? h(ActivityTimeline, { key: 'flow-live', items: activities }) : null,
      pendingText
        ? h(
            'div',
            { className: 'tbr-msg tbr-msg-ai' },
            h(
              'div',
              { className: 'tbr-bubble' },
              renderMarkdown(pendingText, onJump),
              h('span', { className: 'tbr-caret' }, '▍'),
            ),
          )
        : null,
      error ? h('div', { className: 'tbr-error' }, error) : null,
    ),
    h(
      'footer',
      { className: 'tbr-composer' },
      h(
        'div',
        { className: 'tbr-composer-box' },
        h('textarea', {
          ref: composerRef,
          value: input,
          rows: 3,
          placeholder: context
            ? selection
              ? '就选中的这段提问，或继续问这一页…'
              : '问这一节、这一页，或让 AI 考考你…'
            : '先打开一本教材',
          disabled: !context,
          onChange: (event: any) => setInput(event.target.value),
          onKeyDown: (event: any) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
              event.preventDefault()
              void send(input)
            }
          },
        }),
        h(
          'div',
          { className: 'tbr-composer-row' },
          h(
            'span',
            { className: 'tbr-hint' },
            sending
              ? '已发送，等待 AI…'
              : streaming
                ? '正在回答…'
                : selection
                  ? '已带入选中文本 · Enter 发送'
                  : '在 PDF 上拖选原文可带入上下文 · Enter 发送',
          ),
          streaming
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'tbr-send stop',
                  title: '停止',
                  'aria-label': '停止',
                  onClick: () => void stop(),
                },
                h(
                  'svg',
                  { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': 'true' },
                  h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5, fill: 'currentColor', stroke: 'none' }),
                ),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'tbr-send',
                  title: '发送',
                  'aria-label': '发送',
                  disabled: !context || !ready || sending || !input.trim(),
                  onClick: () => void send(input),
                },
                h(
                  'svg',
                  {
                    viewBox: '0 0 24 24',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 2,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                    'aria-hidden': 'true',
                  },
                  h('path', { d: 'M12 19V5M5 12l7-7 7 7' }),
                ),
              ),
        ),
      ),
    ),
  )
}

/** Chinese verb for a textbook tool, used by the collapsed flow summary. */
const TOOL_LABELS: Record<string, string> = {
  textbook_list: '教材列表',
  textbook_search: '检索教材',
  textbook_tree: '章节树',
  textbook_progress: '学习进度',
  textbook_progress_update: '更新进度',
  textbook_parse: '解析教材',
  textbook_add: '添加教材',
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

/** One line of plain text for one call: never the raw tool JSON. */
export function summarizeStep(item: ChatActivity): string {
  const raw = (item.summary ?? '').trim()
  if (!raw) return item.status === 'start' ? '进行中…' : '完成'
  const running = item.status === 'start'
  const digest = running
    ? summarizeToolArgs(item.name, raw)
    : summarizeToolResult(item.name, raw, item.error === true)
  return digest ?? (running ? '进行中…' : '完成')
}

/** `检索教材 ×8 · 教材列表`, at most three kinds. */
function flowBreakdown(items: ChatActivity[]): string {
  const counts = new Map<string, number>()
  for (const item of items) {
    const label = toolLabel(item.name)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(' · ')
}

/**
 * Tool calls of the current turn. They start as one summary line (the tool
 * call list is noise once an answer exists) and expand on demand into one line
 * per call.
 */
function ActivityTimeline(props: { items: ChatActivity[] }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const items = props.items
  if (items.length === 0) return null
  const running = items.some((item) => item.status === 'start')
  const failed = items.filter((item) => item.error).length
  const current = [...items].reverse().find((item) => item.status === 'start') ?? items[items.length - 1]
  const status = running ? 'start' : failed > 0 ? 'error' : 'end'
  const single = items.length === 1
  const open = single || expanded
  const label = running
    ? `正在${toolLabel(current.name)}…`
    : `${items.length} 次工具调用${failed > 0 ? ` · ${failed} 个失败` : ''}`
  const meta = running ? summarizeStep(current) : flowBreakdown(items)
  const rows = items.map((item) =>
    h(
      'div',
      {
        key: item.id,
        className: `tbr-step${item.error ? ' error' : ''}`,
        title: item.summary ?? item.name,
      },
      h('span', {
        className: `tbr-step-icon ${item.status}${item.error ? ' error' : ''}`,
        'aria-hidden': 'true',
      }),
      h('span', { className: 'tbr-step-name' }, item.name),
      h('span', { className: 'tbr-step-detail' }, summarizeStep(item)),
    ),
  )
  return h(
    'div',
    { className: 'tbr-flow' },
    single
      ? rows[0]
      : h(
          'button',
          {
            type: 'button',
            className: `tbr-flow-head ${status}`,
            'aria-expanded': open,
            title: open ? '收起工具调用明细' : '展开工具调用明细',
            onClick: () => setExpanded((value) => !value),
          },
          h('span', { className: `tbr-step-icon ${status}`, 'aria-hidden': 'true' }),
          h('span', { className: 'tbr-flow-title' }, label),
          h('span', { className: 'tbr-flow-meta' }, meta),
          h(
            'svg',
            {
              className: 'tbr-flow-chevron',
              viewBox: '0 0 12 12',
              'aria-hidden': 'true',
            },
            h('path', { d: 'M2.5 4.5 6 8l3.5-3.5' }),
          ),
        ),
    !single && open ? h('div', { className: 'tbr-flow-list' }, rows) : null,
  )
}

function formatConversationTime(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(time)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

async function openStream(
  bookId: string,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const response = await fetch(`${READER_PATH}api/books/${encodeURIComponent(bookId)}/chat/events`, {
    signal,
    headers: { accept: 'text/event-stream' },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`聊天流打开失败（HTTP ${response.status}）${text.slice(0, 200)}`)
  }
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    throw new Error('聊天流响应类型异常。')
  }
  const body = response.body
  if (!body) throw new Error('聊天流没有响应体。')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseFrame(frame)
        if (event) onEvent(event)
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parseFrame(raw: string): ChatEvent | null {
  let name = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  let data: any
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    return null
  }
  if (!data || typeof data.type !== 'string') return null
  return { ...data, type: data.type || name } as ChatEvent
}

function renderMarkdown(text: string, onJump: (page: number, blockId?: string) => void): ReactNode {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0
  const blockStart = (line: string): boolean =>
    /^```|^#{1,6}\s+|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^\s*>\s?|^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (/^```/.test(line.trim())) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      blocks.push(h('pre', { key: `pre${key++}`, className: 'tbr-md-pre' }, h('code', null, code.join('\n'))))
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push(
        h(
          'div',
          { key: `h${key++}`, className: `tbr-md-head tbr-md-h${heading[1].length}` },
          renderInline(heading[2], onJump),
        ),
      )
      i++
      continue
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push(h('hr', { key: `hr${key++}`, className: 'tbr-md-hr' }))
      i++
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(renderInline(lines[i].replace(/^\s*[-*+]\s+/, ''), onJump))
        i++
      }
      blocks.push(
        h(
          'ul',
          { key: `ul${key++}`, className: 'tbr-md-list' },
          items.map((item, index) => h('li', { key: index }, item)),
        ),
      )
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''), onJump))
        i++
      }
      blocks.push(
        h(
          'ol',
          { key: `ol${key++}`, className: 'tbr-md-list' },
          items.map((item, index) => h('li', { key: index }, item)),
        ),
      )
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push(
        h('blockquote', { key: `q${key++}`, className: 'tbr-md-quote' }, renderInline(quote.join('\n'), onJump)),
      )
      continue
    }
    const paragraph = [line]
    i++
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) {
      paragraph.push(lines[i])
      i++
    }
    blocks.push(h('p', { key: `p${key++}`, className: 'tbr-md-p' }, renderInline(paragraph.join('\n'), onJump)))
  }
  return h('div', { className: 'tbr-md' }, blocks)
}

function renderInline(
  text: string,
  onJump: (page: number, blockId?: string) => void,
  depth = 0,
): ReactNode {
  const pattern =
    /\[((?:\\.|[^\]])*)\]\((https?:\/\/[^)\s]+)\)|\[p\.(\d+)(?:#([A-Za-z0-9_-]+))?\]|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\n]+)\*/g
  const nodes: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(h('span', { key: `t${key++}` }, text.slice(last, match.index)))
    if (match[2]) {
      let page = 0
      let block: string | undefined
      try {
        const linked = new URL(match[2])
        page = Number(linked.searchParams.get('page'))
        block = linked.searchParams.get('block') ?? undefined
      } catch {
        // Not a reader link; fall through to a normal anchor.
      }
      if (Number.isInteger(page) && page > 0) {
        nodes.push(citationButton(page, block, onJump, key++))
      } else {
        nodes.push(
          h(
            'a',
            { key: `a${key++}`, href: match[2], target: '_blank', rel: 'noreferrer' },
            match[1],
          ),
        )
      }
    } else if (match[3]) {
      const page = Number(match[3])
      if (Number.isInteger(page) && page > 0) {
        nodes.push(citationButton(page, match[4] ?? undefined, onJump, key++))
      }
    } else if (match[5]) {
      nodes.push(
        h(
          'strong',
          { key: `s${key++}` },
          depth < 3 ? renderInline(match[5], onJump, depth + 1) : match[5],
        ),
      )
    } else if (match[6]) {
      nodes.push(h('code', { key: `c${key++}`, className: 'tbr-md-code' }, match[6]))
    } else if (match[7]) {
      nodes.push(
        h(
          'em',
          { key: `e${key++}` },
          depth < 3 ? renderInline(match[7], onJump, depth + 1) : match[7],
        ),
      )
    }
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(h('span', { key: `t${key++}` }, text.slice(last)))
  return h('span', { className: 'tbr-inline' }, nodes)
}

function citationButton(
  page: number,
  blockId: string | undefined,
  onJump: (page: number, blockId?: string) => void,
  key: number,
): ReactNode {
  return h(
    'button',
    {
      key: `c${key}`,
      type: 'button',
      className: 'tbr-cite',
      title: blockId ? `跳到 p.${page} / ${blockId}` : `跳到 p.${page}`,
      onClick: () => onJump(page, blockId),
    },
    `[p.${page}]`,
  )
}

const CHAT_CSS = `
.tbr-workspace { display:flex; width:100%; height:100%; overflow:hidden; position:relative; background:var(--dsw-alias-bg-layer-1,#f6f7f9); }
.tbr-reader-pane { flex:1; min-width:0; height:100%; }
.tbr-reader-frame { width:100%; height:100%; border:none; display:block; }
.tbr-chat { position:relative; width:380px; min-width:320px; height:100%; display:flex; flex-direction:column; border-left:1px solid var(--dsw-alias-border-l1,#e5e7eb); background:var(--dsw-alias-bg-layer-1,#f7f8fa); color:var(--dsw-alias-label-primary,#1f2328); font-size:13px; line-height:1.6; }
.tbr-chat-head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px 6px; }
.tbr-chat-title { font-weight:600; font-size:13px; letter-spacing:.01em; color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-chat-actions { display:flex; gap:2px; }
.tbr-icon-btn { width:28px; height:28px; display:inline-flex; align-items:center; justify-content:center; border:none; background:transparent; color:var(--dsw-alias-label-secondary,#6b7280); cursor:pointer; padding:0; border-radius:8px; }
.tbr-icon-btn svg { width:15px; height:15px; }
.tbr-icon-btn:hover { background:var(--dsw-alias-bg-layer-2,#eef0f3); color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-icon-btn:disabled { opacity:.4; cursor:default; }
.tbr-context-bar { padding:0 14px 10px; }
.tbr-context-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.tbr-context-chip { display:inline-flex; align-items:center; max-width:100%; padding:3px 9px; border-radius:999px; background:var(--dsw-alias-bg-layer-2,#eef0f3); color:var(--dsw-alias-label-secondary,#5b6470); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tbr-context-chip b { color:var(--dsw-alias-label-primary,#1f2328); font-weight:600; }
.tbr-context-chip.muted { color:var(--dsw-alias-label-secondary,#8a93a0); opacity:.85; }
.tbr-selection-chip { display:flex; align-items:center; gap:5px; min-width:0; max-width:100%; padding:3px 4px 3px 9px; border:1px solid var(--dsw-alias-border-l1,#dfe3e8); border-radius:10px; background:var(--dsw-alias-bg-layer-2,#f3f5f8); color:var(--dsw-alias-label-secondary,#5b6470); font-size:11.5px; }
.tbr-selection-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tbr-selection-meta { flex:none; color:var(--dsw-alias-brand-primary,#3b6ef5); }
.tbr-selection-action { flex:none; border:none; background:transparent; color:var(--dsw-alias-brand-primary,#3b6ef5); padding:0 2px; font:inherit; cursor:pointer; }
.tbr-selection-action:disabled { opacity:.4; cursor:default; }
.tbr-selection-clear { flex:none; width:18px; height:18px; display:inline-flex; align-items:center; justify-content:center; border:none; border-radius:50%; background:transparent; color:var(--dsw-alias-label-secondary,#8a93a0); font-size:13px; line-height:1; padding:0; cursor:pointer; }
.tbr-selection-clear:hover { background:var(--dsw-alias-bg-layer-1,#e6e9ee); color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-messages { flex:1; overflow-y:auto; padding:4px 14px 12px; display:flex; flex-direction:column; gap:14px; }
.tbr-msg { display:flex; }
.tbr-msg-user { justify-content:flex-end; }
.tbr-msg-ai { flex-direction:column; align-items:flex-start; gap:4px; }
.tbr-bubble { max-width:100%; white-space:pre-wrap; word-break:break-word; }
.tbr-msg-user .tbr-bubble { max-width:86%; padding:8px 12px; border-radius:14px 14px 4px 14px; background:var(--dsw-alias-bg-layer-2,#eef0f3); color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-msg-ai .tbr-bubble { padding:0; background:transparent; color:var(--dsw-alias-label-primary,#1f2328); line-height:1.68; }
.tbr-md { display:block; }
.tbr-md-p { margin:0 0 7px; white-space:pre-wrap; }
.tbr-md-p:last-child { margin-bottom:0; }
.tbr-md-head { font-weight:600; margin:10px 0 4px; color:var(--dsw-alias-label-primary,#1f2328); line-height:1.4; }
.tbr-md-h1 { font-size:16px; }
.tbr-md-h2 { font-size:15px; }
.tbr-md-h3, .tbr-md-h4, .tbr-md-h5, .tbr-md-h6 { font-size:14px; }
.tbr-md-list { margin:4px 0 8px; padding-left:18px; }
.tbr-md-list li { margin:2px 0; white-space:pre-wrap; }
.tbr-md-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; background:var(--dsw-alias-bg-layer-2,#eef0f3); border-radius:4px; padding:1px 4px; }
.tbr-md-pre { margin:6px 0 8px; padding:8px 9px; border-radius:8px; background:var(--dsw-alias-bg-layer-2,#eef0f3); border:1px solid var(--dsw-alias-border-l1,#e0e3e8); overflow:auto; font-size:12px; line-height:1.5; }
.tbr-md-pre code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.tbr-md-quote { margin:6px 0 8px; padding:2px 0 2px 9px; border-left:2px solid var(--dsw-alias-border-l2,#c9ced6); color:var(--dsw-alias-label-secondary,#5b6470); }
.tbr-md-hr { border:none; border-top:1px solid var(--dsw-alias-border-l1,#e0e3e8); margin:10px 0; }
.tbr-md a { color:var(--dsw-alias-brand-primary,#3b6ef5); }
.tbr-flow { display:flex; flex-direction:column; gap:2px; min-width:0; }
.tbr-flow-head { display:flex; align-items:center; gap:6px; width:100%; min-width:0; padding:2px 0; border:none; background:transparent; color:var(--dsw-alias-label-secondary,#8a93a0); font:inherit; font-size:11.5px; line-height:1.6; text-align:left; cursor:pointer; }
.tbr-flow-head:hover { color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-flow-title { flex:none; color:var(--dsw-alias-label-primary,#1f2328); font-weight:520; white-space:nowrap; }
.tbr-flow-head.error .tbr-flow-title { color:var(--dsw-alias-state-error-primary,#b42318); }
.tbr-flow-meta { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary,#8a93a0); }
.tbr-flow-chevron { flex:none; width:10px; height:10px; margin-left:auto; fill:none; stroke:currentColor; stroke-width:1.4; stroke-linecap:round; stroke-linejoin:round; transition:transform .15s; }
.tbr-flow-head[aria-expanded="true"] .tbr-flow-chevron { transform:rotate(180deg); }
.tbr-flow-list { display:flex; flex-direction:column; gap:2px; padding:1px 0 1px 9px; margin:1px 0 0 6px; border-left:1px solid var(--dsw-alias-border-l1,#e0e3e8); }
.tbr-step { display:flex; align-items:center; gap:6px; min-width:0; font-size:11px; line-height:1.55; color:var(--dsw-alias-label-secondary,#8a93a0); }
.tbr-step-icon { flex:none; width:14px; height:14px; display:inline-flex; align-items:center; justify-content:center; font-size:10px; color:var(--dsw-alias-state-success-primary,#2f9e44); }
.tbr-step-icon.start::after { content:''; width:5px; height:5px; border-radius:50%; background:var(--dsw-alias-brand-primary,#3b6ef5); animation:tbr-pulse 1s infinite; }
.tbr-step-icon.end::after { content:'✓'; }
.tbr-step-icon.error::after { content:'!'; color:var(--dsw-alias-state-error-primary,#b42318); }
@keyframes tbr-pulse { 50% { opacity:.3; } }
.tbr-step-name { flex:none; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dsw-alias-label-primary,#1f2328); font-size:11px; }
.tbr-step-detail { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary,#8a93a0); font-size:11px; }
.tbr-cite { display:inline; border:none; background:transparent; color:var(--dsw-alias-brand-primary,#3b6ef5); cursor:pointer; padding:0 1px; font:inherit; text-decoration:underline; text-underline-offset:2px; }
.tbr-cite:hover { background:var(--dsw-alias-bg-layer-2,#e8efff); border-radius:3px; }
.tbr-caret { display:inline-block; margin-left:1px; opacity:.55; animation:tbr-blink 1s steps(2,start) infinite; }
@keyframes tbr-blink { 50% { opacity:0; } }
.tbr-empty { margin:auto 0; text-align:center; padding:12px 8px; }
.tbr-empty-title { font-weight:600; font-size:15px; margin-bottom:4px; color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-empty-sub { color:var(--dsw-alias-label-secondary,#8a93a0); font-size:12px; }
.tbr-quick { display:flex; flex-wrap:wrap; gap:6px; justify-content:center; margin-top:14px; }
.tbr-quick-btn { border:none; background:var(--dsw-alias-bg-layer-2,#eef0f3); color:var(--dsw-alias-label-primary,#1f2328); border-radius:999px; padding:5px 11px; font-size:12px; cursor:pointer; }
.tbr-quick-btn:hover { background:var(--dsw-alias-bg-layer-1,#e4e7eb); }
.tbr-quick-btn:disabled { opacity:.5; cursor:default; }
.tbr-error { color:var(--dsw-alias-state-error-primary,#b42318); background:var(--dsw-alias-bg-layer-2,#fef3f2); border:1px solid var(--dsw-alias-border-l1,#fecdca); border-radius:10px; padding:7px 9px; font-size:12px; }
.tbr-history-backdrop { position:fixed; inset:0; z-index:40; background:transparent; }
.tbr-history { position:absolute; top:46px; right:10px; z-index:50; width:min(320px,calc(100% - 20px)); max-height:min(60vh,520px); display:flex; flex-direction:column; padding:6px; background:var(--dsw-alias-bg-layer-2,#fff); border:1px solid var(--dsw-alias-border-l1,#e0e3e8); border-radius:12px; box-shadow:0 12px 30px rgba(15,23,42,.18); color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-history-head { flex:none; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px 8px; }
.tbr-history-heading { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-history-close { width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center; border:none; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary,#6b7280); font-size:15px; line-height:1; padding:0; cursor:pointer; }
.tbr-history-close:hover { background:var(--dsw-alias-bg-layer-1,#eef0f3); color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-history-list { min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:2px; }
.tbr-history-row { display:flex; flex-direction:column; gap:3px; width:100%; box-sizing:border-box; padding:7px 8px; border:none; border-radius:8px; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
.tbr-history-row:hover { background:var(--dsw-alias-bg-layer-1,#eef0f3); }
.tbr-history-row.active { background:var(--dsw-alias-bg-layer-1,#eef0f3); }
.tbr-history-row:disabled { opacity:.6; cursor:default; }
.tbr-history-row-top { display:flex; align-items:center; gap:6px; min-width:0; }
.tbr-history-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; font-weight:560; color:var(--dsw-alias-label-primary,#1f2328); }
.tbr-history-badge { flex:none; padding:1px 6px; border-radius:999px; background:var(--dsw-alias-bg-layer-2,#eef0f3); color:var(--dsw-alias-brand-primary,#3b6ef5); font-size:10px; line-height:1.5; }
.tbr-history-meta { color:var(--dsw-alias-label-secondary,#8a93a0); font-size:11px; }
.tbr-history-hint { padding:12px 10px; color:var(--dsw-alias-label-secondary,#8a93a0); font-size:12px; }
.tbr-composer { padding:8px 12px 12px; }
.tbr-composer-box { border:1px solid var(--dsw-alias-border-l1,#e0e3e8); background:var(--dsw-alias-bg-layer-2,#fff); border-radius:16px; padding:8px 8px 6px 12px; box-shadow:0 1px 2px rgba(16,24,40,.04); transition:border-color .15s, box-shadow .15s; }
.tbr-composer-box:focus-within { border-color:var(--dsw-alias-border-l2,#c9ced6); box-shadow:0 0 0 3px rgba(59,110,245,.08); }
.tbr-composer textarea { width:100%; box-sizing:border-box; resize:none; border:none; background:transparent; padding:0; font:inherit; color:inherit; outline:none; line-height:1.55; }
.tbr-composer-row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:4px; }
.tbr-hint { color:var(--dsw-alias-label-secondary,#9aa2ad); font-size:11px; }
.tbr-send { width:30px; height:30px; border:none; border-radius:15px; display:inline-flex; align-items:center; justify-content:center; padding:0; background:var(--dsw-alias-brand-primary,#3b6ef5); color:#fff; cursor:pointer; }
.tbr-send svg { width:15px; height:15px; }
.tbr-send.stop { background:var(--dsw-alias-state-error-primary,#b42318); }
.tbr-send:disabled { opacity:.4; cursor:default; }
@media (max-width: 980px) {
  .tbr-chat { position:absolute; top:0; right:0; bottom:0; z-index:20; width:min(380px,100%); box-shadow:-12px 0 30px rgba(20,40,90,.18); }
}
`

function TextbookIcon(props: { size?: number; active?: boolean }): ReactNode {
  const size = props.size ?? 16
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      opacity: props.active ? 1 : 0.85,
    },
    h('path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
    h('path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }),
    h('path', { d: 'M8 7h8M8 11h6' }),
  )
}
