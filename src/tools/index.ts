/**
 * Agent-facing textbook tools.
 *
 * Results are compact JSON plus clickable reader URLs. The system-prompt
 * section and these descriptions share one citation contract: [p.N] links
 * built from the tool's readerUrl, never invented page numbers.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Book, NormalizedBook, Tree, TreeNode } from '../types.js'
import { AppError } from '../errors.js'
import type { DataPaths } from '../config.js'
import type { BookStore } from '../store/books.js'
import type { ProgressStore } from '../store/progress.js'
import type { TreeStore } from '../store/tree.js'
import { readJsonFile } from '../store/atomic.js'
import type { ParseManager } from '../mineru/job.js'
import { searchNormalized } from '../search.js'

export interface ToolRegistryLike {
  register(definition: unknown): () => void
}

export interface TextbookToolServices {
  paths: DataPaths
  books: BookStore
  progress: ProgressStore
  tree: TreeStore
  parser: ParseManager
  /** Absolute browser origin, e.g. http://127.0.0.1:50857. */
  getReaderBaseUrl: () => string | undefined
}

const CITATION_RULE =
  '凡是用教材工具回答，都必须给出可点击页码引用。用工具返回的 readerUrl 拼链接：`[\\[p.N\\]](<readerUrl>&page=N&block=<blockId>)`，N 必须是工具结果中的页码，blockId 有则必须带；不要编造页码，不要把页码写成纯文本。'

