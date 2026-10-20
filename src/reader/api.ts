/** Reader-side API types and fetch helpers. */

export const API = '/textbook-reader'

export interface Book {
  id: string
  title: string
  pages: number
  bytes: number
  createdAt: string
  updatedAt: string
  parse: {
    status: string
    progress?: number
    warnings: string[]
    error?: { code: string; message: string; hint?: string }
  }
}

export interface BookSummary {
  id: string
  title: string
  pages: number
  bytes: number
  parseStatus: string
  parseProgress?: number
  currentPage: number
  pagePercent: number
  readChapterCount: number
  active: boolean
}

export interface Question {
  id: string
  text: string
  nodeId?: string
  page?: number
  status: 'open' | 'resolved'
  createdAt: string
}

export interface Progress {
  currentPage: number
  readChapters: string[]
  mastery: Record<string, { level: number; updatedAt: string }>
  questions: Question[]
  updatedAt: string
}

export interface TreeNode {
  id: string
  title: string
  level: 1 | 2
  pageStart: number
  pageEnd: number
  parentId?: string
  children: string[]
  source: 'auto' | 'manual'
  order: number
}

export interface Tree {
  version: 1
  bookId: string
  rootTitle: string
  nodes: TreeNode[]
  warnings: string[]
}

export interface Block {
  id: string
  page: number
  seq: number
  type: string
  level?: number
  text: string
  image?: string
  bbox: [number, number, number, number]
}

export interface PageData {
  page: number
  width: number
  height: number
  blocks: Block[]
}

export interface ConfigPayload {
  settings: {
    mineru: { modelVersion: string; isOcr: boolean; enableTable: boolean; language: string }
    captionVlm: { enabled: boolean }
  }
  token: { configured: boolean; mask: string; updatedAt?: string }
  capabilities: { mineru: boolean; captionVlm: boolean; captionVlmNote: string }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly hint?: string

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.hint = hint
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(API + path, {
    ...options,
    cache: 'no-store',
    headers: { ...(options.headers ?? {}) },
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!response.ok || !isRecord(payload) || payload.ok === false) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {}
    throw new ApiError(
      response.status,
      typeof error.code === 'string' ? error.code : 'request_failed',
      typeof error.message === 'string' ? error.message : `请求失败（HTTP ${response.status}）`,
      typeof error.hint === 'string' ? error.hint : undefined,
    )
  }
  return payload as T
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function statusText(status: string | undefined): string {
  return ({
    none: '未解析',
    preparing: '准备中',
    uploading: '上传中',
    polling: 'MinerU 解析中',
    downloading: '下载中',
    normalizing: '整理中',
    done: '已解析',
    failed: '解析失败',
    interrupted: '已中断',
  } as Record<string, string>)[status ?? ''] ?? status ?? '未知'
}
