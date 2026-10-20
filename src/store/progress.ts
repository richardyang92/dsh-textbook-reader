/** Per-book learning progress: current page, read chapters, mastery, questions. */

import { join } from 'node:path'
import type { Mastery, Progress, Question } from '../types.js'
import { badRequest, AppError } from '../errors.js'
import type { DataPaths } from '../config.js'
import { assertBookId } from './books.js'
import { readJsonFile, writeJsonAtomic } from './atomic.js'
import { KeyedLock } from './lock.js'

const PROGRESS_FILE = 'progress.json'
const MAX_READ_CHAPTERS = 10_000
const MAX_QUESTIONS = 1_000
const MAX_QUESTION_TEXT = 2_000
const MAX_NODE_ID = 128

export interface ProgressPatch {
  currentPage?: number
  readChapters?: string[]
  /** Merge per-node level updates; keys are tree node ids. */
  mastery?: Record<string, number>
  addQuestion?: { text: string; nodeId?: string; page?: number }
  resolveQuestion?: string
  deleteQuestion?: string
}

export class ProgressStore {
  readonly paths: DataPaths
  private readonly lock = new KeyedLock()

  constructor(paths: DataPaths) {
    this.paths = paths
  }

  progressFile(bookId: string): string {
    assertBookId(bookId)
    return join(this.paths.books, bookId, PROGRESS_FILE)
  }

  async read(bookId: string, pages: number): Promise<Progress> {
    const raw = await readJsonFile<unknown>(this.progressFile(bookId))
    if (raw === undefined) return emptyProgress()
    return coerceProgress(raw, pages)
  }

  async save(bookId: string, input: unknown, pages: number): Promise<Progress> {
    return this.lock.run(bookId, async () => {
      const next = validateProgress(input, pages)
      await writeJsonAtomic(this.progressFile(bookId), next, 0o600)
      return next
    })
  }

  async patch(bookId: string, patch: ProgressPatch, pages: number): Promise<Progress> {
    return this.lock.run(bookId, async () => {
      const current = await this.read(bookId, pages)
      const next: Progress = structuredClone(current)
      if (patch.currentPage !== undefined) {
        next.currentPage = validatePage(patch.currentPage, pages)
      }
      if (patch.readChapters !== undefined) {
        next.readChapters = validateNodeIds(patch.readChapters)
      }
      if (patch.mastery !== undefined) {
        for (const [nodeId, level] of Object.entries(patch.mastery)) {
          validateNodeId(nodeId)
          next.mastery[nodeId] = { level: validateMastery(level), updatedAt: new Date().toISOString() }
        }
      }
      if (patch.addQuestion !== undefined) {
        const question = makeQuestion(patch.addQuestion, pages)
        if (next.questions.length >= MAX_QUESTIONS) {
          throw new AppError(422, 'too_many_questions', `疑问最多 ${MAX_QUESTIONS} 条。`)
        }
        next.questions.push(question)
      }
      if (patch.resolveQuestion !== undefined) {
        const question = next.questions.find((item) => item.id === patch.resolveQuestion)
        if (!question) throw new AppError(404, 'question_not_found', '疑问不存在。')
        question.status = 'resolved'
      }
      if (patch.deleteQuestion !== undefined) {
        const index = next.questions.findIndex((item) => item.id === patch.deleteQuestion)
        if (index < 0) throw new AppError(404, 'question_not_found', '疑问不存在。')
        next.questions.splice(index, 1)
      }
      next.updatedAt = new Date().toISOString()
      await writeJsonAtomic(this.progressFile(bookId), next, 0o600)
      return next
    })
  }
}

export function emptyProgress(): Progress {
  return {
    currentPage: 1,
    readChapters: [],
    mastery: {},
    questions: [],
    updatedAt: new Date().toISOString(),
  }
}

/** Strict validation for a full PUT. */
export function validateProgress(input: unknown, pages: number): Progress {
  if (!isRecord(input)) throw badRequest('进度必须是对象。')
  const currentPage = input.currentPage === undefined ? 1 : validatePage(input.currentPage, pages)
  const readChapters = input.readChapters === undefined ? [] : validateNodeIds(input.readChapters)
  const mastery = validateMasteryMap(input.mastery)
  const questions = validateQuestions(input.questions, pages)
  return {
    currentPage,
    readChapters,
    mastery,
    questions,
    updatedAt: new Date().toISOString(),
  }
}