/** Register all textbook tools; returns a disposer for the whole group. */
export function registerTextbookTools(tools: ToolRegistryLike, services: TextbookToolServices): () => void {
  const disposers = [
    tools.register(
      defineTool({
        name: 'textbook_add',
        description: `把本地 PDF 教材加入书架（复制到本机数据目录，不解析）。参数 path 需要绝对路径。加入后可用 textbook_parse 提交 MinerU 解析。${CITATION_RULE}`,
        parameters: {
          path: { type: 'string', required: true, description: 'PDF 的绝对路径' },
          title: { type: 'string', description: '教材标题（可选，默认文件名）' },
        },
        output: jsonOutput(),
        async execute(args): Promise<any> {
          const source = expandHome(args.path)
          const result = await services.books.addFromFile(source, {
            ...(args.title ? { title: args.title } : {}),
            originalName: source.split(/[\\/]/).pop(),
          })
          await services.books.setActive(result.book.id)
          return {
            duplicate: result.duplicate,
            book: bookView(result.book),
            readerUrl: readerUrl(services, result.book.id),
          }
        },
      }),
    ),
    tools.register(
      defineTool({
        name: 'textbook_list',
        description: '列出书架上的教材、当前教材、页数、解析状态与阅读进度。回答教材相关问题前可先调用它确定 book。',
        parameters: {},
        output: jsonOutput(),
        async execute(): Promise<any> {
          const books = await services.books.listBooks()
          const active = await services.books.activeBookId()
          const rows = []
          for (const book of books) {
            const progress = await services.progress.read(book.id, book.pages)
            rows.push({
              ...bookView(book),
              active: book.id === active,
              currentPage: progress.currentPage,
              readChapters: progress.readChapters.length,
              mastery: Object.keys(progress.mastery).length,
            })
          }
          return { books: rows, activeBookId: active ?? null }
        },
      }),
    ),
    tools.register(
      defineTool({
        name: 'textbook_parse',
        description: `提交 MinerU 云解析（model_version=vlm，可能数分钟）。book 可传 id/标题；省略则用当前教材。未配置 token 会明确报错。解析是异步的，完成后用 textbook_tree 读取章节树。${CITATION_RULE}`,
        parameters: {
          book: { type: 'string', description: '教材 id 或标题片段；省略用当前教材' },
          force: { type: 'boolean', description: '已解析时是否强制重新解析（默认 false）' },
        },
        output: jsonOutput(),
        async execute(args): Promise<any> {
          const book = await resolveBook(services, args.book)
          const result = await services.parser.start(book.id, { force: args.force === true })
          return {
            bookId: book.id,
            title: book.title,
            started: result.started,
            parse: result.book.parse,
            readerUrl: readerUrl(services, book.id),
          }
        },
      }),
    ),
    tools.register(
      defineTool({
        name: 'textbook_tree',
        description: `读取教材的 书→章→节 章节树与解析状态。未解析时返回 parse.status，不会伪造章节。book 省略则用当前教材。${CITATION_RULE}`,
        parameters: {
          book: { type: 'string', description: '教材 id 或标题片段；省略用当前教材' },
        },
        output: jsonOutput(),
        async execute(args): Promise<any> {
          const book = await resolveBook(services, args.book)
          const tree = await services.tree.read(book.id)
          return {
            book: bookView(book),
            parse: book.parse,
            tree: treeView(tree),
            readerUrl: readerUrl(services, book.id),
          }
        },
      }),
    ),
    tools.register(
      defineTool({
        name: 'textbook_search',
        description: `在已解析教材中检索原文块，返回页码、blockId、bbox 与上下文。回答必须引用这些真实页码；引用链接必须使用返回的 citationUrl。book 省略则用当前教材。${CITATION_RULE}`,
        parameters: {
          query: { type: 'string', required: true, description: '检索词/问题关键词' },
          book: { type: 'string', description: '教材 id 或标题片段；省略用当前教材' },
          limit: { type: 'integer', description: '返回条数 1..20，默认 5' },
        },
        output: jsonOutput(),
        async execute(args): Promise<any> {
          const book = await resolveBook(services, args.book)
          const normalized = await loadNormalized(services, book.id)
          const tree = await services.tree.read(book.id)
          const hits = searchNormalized(normalized, tree, args.query, args.limit ?? 5)
          return {
            bookId: book.id,
            title: book.title,
            query: args.query,
            readerUrl: readerUrl(services, book.id),
            hits: hits.map((hit) => ({
              page: hit.page,
              blockId: hit.blockId,
              bbox: hit.bbox,
              section: hit.section,
              score: hit.score,
              text: hit.text,
              citationUrl: citationUrl(services, book.id, hit.page, hit.blockId),
            })),
          }
        },
      }),
    ),
    tools.register(
      defineTool({
        name: 'textbook_progress',
        description: '读取当前教材的学习进度：当前页、已读章节、每章掌握度自评、疑问清单。',
        parameters: {
          book: { type: 'string', description: '教材 id 或标题片段；省略用当前教材' },
        },
        output: jsonOutput(),
        async execute(args): Promise<any> {
          const book = await resolveBook(services, args.book)
          const progress = await services.progress.read(book.id, book.pages)
          return { book: bookView(book), progress, readerUrl: readerUrl(services, book.id) }
        },
      }),
    ),
    tools.register(
      defineTool({
        name: 'textbook_progress_update',
        description: '更新当前教材的学习进度：当前页、标记/取消已读章节、设置章节掌握度（0..5）、添加/解决/删除疑问。只传需要变更的字段。',
        parameters: {
          book: { type: 'string', description: '教材 id 或标题片段；省略用当前教材' },
          currentPage: { type: 'integer', description: '当前页（1-based）' },
          markRead: { type: 'array', items: { type: 'string' }, description: '标记已读的章节/节 id 列表' },
          unmarkRead: { type: 'array', items: { type: 'string' }, description: '取消已读的节点 id 列表' },
          mastery: {
            type: 'array',
            description: '掌握度更新列表',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                nodeId: { type: 'string', required: true },
                level: { type: 'integer', required: true, description: '0..5' },
              },
            },
          },
          addQuestion: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              page: { type: 'integer' },
            },
          },
          resolveQuestion: { type: 'string', description: '疑问 id' },
          deleteQuestion: { type: 'string', description: '疑问 id' },
        },
        output: jsonOutput(),
        async execute(args): Promise<any> {
          const book = await resolveBook(services, args.book)
          const current = await services.progress.read(book.id, book.pages)
          const readSet = new Set(current.readChapters)
          for (const id of args.markRead ?? []) readSet.add(id)
          for (const id of args.unmarkRead ?? []) readSet.delete(id)
          const mastery: Record<string, number> = {}
          for (const entry of args.mastery ?? []) {
            if (!Number.isInteger(entry.level) || entry.level < 0 || entry.level > 5) {
              throw new AppError(422, 'invalid_mastery', '掌握度必须是 0 到 5 的整数。')
            }
            mastery[entry.nodeId] = entry.level
          }
          const progress = await services.progress.patch(
            book.id,
            {
              ...(args.currentPage !== undefined ? { currentPage: args.currentPage } : {}),
              ...(args.markRead || args.unmarkRead ? { readChapters: [...readSet] } : {}),
              ...(Object.keys(mastery).length > 0 ? { mastery } : {}),
              ...(args.addQuestion?.text ? { addQuestion: args.addQuestion } : {}),
              ...(args.resolveQuestion ? { resolveQuestion: args.resolveQuestion } : {}),
              ...(args.deleteQuestion ? { deleteQuestion: args.deleteQuestion } : {}),
            },
            book.pages,
          )
          return { book: bookView(book), progress, readerUrl: readerUrl(services, book.id) }
        },
      }),
    ),
  ]
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Tool unregistration is best effort during teardown.
      }
    }
  }
}

