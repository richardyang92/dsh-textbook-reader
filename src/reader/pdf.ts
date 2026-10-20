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

let pdfjsPromise: Promise<any> | undefined

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
    this.rendered.clear()
    this.dataCache.clear()
    this.shells = []
    this.options.pages.replaceChildren()
    this.options.loading.classList.remove('hidden')
    this.options.loading.textContent = '正在加载 PDF…'
    this.options.onStatus?.('加载 PDF…')

    const pdfjs = await loadPdfjs()
    const doc = await pdfjs.getDocument({
      url,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONTS_URL,
    }).promise
    if (this.destroyed) {
      await doc.destroy().catch(() => {})
      return
    }
    this.doc = doc

    const first = await doc.getPage(1)
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
  }

  destroy(): void {
    this.destroyed = true
    this.renderGeneration += 1
    this.observer?.disconnect()
    this.observer = undefined
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    if (this.scrollHandler) this.options.scroll.removeEventListener('scroll', this.scrollHandler)
    this.scrollHandler = undefined
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame)
    this.scrollFrame = 0
    const doc = this.doc
    this.doc = undefined
    if (doc) void doc.destroy().catch(() => {})
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
      const overlay = document.createElement('div')
      overlay.className = 'pdf-highlight-layer'
      const pending = document.createElement('div')
      pending.className = 'pdf-page-pending'
      pending.textContent = `第 ${page} 页`
      sheet.append(canvas, overlay, pending)
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
    } catch (error) {
      this.rendered.delete(page)
      const pending = shell.querySelector<HTMLElement>('.pdf-page-pending')
      if (pending) pending.textContent = '这一页渲染失败'
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
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
