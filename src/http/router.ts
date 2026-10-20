/** HTTP surface for /textbook-reader: reader shell, config, books, PDF, progress. */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Book, BookSummary, NormalizedBook, Tree } from '../types.js'
import { AppError, badRequest, conflict, isAppError, notFound } from '../errors.js'
import type { DataPaths, SettingsPatch } from '../config.js'
import { ConfigStore, redactSecrets } from '../config.js'
import { MAX_PDF_BYTES } from '../pdf.js'
import { BookStore, assertBookId, sanitizeTitle } from '../store/books.js'
import { ProgressStore } from '../store/progress.js'
import { TreeStore } from '../store/tree.js'
import { ensureDir, pathExists, randomId, readJsonFile } from '../store/atomic.js'
import type { ParseManager } from '../mineru/job.js'
import type { TreeOperation } from '../tree/ops.js'
import { searchNormalized } from '../search.js'
import { createRequestGuard, type ConnectionFence } from './guard.js'
import {
  mimeType,
  readJsonBody,
  resolveStaticPath,
  sendError,
  sendHtml,
  sendJson,
  serveFile,
  setBaseHeaders,
  streamBodyToFile,
} from './http.js'

const PREFIX = '/textbook-reader'
const JSON_LIMIT = 1024 * 1024

export interface ReaderLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

export interface ReaderRouterOptions {
  paths: DataPaths
  config: ConfigStore
  books: BookStore
  progress: ProgressStore
  tree: TreeStore
  parser?: ParseManager
  readerRoot?: string
  connection?: ConnectionFence
  logger?: ReaderLogger
  trustedHosts?: readonly string[]
  maxUploadBytes?: number
}

/** Browser-facing router; the host registers it as one prefix route. */
export class ReaderRouter {
  readonly paths: DataPaths
  private readonly config: ConfigStore
  private readonly books: BookStore
  private readonly progress: ProgressStore
  private readonly tree: TreeStore
  private readonly parser: ParseManager | undefined
  private readonly readerRoot: string
  private guard: (req: IncomingMessage) => number | null
  private connection: ConnectionFence | undefined
  private readonly trustedHosts: readonly string[] | undefined
  private readonly logger: ReaderLogger
  private readonly maxUploadBytes: number

  constructor(options: ReaderRouterOptions) {
    this.paths = options.paths
    this.config = options.config
    this.books = options.books
    this.progress = options.progress
    this.tree = options.tree
    this.parser = options.parser
    this.readerRoot = options.readerRoot ?? join(packageRoot(), 'reader')
    this.connection = options.connection
    this.trustedHosts = options.trustedHosts ?? parseTrustedHosts()
    this.guard = createRequestGuard({
      ...(options.connection ? { connection: options.connection } : {}),
      trustedHosts: this.trustedHosts,
    })
    this.logger = options.logger ?? {}
    this.maxUploadBytes = options.maxUploadBytes ?? MAX_PDF_BYTES
  }

