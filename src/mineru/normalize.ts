/**
 * Normalize MinerU artifacts into one stable page/block model.
 *
 * content_list.json is preferred because it carries normalized page boxes and
 * text_level. layout.json is the fallback (raw PDF-point boxes, line/span
 * nesting). Markdown alone cannot give page anchors, so it is never presented
 * as if it could.
 */

import type { Block, Heading, NormalizedBook, NormalizedPage } from '../types.js'

const CHAPTER_PATTERN = /^(第\s*[一二三四五六七八九十百千零〇0-9]+\s*[章篇部])|^((chapter|unit|part|book)\s+[0-9ivxlcdm]+)/i
const SECTION_PATTERN =
  /^(\d+\.\d+(\.\d+)*)|^(第\s*[一二三四五六七八九十百千零〇0-9]+\s*节)|^([（(]\s*[一二三四五六七八九十0-9]+\s*[)）])|^([一二三四五六七八九十]+\s*[、.．])/

export interface NormalizeInput {
  bookId: string
  pages: number
  contentList?: unknown[]
  layout?: Record<string, unknown>
  markdown?: string
  source: {
    contentListFile?: string
    layoutFile?: string
    markdownFile?: string
  }
}

export interface NormalizeResult {
  normalized: NormalizedBook
  warnings: string[]
}

export function normalizeArtifacts(input: NormalizeInput): NormalizeResult {
  const warnings: string[] = []
  const pages = Math.max(1, Math.trunc(input.pages))
  const pageSizes = readPageSizes(input.layout, warnings)
  const pageBlocks = new Map<number, Block[]>()
  for (let page = 1; page <= pages; page += 1) pageBlocks.set(page, [])
  let sequence = 0
  let skippedPages = 0

  if (Array.isArray(input.contentList)) {
    for (const raw of input.contentList) {
      if (!isRecord(raw)) continue
      const pageIndex = Number(raw.page_idx)
      if (!Number.isInteger(pageIndex) || pageIndex < 0) continue
      const page = pageIndex + 1
      if (page > pages) {
        skippedPages += 1
        continue
      }
      const type = mapType(raw.type, raw)
      const text = extractText(raw, type)
      if (!text && type !== 'image' && type !== 'table') continue
      const level = type === 'title' ? inferLevel(raw.text_level, text) : undefined
      const bbox = normalizeContentBbox(raw.bbox, pageSizes.get(page), warnings)
      const imagePath = normalizeImagePath(raw.img_path ?? raw.image_path)
      sequence += 1
      const block: Block = {
        id: `b${sequence}`,
        page,
        seq: sequence,
        type,
        ...(level ? { level } : {}),
        text,
        ...(imagePath ? { image: imagePath } : {}),
        bbox,
      }
      pageBlocks.get(page)?.push(block)
    }
    if (skippedPages > 0) warnings.push(`${skippedPages} 个块的页码超出 PDF 页数，已跳过。`)
  }

  // Layout fallback only when content_list produced nothing.
  const contentBlockCount = [...pageBlocks.values()].reduce((sum, list) => sum + list.length, 0)
  if (contentBlockCount === 0 && input.layout) {
    const layoutPages = readLayoutPages(input.layout)
    for (const pageData of layoutPages) {
      const page = pageData.page
      if (page < 1 || page > pages) continue
      for (const rawBlock of pageData.blocks) {
        if (!isRecord(rawBlock)) continue
        const text = flattenLayoutBlock(rawBlock)
        if (!text) continue
        const type = mapLayoutType(rawBlock.type)
        const level = type === 'title' ? inferLevel(undefined, text) : undefined
        const bbox = normalizeLayoutBbox(rawBlock.bbox, pageSizes.get(page), warnings)
        sequence += 1
        pageBlocks.get(page)?.push({
          id: `b${sequence}`,
          page,
          seq: sequence,
          type,
          ...(level ? { level } : {}),
          text,
          bbox,
        })
      }
    }
    warnings.push('content_list 缺失，已从 layout.json 重建块；页码锚点仍可用。')
  }

  let headings = collectHeadings(pageBlocks)
  if (headings.length === 0 && input.layout) {
    const layoutHeadings = collectLayoutHeadings(input.layout, pageSizes, warnings)
    if (layoutHeadings.length > 0) {
      headings = layoutHeadings
      warnings.push('content_list 未提供标题，已从 layout.json 的 title 块补充章节线索。')
    }
  }
  if (headings.length === 0) {
    warnings.push('没有识别到标题块，章节树会退化为按页分组。')
  }

  const normalizedPages: NormalizedPage[] = []
  for (let page = 1; page <= pages; page += 1) {
    const size = pageSizes.get(page)
    normalizedPages.push({
      page,
      width: size?.[0] ?? 0,
      height: size?.[1] ?? 0,
      blocks: (pageBlocks.get(page) ?? []).sort((a, b) => a.seq - b.seq),
    })
  }

  const allBlocks = normalizedPages.flatMap((page) => page.blocks)
  const stats = {
    blocks: allBlocks.length,
    textBlocks: allBlocks.filter((block) => block.type === 'text').length,
    titleBlocks: allBlocks.filter((block) => block.type === 'title').length,
    images: allBlocks.filter((block) => block.type === 'image' || Boolean(block.image)).length,
    tables: allBlocks.filter((block) => block.type === 'table').length,
  }

  if (allBlocks.length === 0) {
    warnings.push('没有任何可定位的内容块；阅读器只能显示 PDF 页面。')
  }

  return {
    normalized: {
      version: 1,
      bookId: input.bookId,
      pages: normalizedPages,
      headings,
      warnings,
      source: {
        ...input.source,
        ...(typeof input.layout?._backend === 'string' ? { backend: input.layout._backend } : {}),
        ...(typeof input.layout?._version_name === 'string' ? { versionName: input.layout._version_name } : {}),
      },
      stats,
    },
    warnings,
  }
}

