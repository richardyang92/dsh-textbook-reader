/** PDF validation and metadata. Parsing stays on MinerU; this is local inspection only. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { AppError, tooLarge, unprocessable } from './errors.js'

export const MAX_PDF_BYTES = 200 * 1024 * 1024
/**
 * Largest PDF MinerU accepts in one task. The docs mention 600 for some models,
 * but the API rejects the task with "number of pages exceeds limit (200 pages)",
 * so split at the observed ceiling and let the parse manager halve again if the
 * limit ever changes.
 */
export const MAX_PAGES_PER_TASK = 200

export interface PdfInfo {
  pages: number
  bytes: number
}

/**
 * Validate a PDF file and read its page count. Rejects oversized, non-PDF and
 * encrypted files with actionable errors instead of letting a later stage fail.
 */
export async function inspectPdf(filePath: string, maxBytes = MAX_PDF_BYTES): Promise<PdfInfo> {
  let info
  try {
    info = await stat(filePath)
  } catch {
    throw new AppError(404, 'pdf_missing', 'PDF 文件不存在。')
  }
  if (!info.isFile()) throw unprocessable('pdf_invalid', '不是普通文件。')
  if (info.size <= 0) throw unprocessable('pdf_invalid', 'PDF 文件为空。')
  if (info.size > maxBytes) {
    throw tooLarge(`PDF 超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上限。`)
  }

  let data: Buffer
  try {
    data = await readFile(filePath)
  } catch {
    throw new AppError(500, 'pdf_unreadable', '无法读取 PDF 文件。')
  }
  if (data.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw unprocessable('pdf_invalid', '文件不是有效的 PDF（缺少 %PDF- 头）。')
  }

  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(data, { updateMetadata: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/encrypt/i.test(message)) {
      throw unprocessable('pdf_encrypted', 'PDF 已加密，无法解析。', '请先用 PDF 工具移除密码/加密后重试。')
    }
    throw unprocessable('pdf_invalid', 'PDF 结构无法读取，文件可能已损坏。')
  }

  let pages: number
  try {
    pages = doc.getPageCount()
  } catch {
    throw unprocessable('pdf_invalid', '无法读取 PDF 页数。')
  }
  if (pages < 1) throw unprocessable('pdf_invalid', 'PDF 没有可用页面。')
  if (pages > 100_000) throw unprocessable('pdf_invalid', 'PDF 页数异常。')

  return { pages, bytes: info.size }
}

/** Streaming SHA-256 used for duplicate detection. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise())
  })
  return hash.digest('hex')
}

/** Plan page ranges above the per-task ceiling; each range is inclusive and 1-based. */
export function planPageRanges(pages: number, maxPerTask = MAX_PAGES_PER_TASK): Array<{ from: number; to: number }> {
  if (!Number.isInteger(pages) || pages <= 0) return []
  if (!Number.isInteger(maxPerTask) || maxPerTask <= 0) throw new RangeError('maxPerTask must be positive')
  const ranges: Array<{ from: number; to: number }> = []
  for (let from = 1; from <= pages; from += maxPerTask) {
    ranges.push({ from, to: Math.min(pages, from + maxPerTask - 1) })
  }
  return ranges
}

/** MinerU page_ranges string: comma-separated ranges, e.g. `1-200,201-400`. */
export function formatPageRanges(ranges: Array<{ from: number; to: number }>): string {
  return ranges.map(({ from, to }) => (from === to ? String(from) : `${from}-${to}`)).join(',')
}
