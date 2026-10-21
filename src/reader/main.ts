/**
 * Standalone textbook reader (browser half inside the plugin iframe).
 *
 * The host half owns storage, MinerU and routes. This app renders the library,
 * the pdf.js page surface, the editable chapter tree and persisted learning
 * progress. It also accepts citation jump messages from the DSH client half.
 */

import {
  API,
  ApiError,
  api,
  formatBytes,
  statusText,
  type Block,
  type Book,
  type BookSummary,
  type ConfigPayload,
  type PageData,
  type Progress,
  type Question,
  type Tree,
  type TreeNode,
} from './api.js'
import { PdfViewer, type PdfSelection } from './pdf.js'

/** Prompt prefilled when the user asks about the current PDF selection. */
const SELECTION_PROMPT =
  '解释选中的这段内容：先引用原文，再逐句解释关键词和它在上下文里的作用，最后用一个问题检查我是否理解。'

interface State {
  books: BookSummary[]
  activeId: string | null
  config: ConfigPayload | null
  book: Book | null
  tree: Tree | null
  progress: Progress | null
  viewer: PdfViewer
  currentPage: number
  opening: boolean
  embedded: boolean
  selection: PdfSelection | null
  selectionTimer: number | null
  parseTimer: number | null
  pageSaveTimer: number | null
  bannerTimer: number | null
  saveQueue: Promise<void>
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`reader: missing #${id}`)
  return node as T
}

const state: State = {
  books: [],
  activeId: null,
  config: null,
  book: null,
  tree: null,
  progress: null,
  viewer: undefined as unknown as PdfViewer,
  currentPage: 1,
  opening: false,
  embedded: window.parent !== window,
  selection: null,
  selectionTimer: null,
  parseTimer: null,
  pageSaveTimer: null,
  bannerTimer: null,
  saveQueue: Promise.resolve(),
}

function createViewer(): PdfViewer {
  return new PdfViewer({
    scroll: $('pdf-scroll'),
    pages: $('pdf-pages'),
    loading: $('pdf-loading'),
    onPageChange: (page) => handleViewerPage(page),
    onStatus: (text) => {
      $('pdf-status').textContent = text
    },
    onError: (error) => {
      console.warn('[textbook-reader] pdf/view error:', error.message)
      $('pdf-status').textContent = error.message
    },
    getPageData: async (page) => {
      if (!state.book) return null
      try {
        const data = await api<{ page: PageData }>(`/api/books/${state.book.id}/pages/${page}`)
        return data.page
      } catch {
        return null
      }
    },
  })
}

function showBanner(message: string, kind: 'ok' | 'error' | '' = '', timeoutMs = 0): void {
  const banner = $('banner')
  if (state.bannerTimer !== null) {
    clearTimeout(state.bannerTimer)
    state.bannerTimer = null
  }
  if (!message) {
    banner.className = 'banner hidden'
    banner.textContent = ''
    return
  }
  banner.className = `banner${kind ? ` ${kind}` : ''}`
  banner.textContent = message
  if (timeoutMs > 0) {
    state.bannerTimer = window.setTimeout(() => {
      banner.className = 'banner hidden'
      banner.textContent = ''
      state.bannerTimer = null
    }, timeoutMs)
  }
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const hint = error instanceof ApiError && error.hint ? `\n${error.hint}` : ''
  showBanner(message + hint, 'error')
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// ── Library ────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<void> {
  try {
    const config = await api<ConfigPayload>('/api/config')
    state.config = config
    renderConfig()
  } catch (error) {
    showError(error)
  }
}

function renderConfig(): void {
  const config = state.config
  if (!config) return
  const token = config.token
  $('token-status').textContent = token.configured
    ? `已配置（${token.mask}）`
    : '未配置：解析会明确报错，不会静默失败'
  const ocr = $('ocr') as HTMLInputElement
  const table = $('table') as HTMLInputElement
  ocr.checked = config.settings.mineru.isOcr
  table.checked = config.settings.mineru.enableTable
  const caption = document.getElementById('caption-vlm') as HTMLInputElement | null
  if (caption) caption.checked = config.settings.captionVlm.enabled
}

