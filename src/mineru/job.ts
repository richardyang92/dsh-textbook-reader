/**
 * Asynchronous MinerU parse jobs.
 *
 * Starting a parse returns immediately; progress lives in book.json so every
 * UI/agent read is consistent and a host restart leaves an explicit
 * interrupted/failed state instead of a silent "running forever".
 *
 * PDFs above the per-task page ceiling are split locally with pdf-lib, parsed
 * segment by segment, then merged back into one page-indexed document. No
 * local OCR or model is used.
 */

import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { Book, Heading, NormalizedBook, NormalizedPage, ParseState } from '../types.js'
import { AppError, notFound } from '../errors.js'
import { ConfigStore, redactSecrets, type DataPaths } from '../config.js'
import { MAX_PAGES_PER_TASK, planPageRanges } from '../pdf.js'
import { BookStore } from '../store/books.js'
import { TreeStore } from '../store/tree.js'
import { ensureDir, writeJsonAtomic } from '../store/atomic.js'
import { KeyedLock } from '../store/lock.js'
import { generateTree } from '../tree/generate.js'
import { MineruClient, type BatchFile, type BatchStatus, type UploadRequest } from './client.js'
import { discoverArtifacts } from './discover.js'
import { normalizeArtifacts } from './normalize.js'
import { splitPdf, type SplitPart } from './split.js'
import { extractZip } from './zip.js'

const POLL_INTERVAL_MS = 4_000
const MAX_POLL_MS = 45 * 60_000
const MAX_RETRIES = 5
const TERMINAL = new Set(['done', 'failed'])
const RUNNING = new Set(['preparing', 'uploading', 'polling', 'downloading', 'normalizing'])

export interface MineruApi {
  requestUpload(token: string, request: UploadRequest): Promise<{ batchId: string; fileUrls: string[] }>
  uploadFile(url: string, filePath: string): Promise<void>
  getBatch(token: string, batchId: string): Promise<BatchStatus>
  downloadZip(url: string, target: string): Promise<void>
}

export interface ParseLogger {
  warn?: (message: string) => void
  error?: (message: string) => void
}

export interface ParseManagerOptions {
  paths: DataPaths
  books: BookStore
  config: ConfigStore
  tree: TreeStore
  client?: MineruApi
  logger?: ParseLogger
  pollIntervalMs?: number
  maxPollMs?: number
  /** Override MinerU's 600-page task ceiling (tests use a small value). */
  maxPagesPerTask?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}

export interface StartParseResult {
  book: Book
  started: boolean
  completion?: Promise<void>
}

interface ParseRunState {
  warnings: string[]
  batchId?: string
}

interface ParseOneOptions {
  bookId: string
  token: string
  signal: AbortSignal
  state: ParseRunState
  sourceFile: string
  fileName: string
  dataId: string
  pages: number
  rawDir: string
  zipPath: string
  progressStart: number
  progressEnd: number
}

