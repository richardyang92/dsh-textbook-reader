/**
 * Adaptive MinerU artifact discovery.
 *
 * The cloud API's zip layout is not guaranteed: content lists are often
 * UUID-prefixed, layout.json may be middle.json, and a full.md sits beside
 * image files. We inspect candidates by shape, not by a fixed filename.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const MAX_JSON_BYTES = 128 * 1024 * 1024
const MAX_MARKDOWN_BYTES = 32 * 1024 * 1024

export interface DiscoveredArtifacts {
  contentList?: unknown[]
  contentListFile?: string
  layout?: Record<string, unknown>
  layoutFile?: string
  markdown?: string
  markdownFile?: string
  imageFiles: string[]
  warnings: string[]
}

export async function discoverArtifacts(root: string): Promise<DiscoveredArtifacts> {
  const warnings: string[] = []
  const files = await listFiles(root)
  let contentList: unknown[] | undefined
  let contentListFile: string | undefined
  let contentListScore = -Infinity
  let layout: Record<string, unknown> | undefined
  let layoutFile: string | undefined
  let layoutScore = -Infinity
  let markdownFile: string | undefined
  let markdown: string | undefined
  let markdownSize = 0
  const imageFiles: string[] = []

  for (const file of files) {
    const relativePath = relative(root, file)
    const extension = extname(file).toLowerCase()
    if (isImage(extension)) imageFiles.push(relativePath)
    if (extension === '.md') {
      try {
        const info = await stat(file)
        if (info.size > MAX_MARKDOWN_BYTES) {
          warnings.push(`Markdown 过大已跳过：${relativePath}`)
          continue
        }
        if (info.size > markdownSize) {
          markdown = await readFile(file, 'utf8')
          markdownFile = relativePath
          markdownSize = info.size
        }
      } catch {
        warnings.push(`Markdown 读取失败：${relativePath}`)
      }
      continue
    }
    if (extension !== '.json') continue

    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    if (info.size > MAX_JSON_BYTES) {
      warnings.push(`JSON 过大已跳过：${relativePath}`)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      warnings.push(`JSON 无法解析：${relativePath}`)
      continue
    }

    if (Array.isArray(parsed)) {
      const withPage = parsed.filter(
        (item) => isRecord(item) && (typeof item.page_idx === 'number' || Number.isFinite(Number(item.page_idx))),
      ).length
      if (withPage > 0) {
        const score = withPage * 10 + (/content[_-]?list/i.test(relativePath) ? 1000 : 0)
        if (score > contentListScore) {
          contentList = parsed
          contentListFile = relativePath
          contentListScore = score
        }
      }
      continue
    }

    if (isRecord(parsed) && Array.isArray(parsed.pdf_info)) {
      const score = parsed.pdf_info.length * 10 + (/layout|middle/i.test(relativePath) ? 1000 : 0)
      if (score > layoutScore) {
        layout = parsed
        layoutFile = relativePath
        layoutScore = score
      }
    }
  }

  if (!contentList && !layout) {
    warnings.push('解析结果中没有 content_list 或 layout，无法生成页码锚点。')
  }
  return {
    ...(contentList ? { contentList } : {}),
    ...(contentListFile ? { contentListFile } : {}),
    ...(layout ? { layout } : {}),
    ...(layoutFile ? { layoutFile } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
    ...(markdownFile ? { markdownFile } : {}),
    imageFiles,
    warnings,
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 6) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  await walk(root, 0)
  return out.sort()
}

function isImage(extension: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(extension)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
