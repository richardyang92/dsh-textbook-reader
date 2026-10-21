#!/usr/bin/env node
/**
 * Live C0 spike for the per-book tutor bridge.
 *
 * It talks to the running plugin over its loopback HTTP surface:
 *   books -> chat/session -> SSE /chat/events -> /chat/messages
 *
 * The script does not import plugin code. Run it after rebuilding and
 * reinstalling the plugin, with the desktop app running:
 *
 *   pnpm chat:spike --base http://127.0.0.1:<port>
 */

const args = parseArgs(process.argv.slice(2))
const base = normalizeBase(args.base ?? process.env.TEXTBOOK_READER_BASE ?? 'http://127.0.0.1:56517')
const timeoutMs = Number(args.timeout ?? 120_000)
const question = args.text ?? '用三句话介绍这一节在讲什么，并给出页码引用。'
const raw = args.raw === true
const resetMode = args['reset-mode']

main().catch((error) => {
  console.error(`\n[spike] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

async function main() {
  console.log(`[spike] base=${base}`)
  const shelf = await getJson('/api/books')
  const books = Array.isArray(shelf.books) ? shelf.books : []
  if (books.length === 0) throw new Error('书架上没有教材；先在阅读器里上传一本 PDF。')

  const book = pickBook(books, args.book ?? shelf.activeBookId)
  console.log(`[spike] book=${book.id} 《${book.title}》 pages=${book.pages} parse=${book.parseStatus}`)
  if (book.parseStatus !== 'done') {
    throw new Error(`这本书尚未解析完成（${book.parseStatus}）；先在阅读器里完成 MinerU 解析。`)
  }

  let parent = args.parent
  if (!parent || parent === 'auto') {
    try {
      const roots = await getJson('/api/chat/agents')
      parent = Array.isArray(roots.agents) ? roots.agents[0]?.id : undefined
    } catch {
      parent = undefined
    }
  }
  if (parent) console.log(`[spike] parent=${parent}`)

  const query = new URLSearchParams()
  if (resetMode) query.set('mode', resetMode)
  if (parent) query.set('parent', parent)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const session = resetMode
    ? await postJson(`/api/books/${book.id}/chat/reset${suffix}`, {})
    : await postJson(`/api/books/${book.id}/chat/session${suffix}`, {})
  console.log(`[spike] session=${session.sessionId}${resetMode ? ` mode=${resetMode}` : ''}`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(`${base}/api/books/${book.id}/chat/events`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`SSE 打开失败 HTTP ${response.status} ${body.slice(0, 300)}`)
  }
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    throw new Error(`SSE 响应类型不对：${response.headers.get('content-type')}`)
  }

  let sent = false
  let sending = false
  const state = { book, answer: '' }
  const started = Date.now()
  const decoder = new TextDecoder()
  let buffer = ''

  const sendQuestion = async () => {
    if (sent || sending) return
    sending = true
    try {
      const result = await postJson(`/api/books/${book.id}/chat/messages`, {
        text: question,
        ...(raw
          ? { raw: true }
          : {
              context: {
                page: book.currentPage ?? 1,
                progress: `${book.readChapterCount ?? 0} 节已读`,
              },
            }),
      })
      sent = true
      console.log(`[spike] accepted${raw ? ' raw' : ''} session=${result.sessionId ?? '?'} elapsed=${Date.now() - started}ms`)
    } catch (error) {
      console.error(`[spike] 发送失败：${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      controller.abort()
    } finally {
      sending = false
    }
  }

  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseFrame(frame)
        if (event) {
          const outcome = handleEvent(event, state)
          if (event.type === 'snapshot' && !sent && !sending) void sendQuestion()
          if (outcome.done) {
            console.log(`\n[spike] 完成，用时 ${Date.now() - started}ms`)
            if (state.answer.trim()) console.log(`\n${state.answer.trim()}\n`)
            return
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
    console.log(`\n[spike] SSE 在 turn-end 前结束；已收到 ${state.answer.length} 字`)
    if (state.answer.trim()) console.log(`\n${state.answer.trim()}\n`)
    process.exitCode = 1
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function handleEvent(event, state) {
  const data = event.data ?? {}
  if (event.type === 'snapshot') {
    console.log(`[spike] snapshot messages=${Array.isArray(data.messages) ? data.messages.length : 0}`)
    return {}
  }
  if (event.type === 'user') {
    console.log(`[spike] user: ${data.message?.text ?? ''}`)
    return {}
  }
  if (event.type === 'assistant-start') {
    console.log(`[spike] assistant-start turn=${data.turn} step=${data.step}`)
    return {}
  }
  if (event.type === 'tool') {
    console.log(`[spike] tool ${data.status}: ${data.name ?? '?'}`)
    return {}
  }
  if (event.type === 'assistant-delta') {
    state.answer += data.text ?? ''
    process.stdout.write('.')
    return {}
  }
  if (event.type === 'assistant') {
    const text = data.message?.text ?? ''
    if (text.trim()) state.answer = text
    console.log(`\n[spike] assistant (${state.answer.length} chars)`)
    return {}
  }
  if (event.type === 'turn-end') {
    console.log(`[spike] turn-end reason=${data.reason}${data.message ? ` message=${data.message}` : ''}`)
    return { done: true }
  }
  if (event.type === 'error') {
    console.error(`\n[spike] error ${data.code}: ${data.message}`)
    process.exitCode = 1
    return { done: true }
  }
  if (event.type === 'status') {
    console.log(`[spike] status=${data.status}`)
    return {}
  }
  return {}
}

function parseFrame(raw) {
  let type = 'message'
  const dataLines = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return undefined
  let data
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    return undefined
  }
  return { type, data }
}

function pickBook(books, wanted) {
  const value = String(wanted ?? '').trim()
  if (value) {
    const exact = books.find((book) => book.id === value)
    if (exact) return exact
    const matches = books.filter((book) => String(book.title).includes(value))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new Error(`匹配到多本教材：${matches.map((book) => book.id).join(', ')}`)
    throw new Error(`找不到教材「${value}」`)
  }
  const parsed = books.find((book) => book.parseStatus === 'done')
  if (parsed) return parsed
  return books[0]
}

async function getJson(path) {
  const response = await fetch(base + path, { headers: { accept: 'application/json' } })
  return readResponse(response, path)
}

async function postJson(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return readResponse(response, path)
}

async function readResponse(response, path) {
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = undefined
  }
  if (!response.ok || json?.ok === false) {
    const error = json?.error ?? {}
    throw new Error(`${path} HTTP ${response.status} ${error.code ?? ''} ${error.message ?? text.slice(0, 300)}`)
  }
  return json ?? {}
}

function normalizeBase(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!value) throw new Error('缺少 --base，例如 http://127.0.0.1:56517')
  return value.endsWith('/textbook-reader') ? value : `${value}/textbook-reader`
}

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const equals = item.indexOf('=')
    if (equals > 2) {
      out[item.slice(2, equals)] = item.slice(equals + 1)
      continue
    }
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      index += 1
    } else {
      out[key] = true
    }
  }
  return out
}
