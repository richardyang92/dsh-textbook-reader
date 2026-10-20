/** Public data shapes shared by the host half and the reader app. */

export type ParseStatus =
  | 'none'
  | 'preparing'
  | 'uploading'
  | 'polling'
  | 'downloading'
  | 'normalizing'
  | 'done'
  | 'failed'
  | 'interrupted'

export interface ParseError {
  code: string
  message: string
  hint?: string
}

export interface ParseState {
  status: ParseStatus
  progress?: number
  batchId?: string
  warnings: string[]
  error?: ParseError
}

export interface Book {
  id: string
  title: string
  /** Relative to the book directory. */
  pdf: string
  pages: number
  bytes: number
  sha256: string
  originalName?: string
  createdAt: string
  updatedAt: string
  parse: ParseState
}

export interface BookSummary {
  id: string
  title: string
  pages: number
  bytes: number
  createdAt: string
  updatedAt: string
  parseStatus: ParseStatus
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

export interface Mastery {
  level: 0 | 1 | 2 | 3 | 4 | 5
  updatedAt: string
}

export interface Progress {
  currentPage: number
  readChapters: string[]
  mastery: Record<string, Mastery>
  questions: Question[]
  updatedAt: string
}

export interface MineruSettings {
  modelVersion: 'vlm'
  isOcr: boolean
  enableTable: boolean
  language: string
}

export interface CaptionSettings {
  /** Reserved for a future vision-captioning provider; never sends requests in MVP. */
  enabled: boolean
}

export interface ReaderSettings {
  mineru: MineruSettings
  captionVlm: CaptionSettings
}

export interface TokenStatus {
  configured: boolean
  mask: string
  updatedAt?: string
}

export interface Block {
  id: string
  page: number
  seq: number
  type: 'title' | 'text' | 'table' | 'image' | 'equation' | 'list' | 'other'
  level?: number
  text: string
  image?: string
  /** Normalized 0..1000 box [x0, y0, x1, y1], top-left origin. */
  bbox: [number, number, number, number]
}

export interface Heading {
  blockId: string
  page: number
  level: number
  text: string
}

export interface NormalizedPage {
  page: number
  width: number
  height: number
  blocks: Block[]
}

export interface NormalizedBook {
  version: 1
  bookId: string
  pages: NormalizedPage[]
  headings: Heading[]
  warnings: string[]
  source: {
    contentListFile?: string
    layoutFile?: string
    markdownFile?: string
    backend?: string
    versionName?: string
  }
  stats: {
    blocks: number
    textBlocks: number
    titleBlocks: number
    images: number
    tables: number
  }
}

export interface TreeNode {
  id: string
  title: string
  /** 1 = chapter, 2 = section; the book is the implicit level 0. */
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
  generatedAt: string
  updatedAt: string
}