async function saveToken(): Promise<void> {
  const input = $('token') as HTMLInputElement
  const token = input.value.trim()
  if (!token) {
    showBanner('请先粘贴 token。', 'error')
    return
  }
  try {
    state.config = await api<ConfigPayload>('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    input.value = ''
    renderConfig()
    showBanner('token 已保存（0600），界面只显示掩码。', 'ok', 4500)
  } catch (error) {
    showError(error)
  }
}

async function clearToken(): Promise<void> {
  if (!window.confirm('清除本机保存的 MinerU token？')) return
  try {
    state.config = await api<ConfigPayload>('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clearToken: true }),
    })
    renderConfig()
    showBanner('token 已清除。', 'ok', 3500)
  } catch (error) {
    showError(error)
  }
}

async function saveOptions(): Promise<void> {
  try {
    state.config = await api<ConfigPayload>('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: {
          mineru: {
            isOcr: ($('ocr') as HTMLInputElement).checked,
            enableTable: ($('table') as HTMLInputElement).checked,
          },
        },
      }),
    })
    renderConfig()
    showBanner('解析选项已保存。', 'ok', 3500)
  } catch (error) {
    showError(error)
  }
}

async function loadBooks(): Promise<void> {
  try {
    const data = await api<{ books: BookSummary[]; activeBookId: string | null }>('/api/books')
    state.books = data.books
    state.activeId = data.activeBookId
    renderBooks()
  } catch (error) {
    showError(error)
  }
}

function renderBooks(): void {
  const host = $('books')
  host.replaceChildren()
  $('empty').classList.toggle('hidden', state.books.length > 0)
  for (const book of state.books) {
    const card = el('button', 'card')
    card.type = 'button'
    card.addEventListener('click', () => void openBook(book.id))
    const titleRow = el('div', 'card-title-row')
    titleRow.append(el('div', 'card-title', book.title))
    if (book.active) titleRow.append(el('span', 'pill', '当前'))
    card.append(titleRow)
    const meta = el('div', 'card-meta')
    meta.append(el('span', '', `${book.pages} 页`))
    meta.append(el('span', '', formatBytes(book.bytes)))
    const parse = el('span', `pill${book.parseStatus === 'done' ? ' ok' : ''}`, statusText(book.parseStatus))
    meta.append(parse)
    card.append(meta)
    const bar = el('div', 'bar')
    const fill = el('i')
    fill.style.width = `${Math.max(0, Math.min(100, book.pagePercent || 0))}%`
    bar.append(fill)
    card.append(bar)
    const foot = el('div', 'card-meta')
    foot.append(el('span', '', `读至第 ${book.currentPage} 页`))
    foot.append(el('span', '', `已读章节 ${book.readChapterCount}`))
    card.append(foot)
    host.append(card)
  }
}

async function uploadFile(file: File): Promise<void> {
  const button = $('upload') as HTMLButtonElement
  button.disabled = true
  button.textContent = '导入中…'
  try {
    const response = await fetch(`${API}/api/books`, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-file-name': encodeURIComponent(file.name),
        'x-book-title': encodeURIComponent(file.name.replace(/\.pdf$/i, '')),
      },
      body: file,
    })
    const payload = await response.json().catch(() => null) as any
    if (!response.ok || !payload || payload.ok === false) {
      const error = payload?.error ?? {}
      throw new ApiError(response.status, error.code ?? 'upload_failed', error.message ?? `上传失败（HTTP ${response.status}）`, error.hint)
    }
    await loadBooks()
    if (payload.book?.id) {
      showBanner(payload.duplicate ? '这本书已存在，已打开现有副本。' : 'PDF 已导入。', 'ok', 3500)
      await openBook(payload.book.id)
    }
  } catch (error) {
    showError(error)
  } finally {
    button.disabled = false
    button.textContent = '上传 PDF'
    const input = $('file') as HTMLInputElement
    input.value = ''
  }
}

// ── Reader shell ───────────────────────────────────────────────────────────

function setLibraryVisible(visible: boolean): void {
  $('library-view').classList.toggle('hidden', !visible)
  $('reader-view').classList.toggle('hidden', visible)
  $('back-to-library').classList.toggle('hidden', visible)
}

/** Embedded split view: the side panel is an overlay drawer, closed by default. */
function setSideOpen(open: boolean): void {
  document.querySelector('.reader-side')?.classList.toggle('open', open)
  $('side-backdrop').classList.toggle('hidden', !open)
  if (open) window.requestAnimationFrame(() => updateTreeCurrent())
}

