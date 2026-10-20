/**
 * Local PDF splitting for documents above MinerU's 600-page task limit.
 *
 * The split is a plain document operation (pdf-lib); no local OCR/model is
 * involved. Page numbers stay 1-based in the merged reader.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { AppError } from '../errors.js'

export interface PageRange {
  from: number
  to: number
}

export interface SplitPart {
  index: number
  range: PageRange
  file: string
  pages: number
}

/** Copy each inclusive page range into its own PDF file under `outDir`. */
export async function splitPdf(source: string, ranges: PageRange[], outDir: string): Promise<SplitPart[]> {
  const sourceBytes = await readFile(source).catch(() => {
    throw new AppError(404, 'pdf_missing', 'PDF 源文件不存在。')
  })
  let sourceDoc: PDFDocument
  try {
    sourceDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false })
  } catch {
    throw new AppError(422, 'pdf_invalid', 'PDF 无法读取，不能分段。')
  }
  const total = sourceDoc.getPageCount()
  await mkdir(outDir, { recursive: true, mode: 0o700 })
  const parts: SplitPart[] = []
  for (const [index, range] of ranges.entries()) {
    if (range.from < 1 || range.to > total || range.to < range.from) {
      throw new AppError(422, 'split_range_invalid', `分段范围 ${range.from}-${range.to} 超出 PDF 页数 ${total}。`)
    }
    const output = await PDFDocument.create()
    const pageIndices = Array.from({ length: range.to - range.from + 1 }, (_, offset) => range.from - 1 + offset)
    const pages = await output.copyPages(sourceDoc, pageIndices)
    for (const page of pages) output.addPage(page)
    const file = join(outDir, `part-${index + 1}.pdf`)
    const bytes = await output.save()
    await writeFile(file, bytes, { mode: 0o600 })
    await chmod(file, 0o600).catch(() => {})
    parts.push({ index: index + 1, range, file, pages: pageIndices.length })
  }
  return parts
}
