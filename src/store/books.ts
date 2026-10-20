/** Book registry: import, inspect, list and remove PDF textbooks. */

import { chmod, copyFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Book } from '../types.js'
import { AppError, badRequest, notFound, unprocessable } from '../errors.js'
import { inspectPdf, sha256File } from '../pdf.js'
import type { DataPaths } from '../config.js'
import { ensureDir, pathExists, randomId, readJsonFile, writeJsonAtomic } from './atomic.js'
import { KeyedLock } from './lock.js'

const BOOK_ID = /^[a-z0-9][a-z0-9-]{2,63}$/
const BOOK_FILE = 'book.json'
const PDF_FILE = 'source.pdf'
const MAX_TITLE = 200

export interface AddBookResult {
  book: Book
  duplicate: boolean
}

export interface BookStoreOptions {
  /** Sanitized warning sink; never receives tokens. */
  warn?: (message: string) => void
}

export class BookStore {
  readonly paths: DataPaths
  private readonly lock = new KeyedLock()
  private readonly warn: (message: string) => void

  constructor(paths: DataPaths, options: BookStoreOptions = {}) {
    this.paths = paths
    this.warn = options.warn ?? (() => {})
  }

  async ensure(): Promise<void> {
    await ensureDir(this.paths.root, 0o700)
    await ensureDir(this.paths.books, 0o700)
    await ensureDir(this.paths.tmp, 0o700)
  }

  bookDir(id: string): string {
    assertBookId(id)
    return join(this.paths.books, id)
  }

  bookFile(id: string): string {
    return join(this.bookDir(id), BOOK_FILE)
  }

  pdfFile(id: string): string {
    return join(this.bookDir(id), PDF_FILE)
  }

