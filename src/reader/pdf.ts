/**
 * pdf.js viewer for the standalone reader.
 *
 * Renders page shells eagerly and canvases lazily (IntersectionObserver), so a
 * 400-page textbook stays responsive. Jumping to a page renders it, scrolls it
 * into view and draws normalized-bbox highlights for the cited blocks.
 */

import { API, type Block, type PageData } from './api.js'

const PDFJS_URL = `${API}/vendor/pdf.min.mjs`
const WORKER_URL = `${API}/vendor/pdf.worker.min.mjs`
const CMAP_URL = `${API}/vendor/cmaps/`
const STANDARD_FONTS_URL = `${API}/vendor/standard_fonts/`
const WASM_URL = `${API}/vendor/wasm/`

export const MAX_SELECTION = 2000
const MAX_SELECTION_BLOCKS = 32

/** A text selection mapped back to the parsed blocks it intersects. */
export interface PdfSelection {
  text: string
  page: number
  pageFrom?: number
  pageTo?: number
  blockIds: string[]
}

let pdfjsPromise: Promise<any> | undefined

/**
 * pdf.js ≥ 6 removed `PDFDocumentProxy.destroy()`: the document proxy only
 * exposes `cleanup()`/`loadingTask`, and teardown lives on the loading task.
 * Always destroy through the task, and never let teardown throw into callers.
 */
async function destroyTask(task: any): Promise<void> {
  if (!task || typeof task.destroy !== 'function') return
  try {
    await task.destroy()
  } catch {
    /* worker already gone / aborted */
  }
}

async function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    const source = PDFJS_URL
    pdfjsPromise = import(/* @vite-ignore */ source).then((module: any) => {
      module.GlobalWorkerOptions.workerSrc = WORKER_URL
      return module
    })
  }
  return pdfjsPromise
}

export interface PdfViewerOptions {
  scroll: HTMLElement
  pages: HTMLElement
  loading: HTMLElement
  onPageChange?: (page: number) => void
  onStatus?: (text: string) => void
  onError?: (error: Error) => void
  getPageData?: (page: number) => Promise<PageData | null>
}

export class PdfViewer {
  private readonly options: PdfViewerOptions
  private doc: any
  private shells: HTMLElement[] = []
  private observer: IntersectionObserver | undefined
  private resizeObserver: ResizeObserver | undefined
  private scrollHandler: (() => void) | undefined
  private renderGeneration = 0
  private rendered = new Map<number, 'rendering' | 'done'>()
  private pageWidth = 800
  private fitWidth = 800
  private zoom = 1
  private ratio = 1.4142
  private currentPage = 1
  private destroyed = false
  private scrollFrame = 0
  private dataCache = new Map<number, PageData | null>()
  private loadTask: any
  private loadSerial = 0

  constructor(options: PdfViewerOptions) {
    this.options = options
  }

  get pageCount(): number {
    return this.doc?.numPages ?? 0
  }

  get current(): number {
    return this.currentPage
  }

  async load(url: string): Promise<void> {
    this.destroy()
    this.destroyed = false
    const serial = ++this.loadSerial
    this.rendered.clear()
    this.dataCache.clear()
    this.shells = []
    this.options.pages.replaceChildren()
    this.options.loading.classList.remove('hidden')
    this.options.loading.textContent = '正在加载 PDF…'
    this.options.onStatus?.('加载 PDF…')

    let task: any
    try {
      const pdfjs = await loadPdfjs()
      task = pdfjs.getDocument({
        url,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: STANDARD_FONTS_URL,
        // Without this, pdf.js cannot instantiate the OpenJPEG/JBIG2/ICC wasm
        // decoders: scanned pages (JPXDecode) silently render blank white.
        wasmUrl: WASM_URL,
      })
      this.loadTask = task
      const doc = await task.promise
      const discard = async (): Promise<void> => {
        if (this.loadTask === task) this.loadTask = undefined
        if (this.doc === doc) this.doc = undefined
        await destroyTask(task)
      }
      // A newer load() or destroy() superseded this one while the bytes were
      // in flight: throw this document away instead of adopting it.
      if (this.destroyed || serial !== this.loadSerial) {
        await discard()
        return
      }
      this.doc = doc

      const first = await doc.getPage(1)
      if (this.destroyed || serial !== this.loadSerial) {
        await discard()
        return
      }
      const viewport = first.getViewport({ scale: 1 })
      this.ratio = viewport.height / viewport.width
      this.fitWidth = Math.max(320, Math.min(1180, this.options.scroll.clientWidth - 56))
      this.pageWidth = this.fitWidth
      this.buildShells(viewport.width, viewport.height)
      this.attachObservers()
      this.options.loading.classList.add('hidden')
      this.options.onStatus?.(`${doc.numPages} 页`)
      this.setCurrent(1)
      await this.renderPage(1)
    } catch (error) {
      const stale = this.destroyed || serial !== this.loadSerial
      if (task) {
        if (this.loadTask === task) this.loadTask = undefined
        await destroyTask(task)
      }
      // Only the current load reports its failure; stale loads clean up quietly.
      if (stale) return
      this.options.loading.classList.add('hidden')
      throw error
    }
  }