async function openBook(id: string, options: { page?: number; blocks?: string[] } = {}): Promise<void> {
  try {
    state.opening = true
    clearReaderSelection({ post: false })
    stopParsePolling()
    if (state.pageSaveTimer !== null) {
      clearTimeout(state.pageSaveTimer)
      state.pageSaveTimer = null
    }
    $('global-status').textContent = '打开教材…'
    const detail = await api<{ book: Book; progress: Progress; summary: BookSummary }>(`/api/books/${encodeURIComponent(id)}`)
    state.book = detail.book
    state.progress = detail.progress
    state.tree = null
    state.currentPage = options.page ?? detail.progress.currentPage ?? 1
    void api('/api/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookId: id }),
    }).catch(() => {})

    setLibraryVisible(false)
    setSideOpen(false)
    $('book-title').textContent = detail.book.title
    $('book-pages').textContent = `${detail.book.pages} 页`
    $('book-size').textContent = formatBytes(detail.book.bytes)
    $('page-total').textContent = String(detail.book.pages)
    const pageInput = $('page-input') as HTMLInputElement
    pageInput.max = String(detail.book.pages)
    pageInput.value = String(state.currentPage)
    renderParse(detail.book)
    renderProgress()
    updateUrl({ book: id })

    const viewer = state.viewer
    await viewer.load(`${API}/api/books/${encodeURIComponent(id)}/pdf`)
    const treeData = await api<{ tree: Tree | null; parseStatus: string }>(`/api/books/${encodeURIComponent(id)}/tree`)
    state.tree = treeData.tree
    renderTree()
    renderMastery()
    const target = Math.max(1, Math.min(detail.book.pages, options.page ?? detail.progress.currentPage ?? 1))
    state.currentPage = target
    pageInput.value = String(target)
    await viewer.goto(target, options.blocks ?? [], !(options.blocks && options.blocks.length))
    $('zoom-label').textContent = viewer.zoomLabel
    state.opening = false
    $('global-status').textContent = ''
    postContext()
    if (detail.book.parse.status === 'done') {
      showBanner('', '')
    }
    if (['preparing', 'uploading', 'polling', 'downloading', 'normalizing'].includes(detail.book.parse.status)) {
      startParsePolling()
    }
  } catch (error) {
    state.opening = false
    $('global-status').textContent = ''
    showError(error)
  }
}

function showLibrary(): void {
  stopParsePolling()
  clearReaderSelection({ post: false })
  if (state.pageSaveTimer !== null) {
    clearTimeout(state.pageSaveTimer)
    state.pageSaveTimer = null
  }
  state.book = null
  state.tree = null
  state.progress = null
  state.viewer.destroy()
  postContext()
  setLibraryVisible(true)
  setSideOpen(false)
  updateUrl({})
  void loadBooks()
  void loadConfig()
}

function updateUrl(params: { book?: string; page?: number; block?: string }): void {
  const url = new URL(window.location.href)
  for (const key of ['book', 'page', 'block']) url.searchParams.delete(key)
  if (params.book) url.searchParams.set('book', params.book)
  if (params.page) url.searchParams.set('page', String(params.page))
  if (params.block) url.searchParams.set('block', params.block)
  history.replaceState(null, '', url)
}

function handleViewerPage(page: number): void {
  if (!state.book) return
  state.currentPage = page
  const input = $('page-input') as HTMLInputElement
  if (document.activeElement !== input) input.value = String(page)
  $('page-total').textContent = String(state.book.pages)
  if (!state.opening) schedulePageSave()
  renderProgressSummary()
  postContext()
  updateTreeCurrent()
}

/** Publish the reading position to the hosting client panel. */
function postContext(): void {
  if (!state.embedded) return
  if (!state.book) {
    window.parent.postMessage({ type: 'tbr:context', context: null }, '*')
    return
  }
  const node = currentSection(state.currentPage)
  window.parent.postMessage(
    {
      type: 'tbr:context',
      context: {
        bookId: state.book.id,
        bookTitle: state.book.title,
        page: state.currentPage,
        pageCount: state.book.pages,
        ...(node ? { nodeId: node.id, nodeTitle: node.title } : {}),
        ...(state.selection ? { selection: state.selection } : {}),
      },
    },
    '*',
  )
}

function scheduleSelectionRefresh(delay = 120): void {
  if (state.selectionTimer !== null) clearTimeout(state.selectionTimer)
  state.selectionTimer = window.setTimeout(() => {
    state.selectionTimer = null
    refreshSelection()
  }, delay)
}