export function stripHtml(input: string): string {
  if (typeof input !== 'string') return ''
  return decodeEntities(
    input
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractText(item: Record<string, unknown>, type: Block['type']): string {
  const pieces: string[] = []
  if (typeof item.text === 'string') pieces.push(item.text)
  for (const key of ['table_caption', 'table_footnote', 'image_caption', 'image_footnote']) {
    const value = item[key]
    if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string') pieces.push(entry)
  }
  if (typeof item.table_body === 'string') pieces.push(stripHtml(item.table_body))
  if (typeof item.html === 'string') pieces.push(stripHtml(item.html))
  const text = pieces.join('\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function flattenLayoutBlock(block: Record<string, unknown>): string {
  const lines = Array.isArray(block.lines) ? block.lines : []
  const pieces: string[] = []
  for (const line of lines) {
    if (!isRecord(line)) continue
    const spans = Array.isArray(line.spans) ? line.spans : []
    for (const span of spans) {
      if (isRecord(span) && typeof span.content === 'string') pieces.push(span.content)
    }
  }
  if (pieces.length === 0) {
    const nested = Array.isArray(block.blocks) ? block.blocks : []
    for (const child of nested) if (isRecord(child)) pieces.push(flattenLayoutBlock(child))
  }
  return pieces.join(' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
}

function mapType(type: unknown, item: Record<string, unknown>): Block['type'] {
  const value = typeof type === 'string' ? type.toLowerCase() : ''
  if (value === 'text') {
    const level = Number(item.text_level)
    return Number.isInteger(level) && level > 0 ? 'title' : 'text'
  }
  if (value === 'title' || value === 'heading') return 'title'
  if (value === 'table') return 'table'
  if (value === 'image' || value === 'figure') return 'image'
  if (value === 'equation' || value === 'interline_equation') return 'equation'
  if (value === 'list') return 'list'
  return 'other'
}

function mapLayoutType(type: unknown): Block['type'] {
  const value = typeof type === 'string' ? type.toLowerCase() : ''
  if (value === 'title' || value === 'heading') return 'title'
  if (value === 'table' || value === 'table_body') return 'table'
  if (value === 'image' || value === 'image_body') return 'image'
  if (value === 'interline_equation' || value === 'equation') return 'equation'
  if (value === 'list') return 'list'
  if (value === 'text') return 'text'
  return 'other'
}

function inferLevel(rawLevel: unknown, text: string): number {
  const level = Number(rawLevel)
  if (Number.isInteger(level) && level > 0) return Math.min(6, level)
  const clean = text.trim()
  if (CHAPTER_PATTERN.test(clean)) return 1
  if (SECTION_PATTERN.test(clean)) return 2
  return 1
}

function normalizeContentBbox(
  raw: unknown,
  pageSize: [number, number] | undefined,
  warnings: string[],
): [number, number, number, number] {
  const values = toBbox(raw)
  if (!values) return [0, 0, 0, 0]
  const max = Math.max(...values.map((value) => Math.abs(value)))
  if (max > 1000) {
    if (!pageSize || pageSize[0] <= 0 || pageSize[1] <= 0) {
      warnings.push('content_list 的 bbox 超过 1000 且缺少页面尺寸，已忽略该块位置。')
      return [0, 0, 0, 0]
    }
    return normalizePoints(values, pageSize)
  }
  return clampNormalized(values)
}

function normalizeLayoutBbox(
  raw: unknown,
  pageSize: [number, number] | undefined,
  warnings: string[],
): [number, number, number, number] {
  const values = toBbox(raw)
  if (!values) return [0, 0, 0, 0]
  if (!pageSize || pageSize[0] <= 0 || pageSize[1] <= 0) {
    warnings.push('layout.json 的块缺少页面尺寸，已忽略该块位置。')
    return [0, 0, 0, 0]
  }
  return normalizePoints(values, pageSize)
}

function normalizePoints(values: [number, number, number, number], pageSize: [number, number]): [number, number, number, number] {
  const [x0, y0, x1, y1] = values
  return clampNormalized([
    (x0 / pageSize[0]) * 1000,
    (y0 / pageSize[1]) * 1000,
    (x1 / pageSize[0]) * 1000,
    (y1 / pageSize[1]) * 1000,
  ])
}

function clampNormalized(values: [number, number, number, number]): [number, number, number, number] {
  const [rawX0, rawY0, rawX1, rawY1] = values
  const x0 = Math.min(1000, Math.max(0, rawX0))
  const y0 = Math.min(1000, Math.max(0, rawY0))
  const x1 = Math.min(1000, Math.max(x0, rawX1))
  const y1 = Math.min(1000, Math.max(y0, rawY1))
  return [round(x0), round(y0), round(x1), round(y1)]
}

function toBbox(raw: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length < 4) return undefined
  const values = raw.slice(0, 4).map(Number)
  if (values.some((value) => !Number.isFinite(value))) return undefined
  return values as [number, number, number, number]
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function normalizeImagePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (!value || value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.split('/').includes('..')) return undefined
  if (/^https?:/i.test(value)) return undefined
  return value.slice(0, 500)
}

function readPageSizes(layout: Record<string, unknown> | undefined, warnings: string[]): Map<number, [number, number]> {
  const map = new Map<number, [number, number]>()
  if (!layout || !Array.isArray(layout.pdf_info)) return map
  for (const raw of layout.pdf_info) {
    if (!isRecord(raw)) continue
    const page = Number(raw.page_idx) + 1
    const size = Array.isArray(raw.page_size) ? raw.page_size.map(Number) : undefined
    if (Number.isInteger(page) && page > 0 && size && size.length >= 2 && size[0]! > 0 && size[1]! > 0) {
      map.set(page, [size[0]!, size[1]!])
    } else if (Number.isInteger(page) && page > 0) {
      warnings.push(`layout.json 第 ${page} 页缺少 page_size。`)
    }
  }
  return map
}

function readLayoutPages(layout: Record<string, unknown>): Array<{ page: number; blocks: unknown[] }> {
  const out: Array<{ page: number; blocks: unknown[] }> = []
  if (!Array.isArray(layout.pdf_info)) return out
  for (const raw of layout.pdf_info) {
    if (!isRecord(raw)) continue
    const page = Number(raw.page_idx) + 1
    const blocks = Array.isArray(raw.para_blocks)
      ? raw.para_blocks
      : Array.isArray(raw.preproc_blocks)
        ? raw.preproc_blocks
        : []
    if (Number.isInteger(page) && page > 0) out.push({ page, blocks })
  }
  return out
}

function collectHeadings(pageBlocks: Map<number, Block[]>): Heading[] {
  const headings: Heading[] = []
  for (const [page, blocks] of [...pageBlocks.entries()].sort((a, b) => a[0] - b[0])) {
    for (const block of blocks) {
      if (block.type !== 'title' || !block.text) continue
      headings.push({ blockId: block.id, page, level: block.level ?? 1, text: block.text })
    }
  }
  return headings
}

function collectLayoutHeadings(
  layout: Record<string, unknown>,
  pageSizes: Map<number, [number, number]>,
  warnings: string[],
): Heading[] {
  const pageBlocks = new Map<number, Block[]>()
  let sequence = 0
  for (const pageData of readLayoutPages(layout)) {
    for (const rawBlock of pageData.blocks) {
      if (!isRecord(rawBlock) || mapLayoutType(rawBlock.type) !== 'title') continue
      const text = flattenLayoutBlock(rawBlock)
      if (!text) continue
      sequence += 1
      const block: Block = {
        id: `layout-h${sequence}`,
        page: pageData.page,
        seq: sequence,
        type: 'title',
        level: inferLevel(undefined, text),
        text,
        bbox: normalizeLayoutBbox(rawBlock.bbox, pageSizes.get(pageData.page), warnings),
      }
      const list = pageBlocks.get(pageData.page) ?? []
      list.push(block)
      pageBlocks.set(pageData.page, list)
    }
  }
  return collectHeadings(pageBlocks)
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const key = entity.toLowerCase()
    if (key === 'amp') return '&'
    if (key === 'lt') return '<'
    if (key === 'gt') return '>'
    if (key === 'quot') return '"'
    if (key === 'apos') return "'"
    if (key === 'nbsp') return ' '
    const numeric = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : key.startsWith('#') ? Number.parseInt(key.slice(1), 10) : Number.NaN
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff) return match
    try {
      return String.fromCodePoint(numeric)
    } catch {
      return match
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const _internalNormalize = { mapType, mapLayoutType, inferLevel, normalizeImagePath }
