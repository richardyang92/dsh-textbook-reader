/**
 * Browser half: one additive sidebar entry + a main-panel iframe hosting the
 * standalone reader. It also turns the agent's [p.N] Markdown links into
 * in-place reader jumps instead of opening a new browser tab.
 */

import { createElement as h, useEffect, useRef, type ReactNode } from 'react'

const NS = 'dsh-textbook-reader'
const PANEL_ID = 'textbook-reader'
const READER_PATH = '/textbook-reader/'

interface JumpRequest {
  book?: string
  page: number
  blocks: string[]
}

let iframe: HTMLIFrameElement | null = null
let iframeReady = false
let pending: JumpRequest | null = null
let layout: { selectPanel?: (id: string | null) => void } | null = null

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
    } else if (data.type === 'tbr:back') {
      selectPanel(null)
    }
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
  })

  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, TextbookPanel),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 50, locale: NS, label: () => t('panel') },
      TextbookIcon,
    ),
  )
}

function openReaderAt(request: JumpRequest): void {
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

function TextbookPanel(): ReactNode {
  const ref = useRef<HTMLIFrameElement | null>(null)
  useEffect(() => {
    iframe = ref.current
    iframeReady = false
    ref.current?.contentWindow?.postMessage({ type: 'tbr:ping' }, '*')
    return () => {
      if (iframe === ref.current) iframe = null
      iframeReady = false
    }
  }, [])
  return h('div', {
    style: { width: '100%', height: '100%', overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1, #f6f7f9)' },
    'data-dsh-plugin': 'dsh-textbook-reader',
    'data-dsh-surface': 'textbook-reader-panel',
  }, h('iframe', {
    ref,
    src: `${READER_PATH}?embed=1`,
    title: '教材伴读',
    style: { width: '100%', height: '100%', border: 'none', display: 'block' },
    onLoad: () => {
      iframe = ref.current
      iframeReady = false
      ref.current?.contentWindow?.postMessage({ type: 'tbr:ping' }, '*')
    },
  }))
}

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