  /** Attach the host connection fence once the service is available. */
  attachConnection(connection: ConnectionFence | undefined): void {
    this.connection = connection
    this.guard = createRequestGuard({
      ...(connection ? { connection } : {}),
      trustedHosts: this.trustedHosts,
    })
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setBaseHeaders(res)
    try {
      const rejection = this.guard(req)
      if (rejection !== null) {
        sendJson(res, rejection, {
          ok: false,
          error: {
            code: rejection === 401 ? 'unauthorized' : 'forbidden',
            message: rejection === 401 ? '未认证的请求。' : '拒绝访问。',
          },
        })
        return
      }

      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://localhost')
      } catch {
        throw badRequest('请求 URL 不合法。')
      }
      const pathname = url.pathname
      if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
        throw notFound()
      }
      let sub = pathname.slice(PREFIX.length)
      if (!sub.startsWith('/')) sub = `/${sub}`
      await this.dispatch(req, res, url, sub)
    } catch (error) {
      this.logFailure(req, error)
      sendError(res, error)
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, url: URL, sub: string): Promise<void> {
    const method = String(req.method ?? 'GET').toUpperCase()
    const segments = splitPath(sub)

    if (segments.length === 0) {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, ['GET', 'HEAD'])
      return this.serveIndex(req, res)
    }

    if (segments[0] === 'assets' || segments[0] === 'vendor') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, ['GET', 'HEAD'])
      return this.serveStatic(req, res, sub)
    }

    if (segments[0] !== 'api') throw notFound()
    const section = segments[1]

    if (section === 'health' && segments.length === 2) {
      if (method !== 'GET') return methodNotAllowed(res, ['GET'])
      return sendJson(res, 200, { ok: true, service: 'dsh-textbook-reader', milestone: 'M1' })
    }

    if (section === 'config' && segments.length === 2) {
      if (method === 'GET') return this.getConfig(res)
      if (method === 'PUT') return this.putConfig(req, res)
      return methodNotAllowed(res, ['GET', 'PUT'])
    }

    if (section === 'active' && segments.length === 2) {
      if (method === 'GET') return this.getActive(res)
      if (method === 'PUT') return this.putActive(req, res)
      if (method === 'DELETE') {
        await this.books.clearActive()
        return sendJson(res, 200, { ok: true, bookId: null })
      }
      return methodNotAllowed(res, ['GET', 'PUT', 'DELETE'])
    }

    if (section === 'books') {
      if (segments.length === 2) {
        if (method === 'GET') return this.listBooks(res)
        if (method === 'POST') return this.addBook(req, res)
        return methodNotAllowed(res, ['GET', 'POST'])
      }
      const id = decodeSegment(segments[2])
      assertBookId(id)
      if (segments.length === 3) {
        if (method === 'GET') return this.getBook(res, id)
        if (method === 'DELETE') return this.deleteBook(req, res, url, id)
        return methodNotAllowed(res, ['GET', 'DELETE'])
      }
      if (segments.length === 4 && segments[3] === 'pdf') {
        if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, ['GET', 'HEAD'])
        return this.servePdf(req, res, id)
      }
      if (segments.length === 4 && segments[3] === 'progress') {
        if (method === 'GET') return this.getProgress(res, id)
        if (method === 'PUT') return this.putProgress(req, res, id)
        return methodNotAllowed(res, ['GET', 'PUT'])
      }
      if (segments.length === 4 && segments[3] === 'parse') {
        if (method === 'GET') return this.getParse(res, id)
        if (method === 'POST') return this.startParse(req, res, id)
        return methodNotAllowed(res, ['GET', 'POST'])
      }
      if (segments.length === 4 && segments[3] === 'search') {
        if (method !== 'GET') return methodNotAllowed(res, ['GET'])
        return this.searchBook(res, id, url)
      }
      if (segments.length === 4 && segments[3] === 'tree') {
        if (method === 'GET') return this.getTree(res, id)
        if (method === 'POST') return this.applyTreeOp(req, res, id)
        return methodNotAllowed(res, ['GET', 'POST'])
      }
      if (segments.length === 5 && segments[3] === 'pages') {
        if (method !== 'GET') return methodNotAllowed(res, ['GET'])
        return this.getPage(res, id, decodeSegment(segments[4]))
      }
      if (segments.length >= 5 && segments[3] === 'asset') {
        if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, ['GET', 'HEAD'])
        return this.serveAsset(req, res, id, segments.slice(4).map(decodeSegment).join('/'))
      }
    }

    throw notFound()
  }

  private async serveIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let html: string
    try {
      html = await readFile(join(this.readerRoot, 'index.html'), 'utf8')
    } catch {
      throw new AppError(500, 'reader_missing', '阅读器页面缺失，请重新构建插件。')
    }
    if (req.method === 'HEAD') {
      const body = Buffer.from(html, 'utf8')
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Content-Length', String(body.byteLength))
      res.setHeader('Cache-Control', 'no-store')
      res.end()
      return
    }
    sendHtml(res, html)
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse, sub: string): Promise<void> {
    if (!(await pathExists(this.readerRoot))) throw notFound()
    const file = resolveStaticPath(this.readerRoot, sub)
    await serveFile(req, res, file, {
      contentType: mimeType(file),
      cacheControl: 'public, max-age=0, must-revalidate',
    })
  }

  private async getConfig(res: ServerResponse): Promise<void> {
    await sendJson(res, 200, await this.configPayload())
  }

  private async configPayload(): Promise<unknown> {
    const settings = await this.config.readSettings()
    const token = await this.config.tokenStatus()
    return {
      ok: true,
      settings,
      token,
      capabilities: {
        mineru: true,
        captionVlm: false,
        captionVlmNote: 'MVP 未实现图注 VLM 描述；开关默认关闭，不会产生图片外发请求。',
      },
    }
  }

  private async putConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req, JSON_LIMIT)
    if (!isRecord(body)) throw badRequest('配置必须是对象。')
    const tokenValue = body.token
    const clearToken = body.clearToken === true
    if (typeof tokenValue === 'string' && clearToken) {
      throw badRequest('不能同时设置和清除 token。')
    }
    if (tokenValue !== undefined && typeof tokenValue !== 'string') {
      throw badRequest('token 必须是字符串。')
    }

    if (typeof tokenValue === 'string') {
      await this.config.writeToken(tokenValue)
    } else if (clearToken) {
      await this.config.clearToken()
    }

    if (body.settings !== undefined) {
      if (!isRecord(body.settings)) throw badRequest('settings 必须是对象。')
      await this.config.updateSettings(body.settings as SettingsPatch)
    }

    await sendJson(res, 200, await this.configPayload())
  }

  private async listBooks(res: ServerResponse): Promise<void> {
    await this.books.ensure()
    const [books, activeId] = await Promise.all([this.books.listBooks(), this.books.activeBookId()])
    const summaries = await Promise.all(books.map((book) => this.summarize(book, activeId)))
    sendJson(res, 200, { ok: true, books: summaries, activeBookId: activeId ?? null })
  }

  private async summarize(book: Book, activeId: string | undefined): Promise<BookSummary> {
    const progress = await this.progress.read(book.id, book.pages)
    const pages = Math.max(1, book.pages)
    return {
      id: book.id,
      title: book.title,
      pages: book.pages,
      bytes: book.bytes,
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
      parseStatus: book.parse.status,
      ...(typeof book.parse.progress === 'number' ? { parseProgress: book.parse.progress } : {}),
      currentPage: progress.currentPage,
      pagePercent: Math.round((progress.currentPage / pages) * 1000) / 10,
      readChapterCount: progress.readChapters.length,
      active: book.id === activeId,
    }
  }

  private async getBook(res: ServerResponse, id: string): Promise<void> {
    const [book, activeId] = await Promise.all([this.books.getBook(id), this.books.activeBookId()])
    const progress = await this.progress.read(id, book.pages)
    sendJson(res, 200, { ok: true, book, progress, summary: await this.summarize(book, activeId) })
  }

  private async addBook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (contentType.includes('application/json')) {
      const body = await readJsonBody(req, JSON_LIMIT)
      if (!isRecord(body) || typeof body.path !== 'string' || body.path.trim() === '') {
        throw badRequest('JSON 导入需要 path 字段。')
      }
      const source = expandHome(body.path.trim())
      const title = typeof body.title === 'string' ? sanitizeTitle(body.title) : undefined
      const result = await this.books.addFromFile(source, {
        ...(title ? { title } : {}),
        originalName: source.split(/[\\/]/).pop(),
      })
      await this.books.setActive(result.book.id)
      return sendJson(res, result.duplicate ? 200 : 201, {
        ok: true,
        book: result.book,
        duplicate: result.duplicate,
      })
    }

    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > this.maxUploadBytes) {
      throw new AppError(413, 'payload_too_large', 'PDF 超过 200 MB 上限。')
    }
    await ensureDir(this.paths.tmp, 0o700)
    const fileName = decodeHeaderValue(req.headers['x-file-name']) || 'upload.pdf'
    const title = decodeHeaderValue(req.headers['x-book-title'])
    const temp = join(this.paths.tmp, `upload-${randomId('u')}.pdf`)
    let bytes = 0
    try {
      bytes = await streamBodyToFile(req, temp, this.maxUploadBytes)
      if (bytes === 0) throw badRequest('上传内容为空。')
      const result = await this.books.addFromFile(temp, {
        ...(title ? { title } : {}),
        originalName: fileName,
      })
      await this.books.setActive(result.book.id)
      return sendJson(res, result.duplicate ? 200 : 201, {
        ok: true,
        book: result.book,
        duplicate: result.duplicate,
      })
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
  }

  private async deleteBook(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    id: string,
  ): Promise<void> {
    let confirmed = url.searchParams.get('confirm') === '1'
    if (!confirmed) {
      const body = await readJsonBody(req, JSON_LIMIT)
      confirmed = isRecord(body) && body.confirm === true
    }
    if (!confirmed) throw conflict('confirmation_required', '删除教材需要明确确认。')
    const previousActive = await this.books.activeBookId()
    const book = await this.books.deleteBook(id)
    if (previousActive === id) await this.books.clearActive()
    sendJson(res, 200, { ok: true, deleted: book.id, trashed: true })
  }

  private async servePdf(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const book = await this.books.getBook(id)
    const dir = this.books.bookDir(id)
    const file = resolve(dir, book.pdf)
    if (!file.startsWith(`${dir}${sep}`)) {
      throw new AppError(500, 'state_corrupt', '教材文件路径异常。')
    }
    res.setHeader('Content-Disposition', `inline; filename="textbook-${id}.pdf"`)
    await serveFile(req, res, file, {
      contentType: 'application/pdf',
      cacheControl: 'private, max-age=0, must-revalidate',
    })
  }

  private async getProgress(res: ServerResponse, id: string): Promise<void> {
    const book = await this.books.getBook(id)
    const progress = await this.progress.read(id, book.pages)
    sendJson(res, 200, { ok: true, progress })
  }

  private async putProgress(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const book = await this.books.getBook(id)
    const body = await readJsonBody(req, JSON_LIMIT)
    const progress = await this.progress.save(id, body, book.pages)
    sendJson(res, 200, { ok: true, progress })
  }

  private async getActive(res: ServerResponse): Promise<void> {
    const activeId = await this.books.activeBookId()
    sendJson(res, 200, { ok: true, bookId: activeId ?? null })
  }

  private async putActive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req, JSON_LIMIT)
    if (!isRecord(body)) throw badRequest('请求必须是对象。')
    if (body.bookId === null) {
      await this.books.clearActive()
      return sendJson(res, 200, { ok: true, bookId: null })
    }
    if (typeof body.bookId !== 'string') throw badRequest('bookId 必须是字符串或 null。')
    await this.books.setActive(body.bookId)
    sendJson(res, 200, { ok: true, bookId: body.bookId })
  }

  private async getParse(res: ServerResponse, id: string): Promise<void> {
    const book = await this.books.getBook(id)
    sendJson(res, 200, { ok: true, parse: book.parse })
  }

  private async startParse(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!this.parser) {
      throw new AppError(503, 'parse_unavailable', '当前宿主组合没有解析服务。')
    }
    const body = await readJsonBody(req, JSON_LIMIT)
    if (body !== undefined && !isRecord(body)) throw badRequest('请求必须是对象。')
    const force = isRecord(body) && body.force === true
    const result = await this.parser.start(id, { force })
    sendJson(res, result.started ? 202 : 200, {
      ok: true,
      started: result.started,
      parse: result.book.parse,
    })
  }

  private async getTree(res: ServerResponse, id: string): Promise<void> {
    const book = await this.books.getBook(id)
    const tree = await this.tree.read(id)
    sendJson(res, 200, { ok: true, tree: tree ?? null, parseStatus: book.parse.status })
  }

  private async applyTreeOp(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    await this.books.getBook(id)
    const body = await readJsonBody(req, JSON_LIMIT)
    if (!isRecord(body) || typeof body.op !== 'string' || typeof body.nodeId !== 'string') {
      throw badRequest('章节操作需要 op 与 nodeId。')
    }
    let operation: TreeOperation
    if (body.op === 'rename') {
      if (typeof body.title !== 'string') throw badRequest('重命名需要 title。')
      operation = { op: 'rename', nodeId: body.nodeId, title: body.title }
    } else if (body.op === 'merge') {
      operation = { op: 'merge', nodeId: body.nodeId }
    } else if (body.op === 'relevel') {
      if (body.level !== 1 && body.level !== 2) throw badRequest('level 只能是 1 或 2。')
      operation = { op: 'relevel', nodeId: body.nodeId, level: body.level }
    } else {
      throw badRequest('未知的章节操作。')
    }
    const tree = await this.tree.apply(id, operation)
    sendJson(res, 200, { ok: true, tree })
  }

  private async searchBook(res: ServerResponse, id: string, url: URL): Promise<void> {
    const book = await this.books.getBook(id)
    const query = (url.searchParams.get('q') ?? '').trim()
    if (!query) throw badRequest('缺少检索词 q。')
    const limitRaw = Number(url.searchParams.get('limit') ?? '5')
    const limit = Number.isInteger(limitRaw) ? Math.min(20, Math.max(1, limitRaw)) : 5
    const nodeId = url.searchParams.get('node') ?? undefined
    const normalized = await readJsonFile<NormalizedBook>(this.normalizedFile(id))
    if (!normalized) {
      throw new AppError(409, 'not_parsed', '这本书还没有解析结果。', '先在阅读器里开始解析。')
    }
    const tree = await this.tree.read(id)
    const hits = searchNormalized(normalized, tree as Tree | undefined, query, limit, nodeId)
    sendJson(res, 200, {
      ok: true,
      bookId: id,
      query,
      hits: hits.map((hit) => ({
        ...hit,
        citationPath: `/textbook-reader/?book=${encodeURIComponent(id)}&page=${hit.page}&block=${encodeURIComponent(hit.blockId)}`,
      })),
      pages: book.pages,
    })
  }

  private async getPage(res: ServerResponse, id: string, rawPage: string): Promise<void> {
    const pageNumber = Number(rawPage)
    const book = await this.books.getBook(id)
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > book.pages) {
      throw new AppError(422, 'invalid_page', `页码必须是 1 到 ${book.pages} 的整数。`)
    }
    const normalized = await readJsonFile<NormalizedBook>(this.normalizedFile(id))
    if (!normalized) {
      throw new AppError(409, 'not_parsed', '这本书还没有解析结果。', '先在阅读器里开始解析。')
    }
    const page = normalized.pages.find((item) => item.page === pageNumber)
    if (!page) throw new AppError(404, 'page_not_found', '该页没有内容块。')
    sendJson(res, 200, { ok: true, page, bookId: id, pages: book.pages })
  }

  private async serveAsset(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    assetPath: string,
  ): Promise<void> {
    await this.books.getBook(id)
    if (!assetPath || assetPath.includes('\0')) throw notFound()
    const rawRoot = join(this.books.bookDir(id), 'parse', 'raw')
    const file = await this.findAsset(rawRoot, assetPath)
    const type = mimeType(file)
    if (!type.startsWith('image/')) throw notFound()
    await serveFile(req, res, file, {
      contentType: type,
      cacheControl: 'private, max-age=3600',
    })
  }

  /**
   * content_list image paths are relative to the content list, which may sit
   * inside a nested zip directory. Try the documented root first, then each
   * top-level directory, so a `result/images/x.jpg` archive still resolves.
   */
  private async findAsset(rawRoot: string, assetPath: string): Promise<string> {
    const candidates = [resolveStaticPath(rawRoot, `/${assetPath}`)]
    try {
      const entries = await readdir(rawRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        candidates.push(resolveStaticPath(rawRoot, `/${entry.name}/${assetPath}`))
      }
    } catch {
      // The normal candidate below produces the explicit 404.
    }
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) return candidate
      } catch {
        // Try the next candidate.
      }
    }
    const suffix = `/${assetPath.replace(/\\/g, '/').replace(/^\/+/, '')}`
    const found = await findFileBySuffix(rawRoot, suffix, 0, 4)
    if (found) return found
    throw notFound('解析图片不存在。')
  }

  private normalizedFile(id: string): string {
    return join(this.books.bookDir(id), 'parse', 'normalized.json')
  }

  private logFailure(req: IncomingMessage, error: unknown): void {
    const status = isAppError(error) ? error.status : 500
    if (status < 500) return
    const message = isAppError(error)
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
    try {
      this.logger.error?.(`[dsh-textbook-reader] ${req.method ?? 'GET'} ${redactSecrets(message)}`)
    } catch {
      // Logging never breaks a response.
    }
  }
}