/** Forgiving read path: corrupt/partial fields fall back instead of bricking the book. */
export function coerceProgress(value: unknown, pages: number): Progress {
  if (!isRecord(value)) return emptyProgress()
  const rawPage = typeof value.currentPage === 'number' ? value.currentPage : 1
  const currentPage = Number.isFinite(rawPage) ? Math.min(Math.max(Math.trunc(rawPage), 1), Math.max(1, pages)) : 1
  const readChapters = Array.isArray(value.readChapters)
    ? value.readChapters.filter((item): item is string => typeof item === 'string').slice(0, MAX_READ_CHAPTERS)
    : []
  const mastery: Record<string, Mastery> = {}
  if (isRecord(value.mastery)) {
    for (const [nodeId, entry] of Object.entries(value.mastery)) {
      if (!isRecord(entry)) continue
      const level = Number(entry.level)
      if (!Number.isInteger(level) || level < 0 || level > 5) continue
      mastery[nodeId] = {
        level: level as Mastery['level'],
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
      }
    }
  }
  const questions: Question[] = []
  if (Array.isArray(value.questions)) {
    for (const entry of value.questions.slice(0, MAX_QUESTIONS)) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.text !== 'string') continue
      questions.push({
        id: entry.id,
        text: entry.text.slice(0, MAX_QUESTION_TEXT),
        ...(typeof entry.nodeId === 'string' ? { nodeId: entry.nodeId } : {}),
        ...(typeof entry.page === 'number' ? { page: entry.page } : {}),
        status: entry.status === 'resolved' ? 'resolved' : 'open',
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
      })
    }
  }
  return {
    currentPage,
    readChapters: [...new Set(readChapters)],
    mastery,
    questions,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  }
}

function validatePage(value: unknown, pages: number): number {
  const page = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(page) || page < 1 || page > Math.max(1, pages)) {
    throw new AppError(422, 'invalid_page', `页码必须是 1 到 ${Math.max(1, pages)} 的整数。`)
  }
  return page
}

function validateNodeIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw badRequest('readChapters 必须是数组。')
  if (value.length > MAX_READ_CHAPTERS) throw new AppError(422, 'too_many_chapters', '已读章节过多。')
  const ids = value.map((item) => {
    if (typeof item !== 'string') throw badRequest('章节 ID 必须是字符串。')
    validateNodeId(item)
    return item
  })
  return [...new Set(ids)]
}

function validateNodeId(nodeId: string): void {
  if (nodeId.length < 1 || nodeId.length > MAX_NODE_ID) {
    throw badRequest('章节 ID 不合法。', 'invalid_node_id')
  }
}

function validateMastery(value: unknown): Mastery['level'] {
  const level = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(level) || level < 0 || level > 5) {
    throw new AppError(422, 'invalid_mastery', '掌握度必须是 0 到 5 的整数。')
  }
  return level as Mastery['level']
}

function validateMasteryMap(value: unknown): Record<string, Mastery> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw badRequest('mastery 必须是对象。')
  const out: Record<string, Mastery> = {}
  for (const [nodeId, entry] of Object.entries(value)) {
    validateNodeId(nodeId)
    if (!isRecord(entry)) throw badRequest('掌握度条目必须是对象。')
    out[nodeId] = { level: validateMastery(entry.level), updatedAt: new Date().toISOString() }
  }
  return out
}

function validateQuestions(value: unknown, pages: number): Question[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw badRequest('questions 必须是数组。')
  if (value.length > MAX_QUESTIONS) throw new AppError(422, 'too_many_questions', `疑问最多 ${MAX_QUESTIONS} 条。`)
  return value.map((entry) => {
    if (!isRecord(entry)) throw badRequest('疑问条目必须是对象。')
    return makeQuestion(
      {
        text: entry.text as string,
        nodeId: entry.nodeId as string | undefined,
        page: entry.page as number | undefined,
      },
      pages,
      typeof entry.id === 'string' ? entry.id : undefined,
      entry.status === 'resolved' ? 'resolved' : 'open',
      typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
    )
  })
}

function makeQuestion(
  input: { text: string; nodeId?: string; page?: number },
  pages: number,
  id?: string,
  status: Question['status'] = 'open',
  createdAt?: string,
): Question {
  if (!isRecord(input) || typeof input.text !== 'string') throw badRequest('疑问内容不能为空。')
  const text = input.text.trim()
  if (text.length < 1) throw badRequest('疑问内容不能为空。')
  if (text.length > MAX_QUESTION_TEXT) throw new AppError(422, 'question_too_long', '疑问内容过长。')
  if (input.nodeId !== undefined) {
    if (typeof input.nodeId !== 'string') throw badRequest('章节 ID 必须是字符串。')
    validateNodeId(input.nodeId)
  }
  const page = input.page === undefined ? undefined : validatePage(input.page, pages)
  return {
    id: id ?? `q-${Math.random().toString(16).slice(2, 14)}`,
    text,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(page !== undefined ? { page } : {}),
    status,
    createdAt: createdAt ?? new Date().toISOString(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const _internalProgress = { PROGRESS_FILE, MAX_QUESTIONS }