/**
 * Keep the last explicitly committed PDF selection. A collapsed browser
 * selection (e.g. after clicking into the chat input) only hides the floating
 * toolbar; it must not silently drop the text the user already sent to chat.
 */
function refreshSelection(): void {
  if (state.selectionTimer !== null) {
    clearTimeout(state.selectionTimer)
    state.selectionTimer = null
  }
  if (!state.book || !state.embedded) {
    hideSelectionToolbar()
    return
  }
  const live = state.viewer.getSelection()
  if (!live) {
    hideSelectionToolbar()
    return
  }
  if (!sameSelection(live, state.selection)) {
    state.selection = live
    postContext()
  }
  showSelectionToolbar(live)
}

function showSelectionToolbar(selection: PdfSelection): void {
  if (!state.embedded) return
  const toolbar = $('selection-toolbar')
  $('selection-summary').textContent = `已选中 ${selection.text.length} 字`
  toolbar.classList.remove('hidden')
  const current = window.getSelection()
  const range = current && current.rangeCount > 0 ? current.getRangeAt(0) : undefined
  const rects = range ? Array.from(range.getClientRects()) : []
  const rect = rects.length > 0 ? rects[rects.length - 1]! : range?.getBoundingClientRect()
  const width = toolbar.offsetWidth || 200
  const height = toolbar.offsetHeight || 34
  const left = rect ? rect.left : 20
  const top = rect ? rect.bottom + 8 : 60
  toolbar.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, left))}px`
  toolbar.style.top = `${Math.min(window.innerHeight - height - 8, Math.max(8, top))}px`
}

function hideSelectionToolbar(): void {
  $('selection-toolbar').classList.add('hidden')
}

/** Explicitly drop the committed selection, in the reader and the chat panel. */
function clearReaderSelection(options: { post?: boolean; removeDom?: boolean } = {}): void {
  if (state.selectionTimer !== null) {
    clearTimeout(state.selectionTimer)
    state.selectionTimer = null
  }
  state.selection = null
  hideSelectionToolbar()
  if (options.removeDom !== false) window.getSelection()?.removeAllRanges()
  if (options.post !== false) postContext()
}

function sameSelection(left: PdfSelection | null, right: PdfSelection | null): boolean {
  if (!left || !right) return left === right
  return (
    left.text === right.text &&
    left.page === right.page &&
    left.pageFrom === right.pageFrom &&
    left.pageTo === right.pageTo &&
    left.blockIds.join(',') === right.blockIds.join(',')
  )
}

function currentSection(page: number): TreeNode | undefined {
  const tree = state.tree
  if (!tree) return undefined
  const section = tree.nodes.find(
    (node) => node.level === 2 && page >= node.pageStart && page <= node.pageEnd,
  )
  if (section) return section
  return tree.nodes.find((node) => node.level === 1 && page >= node.pageStart && page <= node.pageEnd)
}

function schedulePageSave(): void {
  if (state.pageSaveTimer !== null) clearTimeout(state.pageSaveTimer)
  state.pageSaveTimer = window.setTimeout(() => {
    state.pageSaveTimer = null
    void saveProgress(false)
  }, 700)
}

async function saveProgress(announce: boolean): Promise<void> {
  if (!state.book || !state.progress) return
  const book = state.book
  const progress: Progress = { ...state.progress, currentPage: state.currentPage }
  state.progress = progress
  const task = state.saveQueue.then(async () => {
    try {
      const data = await api<{ progress: Progress }>(`/api/books/${encodeURIComponent(book.id)}/progress`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(progress),
      })
      if (state.book?.id === book.id) {
        state.progress = { ...data.progress, currentPage: state.currentPage }
        renderProgressSummary()
      }
      if (announce) showBanner('学习进度已保存。', 'ok', 3000)
    } catch (error) {
      showError(error)
    }
  })
  state.saveQueue = task.catch(() => {})
  await task
}

function flushProgress(): void {
  if (!state.book || !state.progress) return
  const progress = { ...state.progress, currentPage: state.currentPage }
  void fetch(`${API}/api/books/${encodeURIComponent(state.book.id)}/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(progress),
    keepalive: true,
  }).catch(() => {})
}

// ── Tree ───────────────────────────────────────────────────────────────────

