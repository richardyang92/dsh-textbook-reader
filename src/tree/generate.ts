/**
 * Chapter-tree generation.
 *
 * MinerU hands back a flat heading list. This module turns it into the MVP's
 * three-level model (book -> chapter -> section) with page ranges. When the
 * document is too flat to infer structure, it degrades to page-window chapters
 * and records a warning instead of fabricating certainty.
 */

import type { Heading, Tree, TreeNode } from '../types.js'
import { randomId } from '../store/atomic.js'

const MAX_NODES = 2_000
const MAX_TITLE = 160
const SYNTHETIC_CHAPTER_PAGES = 25

const CHAPTER_PATTERN = /^(第\s*[一二三四五六七八九十百千零〇0-9]+\s*[章篇部])|^((chapter|unit|part|book)\s+[0-9ivxlcdm]+)/i
const SECTION_PATTERN =
  /^(\d+\.\d+(\.\d+)*)|^(第\s*[一二三四五六七八九十百千零〇0-9]+\s*节)|^([（(]\s*[一二三四五六七八九十0-9]+\s*[)）])|^([一二三四五六七八九十]+\s*[、.．])|^(\d+\s*[)）.．]\s*\S)/

export interface GenerateTreeInput {
  bookId: string
  bookTitle: string
  pages: number
  headings: Heading[]
}

export interface GenerateTreeResult {
  tree: Tree
  warnings: string[]
}

export function generateTree(input: GenerateTreeInput): GenerateTreeResult {
  const pages = Math.max(1, Math.trunc(input.pages))
  const warnings: string[] = []
  const headings = sanitizeHeadings(input.headings, pages)
  const now = new Date().toISOString()

  if (headings.length === 0) {
    warnings.push('未识别到标题，已按页数自动分章；请手动改名或调整层级。')
    const chapters = syntheticChapters(pages)
    return {
      tree: finalizeTree(input.bookId, input.bookTitle, chapters, warnings, now),
      warnings,
    }
  }

  const levels = [...new Set(headings.map((heading) => heading.level))].sort((a, b) => a - b)
  let chapterHeadings: Heading[]
  let sectionHeadings: Heading[]

  if (levels.length >= 2) {
    const chapterLevel = levels[0]!
    const bookTitleIndex = findBookTitle(headings, chapterLevel, input.bookTitle)
    const effective = bookTitleIndex >= 0 ? headings.filter((_, index) => index !== bookTitleIndex) : headings
    const effectiveLevels = [...new Set(effective.map((heading) => heading.level))].sort((a, b) => a - b)
    const effectiveChapterLevel = effectiveLevels[0] ?? chapterLevel
    chapterHeadings = effective.filter((heading) => heading.level === effectiveChapterLevel)
    sectionHeadings = effective.filter((heading) => heading.level !== effectiveChapterLevel)
    if (chapterHeadings.length === 0) {
      warnings.push('只识别到节级标题，已归入“全书”一章。')
    }
  } else {
    const classified = headings.map((heading) => ({
      heading,
      chapter: CHAPTER_PATTERN.test(normalizeHeadingText(heading.text)),
      section: SECTION_PATTERN.test(normalizeHeadingText(heading.text)),
    }))
    const hasChapterPattern = classified.some((item) => item.chapter)
    const hasSectionPattern = classified.some((item) => item.section)
    if (hasChapterPattern) {
      chapterHeadings = classified.filter((item) => item.chapter).map((item) => item.heading)
      sectionHeadings = classified.filter((item) => !item.chapter).map((item) => item.heading)
    } else if (hasSectionPattern) {
      warnings.push('标题只有一个层级，已按“全书 → 节”组织；请手动纠正章节层级。')
      chapterHeadings = []
      sectionHeadings = headings
    } else {
      warnings.push('标题只有一个层级且无编号线索，已把每个标题作为一章；请手动合并/纠层。')
      chapterHeadings = headings
      sectionHeadings = []
    }
  }

  if (chapterHeadings.length === 0) {
    const bookChapter: Heading = {
      blockId: 'synthetic-book',
      page: 1,
      level: 1,
      text: '全书',
    }
    chapterHeadings = [bookChapter]
  }

  chapterHeadings = chapterHeadings
    .slice()
    .sort(byPage)
    .slice(0, MAX_NODES)
  sectionHeadings = sectionHeadings
    .slice()
    .sort(byPage)
    .slice(0, MAX_NODES)

  const chapterNodes: TreeNode[] = chapterHeadings.map((heading, index) => {
    const next = chapterHeadings[index + 1]
    const pageStart = clampPage(heading.page, pages)
    return {
      id: randomId('n'),
      title: cleanTitle(heading.text) || `第 ${index + 1} 章`,
      level: 1,
      pageStart,
      pageEnd: next ? Math.max(pageStart, clampPage(next.page, pages) - 1) : pages,
      children: [],
      source: 'auto',
      order: index,
    }
  })

  const sectionsByChapter = new Map<string, Heading[]>()
  for (const section of sectionHeadings) {
    const chapter = chapterForPage(chapterNodes, section.page)
    if (!chapter) {
      // A section before the first chapter cannot attach; keep it as a chapter
      // rather than losing navigation to that page.
      const pageStart = clampPage(section.page, pages)
      chapterNodes.push({
        id: randomId('n'),
        title: cleanTitle(section.text) || '开篇',
        level: 1,
        pageStart,
        pageEnd: pages,
        children: [],
        source: 'auto',
        order: chapterNodes.length,
      })
      continue
    }
    const list = sectionsByChapter.get(chapter.id) ?? []
    list.push(section)
    sectionsByChapter.set(chapter.id, list)
  }

  for (const chapter of chapterNodes) {
    const sections = (sectionsByChapter.get(chapter.id) ?? []).sort(byPage)
    for (let index = 0; index < sections.length; index += 1) {
      const heading = sections[index]!
      const next = sections[index + 1]
      const pageStart = clampPage(heading.page, pages)
      const pageEnd = next ? Math.max(pageStart, clampPage(next.page, pages) - 1) : chapter.pageEnd
      const section: TreeNode = {
        id: randomId('n'),
        title: cleanTitle(heading.text) || `第 ${chapter.order + 1}.${index + 1} 节`,
        level: 2,
        pageStart,
        pageEnd: Math.max(pageStart, Math.min(pageEnd, chapter.pageEnd)),
        parentId: chapter.id,
        children: [],
        source: 'auto',
        order: index,
      }
      chapter.children.push(section.id)
      chapterNodes.push(section)
    }
  }

  if (chapterNodes.length > MAX_NODES) {
    warnings.push(`标题过多，已截断到 ${MAX_NODES} 个节点。`)
  }

  return {
    tree: finalizeTree(input.bookId, input.bookTitle, chapterNodes.slice(0, MAX_NODES), warnings, now),
    warnings,
  }
}