  destroy(): void {
    this.destroyed = true
    this.renderGeneration += 1
    this.loadSerial += 1
    this.observer?.disconnect()
    this.observer = undefined
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    if (this.scrollHandler) this.options.scroll.removeEventListener('scroll', this.scrollHandler)
    this.scrollHandler = undefined
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame)
    this.scrollFrame = 0
    const task = this.loadTask
    this.loadTask = undefined
    this.doc = undefined
    if (task) void destroyTask(task)
    this.shells = []
    this.rendered.clear()
    this.options.pages.replaceChildren()
  }

  async goto(page: number, blockIds: string[] = [], restoreOnly = false): Promise<void> {
    if (!this.doc) return
    const target = Math.max(1, Math.min(this.doc.numPages, Math.trunc(page) || 1))
    const shell = this.shells[target - 1]
    if (!shell) return
    this.setCurrent(target)
    shell.scrollIntoView({ block: 'start', behavior: 'auto' })
    await this.renderPage(target)
    if (restoreOnly) return
    const data = await this.pageData(target)
    if (!data) {
      this.options.onError?.(new Error('这一页没有解析内容块，无法高亮。'))
      return
    }
    this.highlight(target, data.blocks, blockIds)
  }

  clearPageData(): void {
    this.dataCache.clear()
    for (const shell of this.shells) {
      shell.querySelector<HTMLElement>('.pdf-block-layer')?.replaceChildren()
    }
    void this.refreshVisibleBlocks()
  }

  /**
   * Extract the current browser selection when it overlaps the parsed block
   * overlay. Selecting sidebar text (or nothing) returns null so the chat panel
   * keeps the last explicit PDF selection.
   */
  getSelection(): PdfSelection | null {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    const text = normalizeSelectionText(selection.toString())
    if (!text) return null
    const hits: HTMLElement[] = []
    for (const node of this.options.pages.querySelectorAll<HTMLElement>('.pdf-block-text')) {
      let intersects = false
      try {
        intersects = range.intersectsNode(node)
      } catch {
        intersects = false
      }
      if (intersects) hits.push(node)
    }
    if (hits.length === 0) return null
    const pages: number[] = []
    const blockIds: string[] = []
    const seen = new Set<string>()
    for (const node of hits) {
      const page = Number(node.dataset.page)
      if (Number.isInteger(page) && page > 0) pages.push(page)
      const blockId = node.dataset.blockId
      if (blockId && !seen.has(blockId)) {
        seen.add(blockId)
        blockIds.push(blockId)
      }
    }
    if (pages.length === 0) return null
    const pageFrom = Math.min(...pages)
    const pageTo = Math.max(...pages)
    const truncated = text.length > MAX_SELECTION
    return {
      text: truncated ? `${text.slice(0, MAX_SELECTION)}…` : text,
      page: pageFrom,
      ...(pageFrom !== pageTo ? { pageFrom, pageTo } : {}),
      blockIds: blockIds.slice(0, MAX_SELECTION_BLOCKS),
    }
  }

  /** Rebuild overlays without repainting canvases (used after parsing finishes). */
  async refreshVisibleBlocks(): Promise<void> {
    if (this.destroyed) return
    await Promise.all(
      this.visiblePages().map(async (page) => {
        const data = await this.pageData(page)
        if (this.destroyed) return
        this.renderBlockText(page, data)
      }),
    )
  }

  highlightPage(page: number, blockIds: string[] = []): void {
    const data = this.dataCache.get(page)
    if (data) this.highlight(page, data.blocks, blockIds)
  }

  async pageData(page: number): Promise<PageData | null> {
    if (this.dataCache.has(page)) return this.dataCache.get(page) ?? null
    if (!this.options.getPageData) return null
    const data = await this.options.getPageData(page).catch(() => null)
    this.dataCache.set(page, data)
    return data
  }

  zoomBy(delta: number): void {
    const next = Math.min(2.5, Math.max(0.5, Math.round((this.zoom + delta) * 100) / 100))
    if (Math.abs(next - this.zoom) < 0.01) return
    this.zoom = next
    this.applyWidth()
  }

  fit(): void {
    this.zoom = 1
    this.fitWidth = Math.max(320, Math.min(1180, this.options.scroll.clientWidth - 56))
    this.applyWidth()
  }

  get zoomLabel(): string {
    return `${Math.round(this.zoom * 100)}%`
  }

  private buildShells(viewportWidth: number, viewportHeight: number): void {
    this.options.pages.replaceChildren()
    this.options.pages.style.width = `${this.pageWidth}px`
    for (let page = 1; page <= this.doc.numPages; page += 1) {
      const shell = document.createElement('div')
      shell.className = 'pdf-page'
      shell.dataset.page = String(page)

      const sheet = document.createElement('div')
      sheet.className = 'pdf-sheet'
      sheet.style.width = `${this.pageWidth}px`
      sheet.style.aspectRatio = `${viewportWidth} / ${viewportHeight}`

      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-canvas'
      const blocks = document.createElement('div')
      blocks.className = 'pdf-block-layer'
      const overlay = document.createElement('div')
      overlay.className = 'pdf-highlight-layer'
      const pending = document.createElement('div')
      pending.className = 'pdf-page-pending'
      pending.textContent = `第 ${page} 页`
      sheet.append(canvas, blocks, overlay, pending)
      shell.append(sheet)

      const label = document.createElement('div')
      label.className = 'pdf-page-label'
      label.textContent = String(page)
      shell.append(label)
      this.options.pages.append(shell)
      this.shells.push(shell)
    }
    this.options.pages.style.setProperty('--pdf-ratio', String(this.ratio))
  }

  private attachObservers(): void {
    this.observer?.disconnect()
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const page = Number((entry.target as HTMLElement).dataset.page)
          if (Number.isInteger(page)) void this.renderPage(page)
        }
      },
      { root: this.options.scroll, rootMargin: '900px 0px' },
    )
    for (const shell of this.shells) this.observer.observe(shell)

    this.scrollHandler = () => this.onScroll()
    this.options.scroll.addEventListener('scroll', this.scrollHandler, { passive: true })

    this.resizeObserver?.disconnect()
    let lastWidth = this.options.scroll.clientWidth
    this.resizeObserver = new ResizeObserver(() => {
      const width = this.options.scroll.clientWidth
      if (Math.abs(width - lastWidth) < 24) return
      lastWidth = width
      if (this.zoom === 1) {
        this.fitWidth = Math.max(320, Math.min(1180, width - 56))
        this.applyWidth()
      }
    })
    this.resizeObserver.observe(this.options.scroll)
  }

  private applyWidth(): void {
    this.pageWidth = Math.max(240, Math.round(this.fitWidth * this.zoom))
    this.options.pages.style.width = `${this.pageWidth}px`
    const generation = ++this.renderGeneration
    this.rendered.clear()
    for (const shell of this.shells) {
      const sheet = shell.querySelector<HTMLElement>('.pdf-sheet')
      if (sheet) sheet.style.width = `${this.pageWidth}px`
      const canvas = shell.querySelector<HTMLCanvasElement>('canvas')
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      const pending = shell.querySelector<HTMLElement>('.pdf-page-pending')
      if (pending) pending.classList.remove('hidden')
      shell.querySelector<HTMLElement>('.pdf-block-layer')?.replaceChildren()
    }
    void generation
    const visible = this.visiblePages()
    for (const page of visible) void this.renderPage(page, true)
  }

  private visiblePages(): number[] {
    const top = this.options.scroll.scrollTop
    const height = this.options.scroll.clientHeight
    const out: number[] = []
    for (let index = 0; index < this.shells.length; index += 1) {
      const shell = this.shells[index]!
      const shellTop = shell.offsetTop
      const shellBottom = shellTop + shell.offsetHeight
      if (shellBottom >= top - 400 && shellTop <= top + height + 400) out.push(index + 1)
    }
    return out
  }

  private async renderPage(page: number, force = false): Promise<void> {
    if (!this.doc || this.destroyed) return
    const state = this.rendered.get(page)
    if (state === 'rendering' || (state === 'done' && !force)) return
    const shell = this.shells[page - 1]
    if (!shell) return
    this.rendered.set(page, 'rendering')
    const generation = this.renderGeneration
    shell.querySelector<HTMLElement>('.pdf-block-layer')?.replaceChildren()
    const dataPromise = this.pageData(page)
    try {
      const pdfPage = await this.doc.getPage(page)
      if (this.destroyed || generation !== this.renderGeneration) return
      const base = pdfPage.getViewport({ scale: 1 })
      const scale = this.pageWidth / base.width
      const viewport = pdfPage.getViewport({ scale })
      const canvas = shell.querySelector<HTMLCanvasElement>('canvas')
      const sheet = shell.querySelector<HTMLElement>('.pdf-sheet')
      const pending = shell.querySelector<HTMLElement>('.pdf-page-pending')
      if (!canvas || !sheet) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      sheet.style.aspectRatio = `${base.width} / ${base.height}`
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建 PDF canvas 上下文')
      await pdfPage.render({
        canvasContext: context,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise
      if (this.destroyed || generation !== this.renderGeneration) return
      this.rendered.set(page, 'done')
      pending?.classList.add('hidden')
      const data = await dataPromise
      if (this.destroyed || generation !== this.renderGeneration) return
      this.renderBlockText(page, data)
    } catch (error) {
      this.rendered.delete(page)
      const pending = shell.querySelector<HTMLElement>('.pdf-page-pending')
      if (pending) pending.textContent = '这一页渲染失败'
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Lay transparent, selectable text over the page image. MinerU gives us one
   * bbox per block, so each block becomes one selectable node regardless of
   * whether the PDF has an embedded text layer (scanned books often have none).
   */
  private renderBlockText(page: number, data: PageData | null): void {
    const shell = this.shells[page - 1]
    const layer = shell?.querySelector<HTMLElement>('.pdf-block-layer')
    if (!layer) return
    layer.replaceChildren()
    if (!data || data.blocks.length === 0) return
    const width = shell?.clientWidth || this.pageWidth
    const height = shell?.clientHeight || Math.round(width * this.ratio)
    if (!(width > 0) || !(height > 0)) return
    for (const block of data.blocks) {
      const text = String(block.text ?? '').trim()
      if (!text) continue
      const [x0, y0, x1, y1] = block.bbox
      if (!(x1 > x0 && y1 > y0)) continue
      const boxWidth = ((x1 - x0) / 1000) * width
      const boxHeight = ((y1 - y0) / 1000) * height
      if (boxWidth < 3 || boxHeight < 3) continue
      const node = document.createElement('div')
      node.className = 'pdf-block-text'
      node.dataset.blockId = block.id
      node.dataset.page = String(page)
      node.style.left = `${x0 / 10}%`
      node.style.top = `${y0 / 10}%`
      node.style.width = `${(x1 - x0) / 10}%`
      node.style.height = `${(y1 - y0) / 10}%`
      node.style.fontSize = `${estimateBlockFontSize(text, boxWidth, boxHeight)}px`
      node.textContent = text
      layer.append(node)
    }
  }

  private onScroll(): void {
    if (this.scrollFrame) return
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0
      if (!this.shells.length) return
      const top = this.options.scroll.scrollTop + Math.min(260, this.options.scroll.clientHeight * 0.35)
      let page = 1
      for (let index = 0; index < this.shells.length; index += 1) {
        if (this.shells[index]!.offsetTop <= top) page = index + 1
        else break
      }
      this.setCurrent(page)
    })
  }

  private setCurrent(page: number): void {
    if (page === this.currentPage) return
    this.currentPage = page
    this.options.onPageChange?.(page)
  }

  private highlight(page: number, blocks: Block[], blockIds: string[]): void {
    const shell = this.shells[page - 1]
    const overlay = shell?.querySelector<HTMLElement>('.pdf-highlight-layer')
    if (!overlay) return
    overlay.replaceChildren()
    const wanted = new Set(blockIds.filter(Boolean))
    let selected = wanted.size > 0 ? blocks.filter((block) => wanted.has(block.id)) : []
    if (selected.length === 0) {
      const first = blocks.find((block) => block.bbox[2] > block.bbox[0] && block.bbox[3] > block.bbox[1])
      if (first) selected = [first]
    }
    for (const block of selected.slice(0, 20)) {
      const [x0, y0, x1, y1] = block.bbox
      if (!(x1 > x0 && y1 > y0)) continue
      const node = document.createElement('div')
      node.className = 'pdf-highlight'
      node.style.left = `${x0 / 10}%`
      node.style.top = `${y0 / 10}%`
      node.style.width = `${(x1 - x0) / 10}%`
      node.style.height = `${(y1 - y0) / 10}%`
      node.title = block.text.slice(0, 120)
      overlay.append(node)
    }
    if (selected.length === 0) this.options.onError?.(new Error('没有可高亮的内容块。'))
    else setTimeout(() => shell?.scrollIntoView({ block: 'start', behavior: 'auto' }), 30)
  }
}

/** Fit a block's text into its bbox well enough to keep the selectable area aligned. */
function estimateBlockFontSize(text: string, width: number, height: number): number {
  const length = Math.max(1, text.replace(/\s+/g, ' ').length)
  const areaFit = Math.sqrt((width * height) / (0.62 * length))
  const heightFit = height * 0.7
  return Math.max(6, Math.min(18, Math.min(areaFit, heightFit)))
}

function normalizeSelectionText(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}