function jsonOutput() {
  return {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [
      { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  }
}

async function resolveBook(services: TextbookToolServices, ref: string | undefined): Promise<Book> {
  const books = await services.books.listBooks()
  const wanted = String(ref ?? '').trim()
  if (wanted) {
    const exact = books.find((book) => book.id === wanted)
    if (exact) return exact
    const matches = books.filter((book) => book.title.toLowerCase().includes(wanted.toLowerCase()))
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      throw new AppError(409, 'book_ambiguous', '匹配到多本教材，请传更精确的标题或 id。', matches.map((book) => `${book.id}: ${book.title}`).join('\n'))
    }
    throw new AppError(404, 'book_not_found', `找不到教材「${wanted}」。`, '先调用 textbook_list 查看书架。')
  }
  const active = await services.books.activeBookId()
  if (active) {
    const book = books.find((item) => item.id === active)
    if (book) return book
  }
  if (books.length === 1) return books[0]!
  throw new AppError(409, 'book_required', '请先指定教材，或在阅读器中打开一本教材。', '调用 textbook_list 查看 book id。')
}

async function loadNormalized(services: TextbookToolServices, bookId: string): Promise<NormalizedBook> {
  const file = join(services.paths.books, bookId, 'parse', 'normalized.json')
  const normalized = await readJsonFile<NormalizedBook>(file)
  if (!normalized) {
    throw new AppError(409, 'not_parsed', '这本教材还没有可检索的解析结果。', '先调用 textbook_parse 完成 MinerU 解析。')
  }
  return normalized
}

function bookView(book: Book) {
  return {
    id: book.id,
    title: book.title,
    pages: book.pages,
    bytes: book.bytes,
    createdAt: book.createdAt,
    parse: book.parse,
  }
}

function treeView(tree: Tree | undefined) {
  if (!tree) return null
  const chapters = tree.nodes
    .filter((node) => node.level === 1)
    .sort((a, b) => a.pageStart - b.pageStart)
    .map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      pageStart: chapter.pageStart,
      pageEnd: chapter.pageEnd,
      children: chapter.children
        .map((id) => tree.nodes.find((node) => node.id === id))
        .filter((node): node is TreeNode => Boolean(node))
        .map((node) => ({ id: node.id, title: node.title, pageStart: node.pageStart, pageEnd: node.pageEnd })),
    }))
  return { rootTitle: tree.rootTitle, warnings: tree.warnings, chapters }
}

function readerUrl(services: TextbookToolServices, bookId: string): string | null {
  const base = services.getReaderBaseUrl()
  if (!base) return null
  return `${base.replace(/\/+$/, '')}/textbook-reader/?book=${encodeURIComponent(bookId)}`
}

function citationUrl(services: TextbookToolServices, bookId: string, page: number, blockId: string): string | null {
  const base = readerUrl(services, bookId)
  if (!base) return null
  return `${base}&page=${page}&block=${encodeURIComponent(blockId)}`
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(value)
}

export const _internalTools = { resolveBook, treeView, readerUrl, citationUrl }