function renderTree(): void {
  const host = $('tree')
  host.replaceChildren()
  const tree = state.tree
  const empty = $('tree-empty')
  if (!tree || tree.nodes.length === 0) {
    const done = state.book?.parse.status === 'done'
    empty.textContent = done ? '解析完成但没有识别到章节标题。' : '尚未解析：先配置 token 并开始解析。'
    empty.classList.remove('hidden')
    $('tree-count').textContent = ''
    return
  }
  empty.classList.add('hidden')
  const chapters = tree.nodes.filter((node) => node.level === 1).sort((a, b) => a.pageStart - b.pageStart)
  const sections = tree.nodes.filter((node) => node.level === 2)
  $('tree-count').textContent = `${chapters.length} 章 · ${sections.length} 节`
  const currentId = currentSection(state.currentPage)?.id
  for (const [chapterIndex, chapter] of chapters.entries()) {
    host.append(treeRow(chapter, chapterIndex, currentId, true))
    for (const childId of chapter.children) {
      const child = tree.nodes.find((node) => node.id === childId)
      if (child) host.append(treeRow(child, chapterIndex, currentId, false))
    }
  }
  updateTreeCurrent()
}

/** Highlight and reveal the node that contains the page currently being read. */
function updateTreeCurrent(): void {
  const host = $('tree')
  const currentId = currentSection(state.currentPage)?.id
  const side = document.querySelector('.reader-side')
  const visible = !state.embedded || side?.classList.contains('open') === true
  for (const row of host.querySelectorAll<HTMLElement>('.tree-row')) {
    const on = currentId !== undefined && row.dataset.nodeId === currentId
    row.classList.toggle('current', on)
    if (on && visible) row.scrollIntoView({ block: 'nearest' })
  }
}

function treeRow(
  node: TreeNode,
  chapterIndex: number,
  currentId: string | undefined,
  isChapter: boolean,
): HTMLElement {
  const row = el('div', `tree-row${isChapter ? ' chapter' : ' section'}`)
  row.dataset.nodeId = node.id
  if (node.id === currentId) row.classList.add('current')

  const main = el('button', 'tree-main')
  main.type = 'button'
  main.title = `${node.title}（第 ${node.pageStart}–${node.pageEnd} 页）`
  main.append(el('span', 'tree-title', node.title), el('span', 'tree-page', `p.${node.pageStart}`))
  main.addEventListener('click', () => void jumpToPage(node.pageStart))
  row.append(main)

  const actions = el('div', 'tree-actions')
  const rename = el('button', '', '改名')
  rename.type = 'button'
  rename.title = '重命名'
  rename.addEventListener('click', (event) => {
    event.stopPropagation()
    const title = window.prompt('重命名章节', node.title)
    if (title === null) return
    void treeOp({ op: 'rename', nodeId: node.id, title })
  })
  actions.append(rename)

  const merge = el('button', '', '合并')
  merge.type = 'button'
  merge.title = isChapter ? '合并到上一章' : '合并到上一节/所在章'
  if (isChapter && chapterIndex === 0) merge.disabled = true
  merge.addEventListener('click', (event) => {
    event.stopPropagation()
    if (!window.confirm(`把「${node.title}」合并到上一节点？页码与子节点会合并，节点会消失。`)) return
    void treeOp({ op: 'merge', nodeId: node.id })
  })
  actions.append(merge)

  const level = el('button', '', isChapter ? '降为节' : '升为章')
  level.type = 'button'
  level.title = isChapter ? '纠正为节（挂到上一章）' : '纠正为章'
  if (isChapter && chapterIndex === 0) level.disabled = true
  level.addEventListener('click', (event) => {
    event.stopPropagation()
    const target = isChapter ? 2 : 1
    if (!window.confirm(`把「${node.title}」${isChapter ? '降为节' : '升为章'}？`)) return
    void treeOp({ op: 'relevel', nodeId: node.id, level: target })
  })
  actions.append(level)
  row.append(actions)
  return row
}