function finalizeTree(
  bookId: string,
  bookTitle: string,
  nodes: TreeNode[],
  warnings: string[],
  now: string,
): Tree {
  // Chapters are ordered by page, then sections follow their parent; flatten
  // into one node array while preserving stable ids.
  const chapters = nodes.filter((node) => node.level === 1).sort((a, b) => a.pageStart - b.pageStart || a.order - b.order)
  const flat: TreeNode[] = []
  for (const chapter of chapters) {
    chapter.children = chapter.children.filter((id) => nodes.some((node) => node.id === id && node.level === 2))
    flat.push(chapter)
    for (const childId of chapter.children) {
      const child = nodes.find((node) => node.id === childId)
      if (child) flat.push(child)
    }
  }
  // Any orphan section (defensive) is dropped from the visible tree.
  return {
    version: 1,
    bookId,
    rootTitle: cleanTitle(bookTitle) || '教材',
    nodes: flat,
    warnings,
    generatedAt: now,
    updatedAt: now,
  }
}

function syntheticChapters(pages: number): TreeNode[] {
  const nodes: TreeNode[] = []
  for (let from = 1, index = 0; from <= pages; from += SYNTHETIC_CHAPTER_PAGES, index += 1) {
    const to = Math.min(pages, from + SYNTHETIC_CHAPTER_PAGES - 1)
    nodes.push({
      id: randomId('n'),
      title: `第 ${index + 1} 章 · 第 ${from}–${to} 页`,
      level: 1,
      pageStart: from,
      pageEnd: to,
      children: [],
      source: 'auto',
      order: index,
    })
  }
  return nodes
}

function sanitizeHeadings(headings: Heading[], pages: number): Heading[] {
  const seen = new Set<string>()
  const out: Heading[] = []
  for (const heading of headings) {
    if (!heading || typeof heading.text !== 'string') continue
    const text = cleanTitle(heading.text)
    if (!text) continue
    const level = Number.isFinite(heading.level) ? Math.min(6, Math.max(1, Math.trunc(heading.level))) : 1
    const page = clampPage(heading.page, pages)
    const key = `${page}|${level}|${text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ blockId: heading.blockId, page, level, text })
  }
  return out
}

function findBookTitle(headings: Heading[], chapterLevel: number, bookTitle: string): number {
  const first = headings[0]
  if (!first || first.level !== chapterLevel || first.page > 2) return -1
  const left = normalizeHeadingText(first.text)
  const right = normalizeHeadingText(bookTitle)
  if (!left || !right) return -1
  return left === right || (left.length > 4 && right.includes(left)) ? 0 : -1
}

function chapterForPage(chapters: TreeNode[], page: number): TreeNode | undefined {
  let found: TreeNode | undefined
  for (const chapter of chapters) {
    if (chapter.pageStart <= page) found = chapter
    else break
  }
  return found
}

function byPage(a: Heading, b: Heading): number {
  return a.page - b.page || a.blockId.localeCompare(b.blockId)
}

function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function cleanTitle(text: string): string {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
}

function clampPage(page: number, pages: number): number {
  const value = Number.isFinite(page) ? Math.trunc(page) : 1
  return Math.min(Math.max(value, 1), pages)
}