function splitPath(sub: string): string[] {
  return sub.split('/').filter((part) => part.length > 0)
}

function decodeSegment(value: string | undefined): string {
  if (!value) throw notFound()
  try {
    return decodeURIComponent(value)
  } catch {
    throw badRequest('路径参数编码不合法。', 'bad_path')
  }
}

function decodeHeaderValue(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    // Non-encoded header values are accepted as-is.
  }
  return decoded.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300).trim()
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return resolve(path)
}

function methodNotAllowed(res: ServerResponse, allow: string[]): void {
  res.setHeader('Allow', allow.join(', '))
  sendJson(res, 405, {
    ok: false,
    error: { code: 'method_not_allowed', message: `仅支持 ${allow.join(', ')}。` },
  })
}

function parseTrustedHosts(): string[] {
  return String(process.env.TEXTBOOK_READER_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** Bounded recursive fallback for images under nested MinerU zip directories. */
async function findFileBySuffix(root: string, suffix: string, depth: number, maxDepth: number): Promise<string | undefined> {
  if (depth > maxDepth) return undefined
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  let found: string | undefined
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFileBySuffix(full, suffix, depth + 1, maxDepth)
      if (nested) {
        if (found) return undefined
        found = nested
      }
    } else if (entry.isFile() && full.replace(/\\/g, '/').endsWith(suffix)) {
      if (found) return undefined
      found = full
    }
  }
  return found
}