export class ParseManager {
  readonly paths: DataPaths
  private readonly books: BookStore
  private readonly config: ConfigStore
  private readonly tree: TreeStore
  private readonly client: MineruApi
  private readonly logger: ParseLogger
  private readonly pollIntervalMs: number
  private readonly maxPollMs: number
  private readonly maxPagesPerTask: number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<void> }>()
  private readonly startLock = new KeyedLock()

  constructor(options: ParseManagerOptions) {
    this.paths = options.paths
    this.books = options.books
    this.config = options.config
    this.tree = options.tree
    this.client = options.client ?? new MineruClient()
    this.logger = options.logger ?? {}
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.maxPollMs = options.maxPollMs ?? MAX_POLL_MS
    this.maxPagesPerTask = options.maxPagesPerTask ?? MAX_PAGES_PER_TASK
    this.sleep = options.sleep ?? abortableSleep
    this.now = options.now ?? (() => Date.now())
  }

  /** Starts a job and returns the persisted "preparing" state immediately. */
  async start(bookId: string, options: { force?: boolean } = {}): Promise<StartParseResult> {
    return this.startLock.run(bookId, async () => {
      const current = await this.books.getBook(bookId)
      const running = this.active.get(bookId)
      if (running && !options.force) {
        return { book: current, started: false, completion: running.completion }
      }
      if (running && options.force) {
        running.controller.abort()
        await running.completion.catch(() => {})
      }
      if (current.parse.status === 'done' && !options.force) {
        return { book: current, started: false }
      }
      const token = await this.config.requireToken()
      if (!(await this.books.hasPdf(bookId))) {
        throw notFound('教材源 PDF 不存在。')
      }

      const book = await this.books.updateBook(bookId, (value) => ({
        ...value,
        parse: {
          status: 'preparing',
          progress: 0,
          warnings: [],
        },
      }))

      const controller = new AbortController()
      const completion = this.run(bookId, token, controller.signal).finally(() => {
        const record = this.active.get(bookId)
        if (record?.controller === controller) this.active.delete(bookId)
      })
      this.active.set(bookId, { controller, completion })
      return { book, started: true, completion }
    })
  }

  /** Await the active job, if any (tests and tool callers). */
  whenIdle(bookId: string): Promise<void> {
    return this.active.get(bookId)?.completion ?? Promise.resolve()
  }

  async cancel(bookId: string): Promise<boolean> {
    const record = this.active.get(bookId)
    if (!record) return false
    record.controller.abort()
    return true
  }

  /** Mark jobs that did not survive the process restart as interrupted. */
  async recover(): Promise<void> {
    const books = await this.books.listBooks()
    for (const book of books) {
      if (!RUNNING.has(book.parse.status)) continue
      if (this.active.has(book.id)) continue
      await this.books.updateBook(book.id, (value) => ({
        ...value,
        parse: {
          ...value.parse,
          status: 'interrupted',
          error: {
            code: 'parse_interrupted',
            message: '上次解析在宿主重启时中断。',
            hint: '点击「开始解析」重新提交；已下载的书和进度不受影响。',
          },
          warnings: [...value.parse.warnings, '解析任务在宿主重启时中断。'],
        },
      }))
    }
  }

  dispose(): void {
    for (const record of this.active.values()) record.controller.abort()
    this.active.clear()
  }

  private async run(bookId: string, token: string, signal: AbortSignal): Promise<void> {
    const state: ParseRunState = { warnings: [] }
    try {
      const book = await this.books.getBook(bookId)
      if (signal.aborted) throw abortError()
      const parseDir = join(this.books.bookDir(bookId), 'parse')
      await ensureDir(parseDir, 0o700)
      if (book.pages > this.maxPagesPerTask) {
        await this.runSegmented(book, token, signal, state, parseDir)
      } else {
        await this.runSingle(book, token, signal, state, parseDir)
      }
    } catch (error) {
      await this.fail(bookId, error, state.warnings, state.batchId)
    }
  }

  private async runSingle(
    book: Book,
    token: string,
    signal: AbortSignal,
    state: ParseRunState,
    parseDir: string,
  ): Promise<void> {
    const normalized = await this.parseOne({
      bookId: book.id,
      token,
      signal,
      state,
      sourceFile: this.books.pdfFile(book.id),
      fileName: `${book.id}.pdf`,
      dataId: book.id,
      pages: book.pages,
      rawDir: join(parseDir, 'raw'),
      zipPath: join(parseDir, 'download.zip'),
      progressStart: 3,
      progressEnd: 95,
    })
    await this.finalize(book, normalized, state)
  }

  private async runSegmented(
    book: Book,
    token: string,
    signal: AbortSignal,
    state: ParseRunState,
    parseDir: string,
  ): Promise<void> {
    const ranges = planPageRanges(book.pages, this.maxPagesPerTask)
    state.warnings.push(`PDF 有 ${book.pages} 页，超过单任务 ${this.maxPagesPerTask} 页；已本地分为 ${ranges.length} 段顺序解析。`)
    await this.updateParse(book.id, {
      status: 'preparing',
      progress: 1,
      warnings: state.warnings,
    })
    const segmentsDir = join(parseDir, 'segments')
    const parts = await splitPdf(this.books.pdfFile(book.id), ranges, segmentsDir)
    const mergedPages: NormalizedPage[] = []
    let mergedHeadings: Heading[] = []
    let backend: string | undefined
    let versionName: string | undefined
    let firstContentList: string | undefined
    let firstLayout: string | undefined
    let firstMarkdown: string | undefined
    let stats = { blocks: 0, textBlocks: 0, titleBlocks: 0, images: 0, tables: 0 }

    try {
      for (const [index, part] of parts.entries()) {
        throwIfAborted(signal)
        const start = 3 + (index / parts.length) * 90
        const end = 3 + ((index + 1) / parts.length) * 90
        const normalized = await this.parseOne({
          bookId: book.id,
          token,
          signal,
          state,
          sourceFile: part.file,
          fileName: `${book.id}-part-${part.index}.pdf`,
          dataId: `${book.id}-p${part.index}`,
          pages: part.pages,
          rawDir: join(parseDir, 'raw', `segment-${part.index}`),
          zipPath: join(parseDir, `segment-${part.index}.zip`),
          progressStart: start,
          progressEnd: end,
        })
        const offset = part.range.from - 1
        for (const page of normalized.pages) {
          const shifted: NormalizedPage = {
            ...page,
            page: page.page + offset,
            blocks: page.blocks.map((block) => ({ ...block, page: block.page + offset })),
          }
          mergedPages.push(shifted)
        }
        for (const heading of normalized.headings) {
          mergedHeadings.push({ ...heading, page: heading.page + offset })
        }
        stats = {
          blocks: stats.blocks + normalized.stats.blocks,
          textBlocks: stats.textBlocks + normalized.stats.textBlocks,
          titleBlocks: stats.titleBlocks + normalized.stats.titleBlocks,
          images: stats.images + normalized.stats.images,
          tables: stats.tables + normalized.stats.tables,
        }
        backend ??= normalized.source.backend
        versionName ??= normalized.source.versionName
        firstContentList ??= normalized.source.contentListFile ? `segment-${part.index}/${normalized.source.contentListFile}` : undefined
        firstLayout ??= normalized.source.layoutFile ? `segment-${part.index}/${normalized.source.layoutFile}` : undefined
        firstMarkdown ??= normalized.source.markdownFile ? `segment-${part.index}/${normalized.source.markdownFile}` : undefined
        state.warnings.push(`第 ${index + 1}/${parts.length} 段（第 ${part.range.from}–${part.range.to} 页）完成。`)
      }
    } finally {
      await rm(segmentsDir, { recursive: true, force: true }).catch(() => {})
    }

    mergedPages.sort((a, b) => a.page - b.page)
    mergedHeadings.sort((a, b) => a.page - b.page || a.blockId.localeCompare(b.blockId))
    // Each segment repeats the book cover/title heading. Keep only the first
    // exact title match so it is not mistaken for several chapters.
    const normalizedTitle = book.title.replace(/\s+/g, ' ').trim()
    let sawTitle = false
    mergedHeadings = mergedHeadings.filter((heading) => {
      if (heading.text.replace(/\s+/g, ' ').trim() !== normalizedTitle) return true
      if (sawTitle) return false
      sawTitle = true
      return true
    })
    const merged: NormalizedBook = {
      version: 1,
      bookId: book.id,
      pages: mergedPages,
      headings: mergedHeadings,
      warnings: state.warnings,
      source: {
        ...(firstContentList ? { contentListFile: firstContentList } : {}),
        ...(firstLayout ? { layoutFile: firstLayout } : {}),
        ...(firstMarkdown ? { markdownFile: firstMarkdown } : {}),
        ...(backend ? { backend } : {}),
        ...(versionName ? { versionName } : {}),
      },
      stats,
    }
    await this.finalize(book, merged, state)
  }

  private async parseOne(options: ParseOneOptions): Promise<NormalizedBook> {
    const report = async (status: ParseState['status'], localPercent: number): Promise<void> => {
      const percent = Math.round(
        options.progressStart + (Math.max(0, Math.min(100, localPercent)) / 100) * (options.progressEnd - options.progressStart),
      )
      await this.updateParse(options.bookId, {
        status,
        progress: Math.min(99, Math.max(0, percent)),
        ...(options.state.batchId ? { batchId: options.state.batchId } : {}),
        warnings: options.state.warnings,
      })
    }

    await report('uploading', 3)
    const settings = await this.config.readSettings()
    const ticket = await this.client.requestUpload(options.token, {
      fileName: options.fileName,
      dataId: options.dataId,
      isOcr: settings.mineru.isOcr,
      enableTable: settings.mineru.enableTable,
      language: settings.mineru.language,
    })
    options.state.batchId = ticket.batchId
    await report('uploading', 8)
    const uploadUrl = ticket.fileUrls[0]
    if (!uploadUrl) throw new AppError(502, 'mineru_response_invalid', 'MinerU 没有返回上传地址。')
    await this.client.uploadFile(uploadUrl, options.sourceFile)
    await report('polling', 12)

    const file = await this.poll(options.token, options.dataId, ticket.batchId, options.signal, async (percent) => {
      await report('polling', percent)
    })
    if (!file.fullZipUrl) {
      throw new AppError(502, 'mineru_response_invalid', 'MinerU 完成但没有返回结果包地址。')
    }

    await ensureDir(join(options.rawDir, '..'), 0o700)
    await rm(options.zipPath, { force: true }).catch(() => {})
    await report('downloading', 88)
    await this.client.downloadZip(file.fullZipUrl, options.zipPath)
    await report('normalizing', 93)
    const extracted = await extractZip(options.zipPath, options.rawDir)
    try {
      this.logger.warn?.(`[dsh-textbook-reader] extracted ${extracted.files.length} MinerU result files`)
    } catch {
      // Extraction count is diagnostic only.
    }
    const discovered = await discoverArtifacts(options.rawDir)
    options.state.warnings.push(...discovered.warnings)
    const normalized = normalizeArtifacts({
      bookId: options.bookId,
      pages: options.pages,
      ...(discovered.contentList ? { contentList: discovered.contentList } : {}),
      ...(discovered.layout ? { layout: discovered.layout } : {}),
      ...(discovered.markdown !== undefined ? { markdown: discovered.markdown } : {}),
      source: {
        ...(discovered.contentListFile ? { contentListFile: discovered.contentListFile } : {}),
        ...(discovered.layoutFile ? { layoutFile: discovered.layoutFile } : {}),
        ...(discovered.markdownFile ? { markdownFile: discovered.markdownFile } : {}),
      },
    })
    options.state.warnings.push(...normalized.warnings)
    return normalized.normalized
  }

  private async finalize(book: Book, normalized: NormalizedBook, state: ParseRunState): Promise<void> {
    const parseDir = join(this.books.bookDir(book.id), 'parse')
    await writeJsonAtomic(join(parseDir, 'normalized.json'), normalized, 0o600)
    const generated = generateTree({
      bookId: book.id,
      bookTitle: book.title,
      pages: book.pages,
      headings: normalized.headings,
    })
    state.warnings.push(...generated.warnings)
    await this.tree.save(book.id, generated.tree)
    await this.updateParse(book.id, {
      status: 'done',
      progress: 100,
      ...(state.batchId ? { batchId: state.batchId } : {}),
      warnings: [...new Set(state.warnings)].slice(0, 40),
    })
  }

  private async poll(
    token: string,
    dataId: string,
    batchId: string,
    signal: AbortSignal,
    onProgress: (percent: number) => Promise<void>,
  ): Promise<BatchFile> {
    const deadline = this.now() + this.maxPollMs
    let retries = 0
    let progress = 12
    while (true) {
      throwIfAborted(signal)
      if (this.now() > deadline) {
        throw new AppError(504, 'mineru_timeout', 'MinerU 解析超时（本地等待上限）。', '稍后在 MinerU 控制台查看任务，或重试。')
      }
      let batch: BatchStatus
      try {
        batch = await this.client.getBatch(token, batchId)
        retries = 0
      } catch (error) {
        if (isRetryable(error) && retries < MAX_RETRIES) {
          retries += 1
          await this.sleep(Math.min(10_000, 1_000 * 2 ** retries), signal)
          continue
        }
        throw error
      }
      const file = pickFile(batch, dataId)
      const nextProgress = computeProgress(file, progress)
      if (nextProgress > progress) {
        progress = nextProgress
        await onProgress(progress)
      }
      if (file.state === 'done') return file
      if (file.state === 'failed') {
        throw new AppError(
          502,
          'mineru_parse_failed',
          file.errMsg ? `MinerU 解析失败：${file.errMsg}` : 'MinerU 解析失败。',
          '检查 PDF 是否损坏/加密，或在 MinerU 控制台查看任务详情。',
        )
      }
      await this.sleep(this.pollIntervalMs, signal)
    }
  }

  private async updateParse(
    bookId: string,
    patch: Partial<ParseState> & { status: ParseState['status'] },
  ): Promise<void> {
    await this.books.updateBook(bookId, (book) => {
      const next: ParseState = {
        ...book.parse,
        ...patch,
        warnings: patch.warnings ?? book.parse.warnings,
      }
      if (patch.status === 'done') delete next.error
      return { ...book, parse: next }
    })
  }

  private async fail(bookId: string, error: unknown, warnings: string[], batchId?: string): Promise<void> {
    if (signalAborted(error)) {
      await this.updateParse(bookId, {
        status: 'interrupted',
        batchId,
        warnings: [...new Set([...warnings, '解析任务已中断。'])].slice(0, 40),
        error: {
          code: 'parse_cancelled',
          message: '解析已中断。',
          hint: '可以重新开始解析。',
        },
      }).catch(() => {})
      return
    }
    const app = error instanceof AppError
      ? error
      : new AppError(500, 'parse_failed', '解析过程中发生内部错误。')
    try {
      this.logger.error?.(
        `[dsh-textbook-reader] parse ${bookId} failed: ${redactSecrets(`${app.code}: ${app.message}`)}`,
      )
    } catch {
      // Logging must not mask the persisted failure.
    }
    await this.updateParse(bookId, {
      status: 'failed',
      ...(batchId ? { batchId } : {}),
      warnings: [...new Set([...warnings, app.message])].slice(0, 40),
      error: {
        code: app.code,
        message: app.message,
        ...(app.hint ? { hint: app.hint } : {}),
      },
    }).catch(() => {
      // The book may have been deleted while the job was running.
    })
  }
}

function pickFile(batch: BatchStatus, dataId: string): BatchFile {
  return (
    batch.files.find((file) => file.dataId === dataId) ??
    batch.files.find((file) => file.fileName?.includes(dataId)) ??
    batch.files[0]!
  )
}

function computeProgress(file: BatchFile, current: number): number {
  if (file.state === 'done') return 90
  const extracted = file.extractedPages
  const total = file.totalPages
  if (typeof extracted === 'number' && typeof total === 'number' && total > 0) {
    return Math.min(90, Math.max(current, 12 + Math.round((extracted / total) * 78)))
  }
  return Math.min(89, current + 1)
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof AppError)) return true
  return error.code === 'mineru_unreachable' || error.code === 'mineru_timeout' || error.code === 'mineru_api_error'
}

function abortError(): AppError {
  return new AppError(499, 'parse_cancelled', '解析已中断。')
}

function signalAborted(error: unknown): boolean {
  return error instanceof AppError && (error.code === 'parse_cancelled' || error.code === 'ABORT_ERR')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, Math.max(0, ms))
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectPromise(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const _internalParse = { computeProgress, pickFile, RUNNING, TERMINAL, MAX_RETRIES }