  /** Import an existing PDF. The source is copied into the private data root. */
  async addFromFile(
    sourcePath: string,
    options: { title?: string; originalName?: string } = {},
  ): Promise<AddBookResult> {
    await this.ensure()
    const source = normalizeSource(sourcePath)
    let sourceInfo
    try {
      sourceInfo = await stat(source)
    } catch {
      throw notFound('找不到要导入的 PDF 文件。')
    }
    if (!sourceInfo.isFile()) throw unprocessable('pdf_invalid', '导入路径不是文件。')
    if (extname(source).toLowerCase() !== '.pdf') {
      throw unprocessable('pdf_invalid', 'MVP 只支持 PDF 文件。')
    }

    const info = await inspectPdf(source)
    const sha256 = await sha256File(source)
    const duplicate = await this.findBySha256(sha256)
    if (duplicate) return { book: duplicate, duplicate: true }

    const id = randomId('b')
    const title = sanitizeTitle(options.title) || sanitizeTitle(basename(source, extname(source))) || '未命名教材'
    const originalName = sanitizeTitle(options.originalName) || basename(source)
    const now = new Date().toISOString()
    const book: Book = {
      id,
      title,
      pdf: PDF_FILE,
      pages: info.pages,
      bytes: info.bytes,
      sha256,
      originalName,
      createdAt: now,
      updatedAt: now,
      parse: { status: 'none', warnings: [] },
    }

    const tempDir = join(this.paths.books, `.tmp-${id}`)
    const finalDir = this.bookDir(id)
    await ensureDir(tempDir, 0o700)
    try {
      const target = join(tempDir, PDF_FILE)
      await copyFile(source, target)
      await chmod(target, 0o600)
      await writeJsonAtomic(join(tempDir, BOOK_FILE), book, 0o600)
      await rename(tempDir, finalDir)
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return { book, duplicate: false }
  }

  async getBook(id: string): Promise<Book> {
    assertBookId(id)
    const book = await readJsonFile<Book>(this.bookFile(id))
    if (!book) throw notFound('教材不存在。')
    return sanitizeBook(book)
  }

  async listBooks(): Promise<Book[]> {
    await this.ensure()
    let entries
    try {
      entries = await readdir(this.paths.books, { withFileTypes: true })
    } catch {
      return []
    }
    const books: Book[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (!BOOK_ID.test(entry.name)) continue
      try {
        const book = await readJsonFile<Book>(this.bookFile(entry.name))
        if (book) books.push(sanitizeBook(book))
      } catch (error) {
        this.warn(`[dsh-textbook-reader] skipped unreadable book "${entry.name}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async findBySha256(sha256: string): Promise<Book | undefined> {
    const books = await this.listBooks()
    return books.find((book) => book.sha256 === sha256)
  }

  async deleteBook(id: string): Promise<Book> {
    return this.lock.run(id, async () => {
      const book = await this.getBook(id)
      await ensureDir(this.paths.trash, 0o700)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = join(this.paths.trash, `${id}-${stamp}`)
      await rename(this.bookDir(id), target)
      return book
    })
  }

  async setActive(id: string): Promise<void> {
    await this.getBook(id)
    await this.ensure()
    await writeJsonAtomic(this.paths.activeFile, { bookId: id, updatedAt: new Date().toISOString() }, 0o600)
  }

  async activeBookId(): Promise<string | undefined> {
    const stored = await readJsonFile<{ bookId?: unknown }>(this.paths.activeFile)
    if (!stored || typeof stored.bookId !== 'string' || !BOOK_ID.test(stored.bookId)) return undefined
    return (await pathExists(this.bookFile(stored.bookId))) ? stored.bookId : undefined
  }

  async clearActive(): Promise<void> {
    await rm(this.paths.activeFile, { force: true })
  }

  async saveBook(book: Book): Promise<void> {
    assertBookId(book.id)
    await writeJsonAtomic(this.bookFile(book.id), { ...book, updatedAt: new Date().toISOString() }, 0o600)
  }

  /** Read-modify-write one book under its per-book lock. */
  async updateBook(id: string, mutate: (book: Book) => Book | Promise<Book>): Promise<Book> {
    return this.lock.run(id, async () => {
      const book = await this.getBook(id)
      const next = await mutate(structuredClone(book))
      next.id = id
      next.updatedAt = new Date().toISOString()
      await writeJsonAtomic(this.bookFile(id), next, 0o600)
      return next
    })
  }

  /** Ensure a book directory still has its source PDF. */
  async hasPdf(id: string): Promise<boolean> {
    return pathExists(this.pdfFile(id))
  }
}

export function assertBookId(id: string): void {
  if (typeof id !== 'string' || !BOOK_ID.test(id)) {
    throw badRequest('教材 ID 不合法。', 'invalid_book_id')
  }
}

export function sanitizeTitle(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
}

function normalizeSource(sourcePath: string): string {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw badRequest('缺少 PDF 路径。')
  }
  return sourcePath.trim()
}

/** Keep only the fields the UI may depend on, with sane fallbacks. */
function sanitizeBook(book: Book): Book {
  const parse = book.parse && typeof book.parse === 'object' ? book.parse : { status: 'none' as const, warnings: [] }
  return {
    ...book,
    title: sanitizeTitle(book.title) || '未命名教材',
    pages: Number.isInteger(book.pages) && book.pages > 0 ? book.pages : 1,
    parse: {
      status: parse.status ?? 'none',
      warnings: Array.isArray(parse.warnings) ? parse.warnings.filter((item): item is string => typeof item === 'string') : [],
      ...(typeof parse.progress === 'number' ? { progress: parse.progress } : {}),
      ...(typeof parse.batchId === 'string' ? { batchId: parse.batchId } : {}),
      ...(parse.error ? { error: sanitizeParseError(parse.error) } : {}),
    },
  }
}

function sanitizeParseError(error: Book['parse']['error']): NonNullable<Book['parse']['error']> {
  return {
    code: typeof error?.code === 'string' ? error.code : 'parse_failed',
    message: typeof error?.message === 'string' ? error.message : '解析失败',
    ...(typeof error?.hint === 'string' ? { hint: error.hint } : {}),
  }
}

/** Export for tests that need a valid generated id without touching disk. */
export const _internal = { BOOK_FILE, PDF_FILE, BOOK_ID, AppError }
