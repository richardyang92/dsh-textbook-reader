/** Lightweight in-memory search over normalized textbook blocks. */

import type { NormalizedBook, Tree, TreeNode } from './types.js'

export interface SearchHit {
  page: number
  blockId: string
  bbox: [number, number, number, number]
  text: string
  section: string
  score: number
}

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const MAX_TEXT = 800

export function searchNormalized(
  normalized: NormalizedBook,
  tree: Tree | undefined,
  rawQuery: string,
  limit = DEFAULT_LIMIT,
  nodeId?: string,
): SearchHit[] {
  const query = String(rawQuery ?? '').trim()
  if (!query) return []
  const wanted = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit) || DEFAULT_LIMIT))
  const tokens = queryTokens(query)
  const scope = nodeId ? nodePageRange(tree, nodeId) : undefined
  const hits: SearchHit[] = []

  for (const page of normalized.pages) {
    if (scope && (page.page < scope.start || page.page > scope.end)) continue
    for (const block of page.blocks) {
      if (!block.text || block.text.trim().length === 0) continue
      const haystack = block.text.toLowerCase()
      const score = scoreBlock(haystack, query.toLowerCase(), tokens, block.type)
      if (score <= 0) continue
      const section = sectionPath(tree, page.page)
      hits.push({
        page: page.page,
        blockId: block.id,
        bbox: block.bbox,
        text: snippet(block.text, query),
        section,
        score,
      })
    }
  }

  hits.sort((a, b) => b.score - a.score || a.page - b.page)
  return hits.slice(0, wanted)
}

function scoreBlock(haystack: string, query: string, tokens: string[], type: string): number {
  let score = 0
  const direct = haystack.indexOf(query)
  if (direct >= 0) {
    score += 100
    let index = direct
    let occurrences = 0
    while (index >= 0 && occurrences < 10) {
      occurrences += 1
      index = haystack.indexOf(query, index + query.length)
    }
    score += occurrences * 4
  }
  for (const token of tokens) {
    if (token.length < 2 && !/[a-z0-9]/i.test(token)) continue
    const at = haystack.indexOf(token)
    if (at >= 0) score += token.length >= 4 ? 12 : 6
  }
  if (score === 0) return 0
  if (type === 'title') score += 24
  else if (type === 'table') score += 4
  return score
}

function queryTokens(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/[\s,，。；;、:：!?！？()（）[\]{}"'“”‘’]+/)
    .map((token) => token.trim())
    .filter(Boolean)
  const out = new Set(raw)
  const compact = query.replace(/\s+/g, '')
  if (compact.length >= 2 && !/[a-z0-9]/i.test(compact)) {
    out.add(compact)
    for (let index = 0; index < compact.length - 1; index += 1) out.add(compact.slice(index, index + 2))
  }
  return [...out]
}

function snippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_TEXT) return normalized
  const index = normalized.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return `${normalized.slice(0, MAX_TEXT)}…`
  const start = Math.max(0, index - 120)
  return `${start > 0 ? '…' : ''}${normalized.slice(start, start + MAX_TEXT)}…`
}

function sectionPath(tree: Tree | undefined, page: number): string {
  if (!tree) return ''
  const chapter = tree.nodes
    .filter((node) => node.level === 1)
    .find((node) => page >= node.pageStart && page <= node.pageEnd)
  if (!chapter) return ''
  const section = chapter.children
    .map((id) => tree.nodes.find((node) => node.id === id))
    .find((node): node is TreeNode => {
      if (!node) return false
      return page >= node.pageStart && page <= node.pageEnd
    })
  return section ? `${chapter.title} / ${section.title}` : chapter.title
}

function nodePageRange(tree: Tree | undefined, nodeId: string): { start: number; end: number } | undefined {
  const node = tree?.nodes.find((item) => item.id === nodeId)
  return node ? { start: node.pageStart, end: node.pageEnd } : undefined
}
