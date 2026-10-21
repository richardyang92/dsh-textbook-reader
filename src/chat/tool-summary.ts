/**
 * One-line digests for tool calls in the tutor chat.
 *
 * The chat renders every call on a single row, so a summary must stay short,
 * free of raw JSON, and readable on its own. The subagent backend owns the
 * full result text and calls `summarizeToolResult` before emitting the event;
 * the browser half runs the same function as a fallback so an older host, or a
 * backend that only forwards transport text, still produces a digest.
 */

/** Longest digest kept verbatim; longer text is clipped with an ellipsis. */
const MAX_SUMMARY = 96

/** Summarize the arguments of a call that is still running. */
export function summarizeToolArgs(name: string, raw: unknown): string | undefined {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return undefined
  const value = parseRecord(oneLine(text))
  if (value) {
    if (typeof value.query === 'string' && value.query.trim()) {
      return `“${clip(value.query, 36)}”`
    }
    if (typeof value.book === 'string' && value.book.trim()) {
      return clip(value.book, 36)
    }
    if (typeof value.command === 'string' && value.command.trim()) {
      return clip(value.command, 60)
    }
    if (typeof value.path === 'string' && value.path.trim()) {
      return clip(value.path, 48)
    }
  }
  return clip(oneLine(text), MAX_SUMMARY)
}

/** Summarize a settled call result (or its failure) for the collapsed row. */
export function summarizeToolResult(name: string, text: string, error = false): string | undefined {
  const raw = oneLine(text)
  if (!raw) return error ? '失败' : undefined
  if (error) {
    // A digest that already came from the host keeps its own wording.
    if (raw.startsWith('失败')) return clip(raw, MAX_SUMMARY)
    const record = parseRecord(raw)
    const message = record && typeof record.message === 'string' ? record.message : stringField(raw, 'message')
    return `失败：${clip(message ?? raw, 80)}`
  }
  const value = parseRecord(raw)
  if (value) {
    const digest = digestFor(name, value)
    if (digest) return digest
  }
  // A host that only forwards a truncated JSON preview (older builds capped
  // tool results at 200 chars) cannot be parsed. Keep the row readable by
  // lifting the one field that names the call instead of printing the braces.
  const partial = partialDigest(raw)
  if (partial) return partial
  return clip(raw, MAX_SUMMARY)
}

function partialDigest(raw: string): string | undefined {
  if (!raw.startsWith('{')) return undefined
  const query = stringField(raw, 'query')
  if (query) return `“${clip(query, 18)}”`
  const title = stringField(raw, 'title') ?? stringField(raw, 'rootTitle')
  if (title) return clip(title, 40)
  const status = stringField(raw, 'status')
  return status ? `${parseStatus({ status })}` : undefined
}

/** Read one JSON string field from possibly truncated JSON text. */
function stringField(raw: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw)
  if (!match) return undefined
  try {
    const value = JSON.parse(`"${match[1]}"`) as unknown
    return typeof value === 'string' && value.trim() ? value : undefined
  } catch {
    return match[1]
  }
}

function digestFor(name: string, value: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'textbook_list': {
      const books = arrayOf(value.books)
      const active = books.find((book) => recordOf(book)?.active === true)
      const title = recordOf(active)?.title
      return typeof title === 'string' && title.trim()
        ? `${books.length} 本教材 · 当前《${clip(title, 20)}》`
        : `${books.length} 本教材`
    }
    case 'textbook_search': {
      const hits = arrayOf(value.hits)
      const query = typeof value.query === 'string' ? value.query.trim() : ''
      const head = query ? `“${clip(query, 18)}”` : ''
      if (hits.length === 0) return [head, '没有命中'].filter(Boolean).join(' · ')
      const pages = hits
        .map((hit) => Number(recordOf(hit)?.page))
        .filter((page) => Number.isInteger(page) && page > 0)
        .sort((left, right) => left - right)
      const span = pageSpan(pages)
      return [head, `命中 ${hits.length} 段`, span].filter(Boolean).join(' · ')
    }
    case 'textbook_tree': {
      const tree = recordOf(value.tree)
      if (!tree) return `解析状态：${parseStatus(value.parse)}`
      const chapters = arrayOf(tree.chapters)
      const sections = chapters.reduce<number>(
        (total, chapter) => total + arrayOf(recordOf(chapter)?.children).length,
        0,
      )
      return `章节树 · ${chapters.length} 章${sections ? ` · ${sections} 节` : ''}`
    }
    case 'textbook_progress': {
      const progress = recordOf(value.progress)
      const parts: string[] = []
      const page = Number(progress?.currentPage)
      if (Number.isInteger(page) && page > 0) parts.push(`读到 p.${page}`)
      const read = arrayOf(progress?.readChapters).length
      if (read) parts.push(`已读 ${read} 节`)
      const questions = arrayOf(progress?.questions).length
      if (questions) parts.push(`${questions} 个疑问`)
      return parts.join(' · ') || '暂无进度'
    }
    case 'textbook_parse': {
      return value.started === true ? '已提交解析' : `解析状态：${parseStatus(value.parse)}`
    }
    case 'textbook_add': {
      const book = recordOf(value.book)
      const title = book && typeof book.title === 'string' ? book.title : ''
      return title.trim() ? `已加入《${clip(title, 20)}》` : '已加入书架'
    }
    default:
      return undefined
  }
}

const PARSE_STATUS_LABELS: Record<string, string> = {
  ready: '已解析',
  running: '解析中',
  pending: '等待解析',
  idle: '未解析',
  failed: '解析失败',
}

function parseStatus(value: unknown): string {
  const status = recordOf(value)?.status
  if (typeof status !== 'string' || !status.trim()) return '未知'
  return PARSE_STATUS_LABELS[status] ?? status
}

function pageSpan(pages: number[]): string {
  if (pages.length === 0) return ''
  const first = pages[0]
  const last = pages[pages.length - 1]
  return first === last ? `p.${first}` : `p.${first}–${last}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  const value = oneLine(text)
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith('{')) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return recordOf(value)
  } catch {
    return undefined
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