async function treeOp(body: Record<string, unknown>): Promise<void> {
  if (!state.book) return
  try {
    const data = await api<{ tree: Tree }>(`/api/books/${encodeURIComponent(state.book.id)}/tree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    state.tree = data.tree
    renderTree()
    showBanner('章节树已更新。', 'ok', 3000)
  } catch (error) {
    showError(error)
  }
}

// ── Progress / questions ───────────────────────────────────────────────────

function renderProgress(): void {
  renderProgressSummary()
  renderMastery()
  renderQuestions()
}

function renderProgressSummary(): void {
  const progress = state.progress
  if (!progress) {
    $('progress-summary').textContent = ''
    return
  }
  const masteryCount = Object.values(progress.mastery).filter((entry) => entry.level > 0).length
  $('progress-summary').textContent =
    `当前第 ${state.currentPage} 页 · 已读 ${progress.readChapters.length} 个章节 · 已评掌握度 ${masteryCount} 章`
}

function renderMastery(): void {
  const host = $('mastery-list')
  host.replaceChildren()
  if (!state.tree || !state.progress) return
  const chapters = state.tree.nodes.filter((node) => node.level === 1).sort((a, b) => a.pageStart - b.pageStart)
  if (chapters.length === 0) {
    host.append(el('div', 'muted small', '还没有章节树。'))
    return
  }
  for (const chapter of chapters) {
    const row = el('div', 'mastery-row')
    row.append(el('span', 'mastery-title', chapter.title))
    const select = document.createElement('select')
    select.title = '掌握度自评'
    for (let level = 0; level <= 5; level += 1) {
      const option = document.createElement('option')
      option.value = String(level)
      option.textContent = ['未评', '陌生', '初步', '熟悉', '掌握', '精通'][level]!
      select.append(option)
    }
    select.value = String(state.progress.mastery[chapter.id]?.level ?? 0)
    select.addEventListener('change', () => {
      if (!state.progress) return
      state.progress.mastery[chapter.id] = {
        level: Number(select.value),
        updatedAt: new Date().toISOString(),
      }
      renderProgressSummary()
      void saveProgress(false)
    })
    row.append(select)
    host.append(row)
  }
}

function renderQuestions(): void {
  const host = $('question-list')
  host.replaceChildren()
  if (!state.progress) return
  const questions = [...state.progress.questions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (questions.length === 0) {
    host.append(el('div', 'muted small', '还没有疑问。读到哪里卡住，就记一条。'))
    return
  }
  for (const question of questions) {
    const row = el('div', `question-row${question.status === 'resolved' ? ' resolved' : ''}`)
    const text = el('div', 'question-text', question.text)
    if (question.page) text.append(el('span', 'question-page', `p.${question.page}`))
    row.append(text)
    const actions = el('div', 'question-actions')
    const toggle = el('button', '', question.status === 'resolved' ? '重开' : '解决')
    toggle.type = 'button'
    toggle.addEventListener('click', () => {
      if (!state.progress) return
      question.status = question.status === 'resolved' ? 'open' : 'resolved'
      renderQuestions()
      renderProgressSummary()
      void saveProgress(false)
    })
    const remove = el('button', '', '删除')
    remove.type = 'button'
    remove.addEventListener('click', () => {
      if (!state.progress) return
      state.progress.questions = state.progress.questions.filter((item) => item.id !== question.id)
      renderQuestions()
      renderProgressSummary()
      void saveProgress(false)
    })
    actions.append(toggle, remove)
    row.append(actions)
    host.append(row)
  }
}

function addQuestion(): void {
  if (!state.progress) return
  const input = $('question-input') as HTMLInputElement
  const text = input.value.trim()
  if (!text) return
  const chapter = state.tree?.nodes
    .filter((node) => node.level === 1)
    .find((node) => state.currentPage >= node.pageStart && state.currentPage <= node.pageEnd)
  const question: Question = {
    id: `q-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    text: text.slice(0, 500),
    ...(chapter ? { nodeId: chapter.id } : {}),
    page: state.currentPage,
    status: 'open',
    createdAt: new Date().toISOString(),
  }
  state.progress.questions.push(question)
  input.value = ''
  renderQuestions()
  renderProgressSummary()
  void saveProgress(false)
}

// ── Parse ──────────────────────────────────────────────────────────────────

function renderParse(book: Book): void {
  const parse = book.parse
  const running = ['preparing', 'uploading', 'polling', 'downloading', 'normalizing'].includes(parse.status)
  const done = parse.status === 'done'
  const button = $('parse') as HTMLButtonElement
  button.disabled = running || done
  button.textContent = running ? '解析中…' : done ? '已解析' : parse.status === 'failed' ? '重试解析' : '开始解析'
  const progressText = typeof parse.progress === 'number' ? ` ${parse.progress}%` : ''
  $('parse-status').textContent = statusText(parse.status) + progressText
  const pill = $('parse-pill')
  pill.textContent = statusText(parse.status)
  pill.className = `pill${done ? ' ok' : parse.status === 'failed' ? ' err' : ''}`
  const row = button.closest('.reader-parse-row') as HTMLElement | null
  row?.classList.toggle('hidden', done)
  const box = $('parse-error')
  if (parse.error) {
    box.className = 'banner error'
    box.textContent = parse.error.message + (parse.error.hint ? `\n${parse.error.hint}` : '')
  } else {
    // Segment warnings are diagnostic noise for a finished book; keep the
    // sidebar focused on reading.
    box.className = 'banner error hidden'
    box.textContent = ''
  }
  if (running) startParsePolling()
}

async function startParse(): Promise<void> {
  if (!state.book) return
  const button = $('parse') as HTMLButtonElement
  button.disabled = true
  try {
    const data = await api<{ parse: Book['parse']; started: boolean }>(
      `/api/books/${encodeURIComponent(state.book.id)}/parse`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
    if (!state.book) return
    state.book.parse = data.parse
    renderParse(state.book)
    if (data.started) {
      showBanner('已提交 MinerU 解析。解析期间可以继续阅读 PDF。', 'ok', 4500)
      startParsePolling()
    } else {
      showBanner('这本书已有解析状态，无需重复提交。', 'ok', 3500)
    }
  } catch (error) {
    button.disabled = false
    button.textContent = '开始解析'
    showError(error)
  }
}

function startParsePolling(): void {
  if (state.parseTimer !== null) return
  state.parseTimer = window.setInterval(() => {
    void (async () => {
      if (!state.book) {
        stopParsePolling()
        return
      }
      try {
        const data = await api<{ parse: Book['parse'] }>(`/api/books/${encodeURIComponent(state.book.id)}/parse`)
        if (!state.book) return
        state.book.parse = data.parse
        renderParse(state.book)
        if (['done', 'failed', 'interrupted', 'none'].includes(data.parse.status)) {
          stopParsePolling()
          if (!state.book) return
          if (data.parse.status === 'done') {
            await loadTree()
            clearReaderSelection({ post: false })
            state.viewer.clearPageData()
            await loadBooks()
            postContext()
            showBanner('MinerU 解析完成，章节树已更新。', 'ok', 5000)
          }
        }
      } catch (error) {
        stopParsePolling()
        showError(error)
      }
    })()
  }, 2000)
}

function stopParsePolling(): void {
  if (state.parseTimer !== null) {
    clearInterval(state.parseTimer)
    state.parseTimer = null
  }
}

async function loadTree(): Promise<void> {
  if (!state.book) return
  try {
    const data = await api<{ tree: Tree | null }>(`/api/books/${encodeURIComponent(state.book.id)}/tree`)
    state.tree = data.tree
    renderTree()
    renderMastery()
  } catch (error) {
    showError(error)
  }
}

// ── PDF navigation ─────────────────────────────────────────────────────────

async function jumpToPage(page: number, blocks: string[] = []): Promise<void> {
  if (!state.book || !state.viewer.pageCount) return
  const target = Math.max(1, Math.min(state.viewer.pageCount, Math.trunc(page) || 1))
  state.opening = true
  await state.viewer.goto(target, blocks, blocks.length === 0)
  state.currentPage = target
  const input = $('page-input') as HTMLInputElement
  input.value = String(target)
  state.opening = false
  schedulePageSave()
  postContext()
  updateTreeCurrent()
  setSideOpen(false)
}

function bindEvents(): void {
  $('toggle-side').addEventListener('click', () => {
    const open = document.querySelector('.reader-side')?.classList.contains('open') ?? false
    setSideOpen(!open)
  })
  $('side-backdrop').addEventListener('click', () => setSideOpen(false))
  $('refresh').addEventListener('click', () => {
    if (state.book) {
      const bookId = state.book.id
      const page = state.currentPage
      void openBook(bookId, { page })
    } else {
      void loadBooks()
      void loadConfig()
    }
  })
  $('upload').addEventListener('click', () => ($('file') as HTMLInputElement).click())
  $('file').addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) void uploadFile(file)
  })
  $('save-token').addEventListener('click', () => void saveToken())
  $('clear-token').addEventListener('click', () => void clearToken())
  $('save-options').addEventListener('click', () => void saveOptions())
  $('back-to-library').addEventListener('click', () => showLibrary())
  $('back-to-chat').addEventListener('click', () => {
    if (state.embedded) window.parent.postMessage({ type: 'tbr:back' }, '*')
  })
  $('chat-toggle').addEventListener('click', () => {
    if (state.embedded) window.parent.postMessage({ type: 'tbr:chat-open' }, '*')
  })
  $('parse').addEventListener('click', () => void startParse())
  $('question-add').addEventListener('click', () => addQuestion())
  $('question-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addQuestion()
  })
  $('prev-page').addEventListener('click', () => void jumpToPage(state.currentPage - 1))
  $('next-page').addEventListener('click', () => void jumpToPage(state.currentPage + 1))
  $('page-input').addEventListener('change', () => {
    const value = Number(($('page-input') as HTMLInputElement).value)
    if (Number.isInteger(value)) void jumpToPage(value)
  })
  $('zoom-in').addEventListener('click', () => {
    clearReaderSelection({ post: false })
    state.viewer.zoomBy(0.15)
    $('zoom-label').textContent = state.viewer.zoomLabel
  })
  $('zoom-out').addEventListener('click', () => {
    clearReaderSelection({ post: false })
    state.viewer.zoomBy(-0.15)
    $('zoom-label').textContent = state.viewer.zoomLabel
  })
  $('zoom-fit').addEventListener('click', () => {
    clearReaderSelection({ post: false })
    state.viewer.fit()
    $('zoom-label').textContent = state.viewer.zoomLabel
  })
  $('selection-toolbar').addEventListener('pointerdown', (event) => event.preventDefault())
  $('selection-ask').addEventListener('click', () => {
    if (!state.embedded || !state.selection) return
    window.parent.postMessage(
      { type: 'tbr:ask', prompt: SELECTION_PROMPT, selection: state.selection },
      '*',
    )
  })
  $('selection-clear').addEventListener('click', () => clearReaderSelection())
  $('pdf-scroll').addEventListener('scroll', () => hideSelectionToolbar(), { passive: true })
  document.addEventListener('selectionchange', () => scheduleSelectionRefresh(120))
  document.addEventListener('pointerup', () => scheduleSelectionRefresh(0))
  document.addEventListener('keyup', () => scheduleSelectionRefresh(0))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.selection) clearReaderSelection()
  })
  window.addEventListener('beforeunload', () => flushProgress())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushProgress()
  })
  window.addEventListener('message', (event) => {
    if (!state.embedded || event.source !== window.parent) return
    const data = event.data as Record<string, unknown> | null
    if (!data || typeof data !== 'object') return
    if (data.type === 'tbr:jump') {
      const book = typeof data.book === 'string' ? data.book : typeof data.bookId === 'string' ? data.bookId : ''
      const page = Number(data.page)
      const blocks = Array.isArray(data.blockIds)
        ? data.blockIds.filter((item): item is string => typeof item === 'string')
        : typeof data.block === 'string'
          ? data.block.split(',').map((item) => item.trim()).filter(Boolean)
          : []
      void (async () => {
        if (book && state.book?.id !== book) await openBook(book, { page, blocks })
        else if (state.book) await jumpToPage(page, blocks)
      })()
    } else if (data.type === 'tbr:open-library') {
      showLibrary()
    } else if (data.type === 'tbr:chat-state') {
      $('chat-toggle').classList.toggle('hidden', data.collapsed !== true)
    } else if (data.type === 'tbr:clear-selection') {
      clearReaderSelection()
    } else if (data.type === 'tbr:ping') {
      window.parent.postMessage({ type: 'tbr:ready' }, '*')
      postContext()
    }
  })
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  state.viewer = createViewer()
  $('back-to-chat').classList.add('hidden')
  $('back-to-library').classList.add('hidden')
  if (state.embedded) {
    document.querySelector('.app')?.classList.add('embedded')
    $('toggle-side').classList.remove('hidden')
  }
  bindEvents()
  setLibraryVisible(true)
  await Promise.all([loadConfig(), loadBooks()])
  if (state.embedded) window.parent.postMessage({ type: 'tbr:ready' }, '*')
  const params = new URL(window.location.href).searchParams
  const bookId = params.get('book')
  if (bookId) {
    const page = Number(params.get('page'))
    const blocks = (params.get('block') ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    await openBook(bookId, {
      ...(Number.isInteger(page) && page > 0 ? { page } : {}),
      ...(blocks.length ? { blocks } : {}),
    })
  }
}

boot().catch((error: unknown) => {
  console.error('[textbook-reader] boot failed:', error)
  showError(error)
})
