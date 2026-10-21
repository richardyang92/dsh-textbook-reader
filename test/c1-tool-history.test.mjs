import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dataPaths } from '../dist/config.js'
import { BookChatService, applyToolCall } from '../dist/chat/index.js'

function makeBook(overrides = {}) {
  return {
    id: 'b-toolhistory',
    title: '测试教材',
    pdf: 'source.pdf',
    pages: 100,
    bytes: 1024,
    sha256: 'abc',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    parse: { status: 'done', warnings: [] },
    ...overrides,
  }
}

class ToolConnection {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.listeners = new Set()
    this.messages = []
    this.running = false
    this.disposed = false
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event) {
    for (const listener of [...this.listeners]) listener(event)
  }

  async send() {
    this.running = true
    this.emit({ type: 'start', turn: 1, step: 1 })
    this.emit({
      type: 'tool',
      status: 'start',
      name: 'textbook_search',
      callId: 'call-1',
      summary: '“interaction”',
    })
    this.emit({
      type: 'tool',
      status: 'end',
      name: 'textbook_search',
      callId: 'call-1',
      summary: '“interaction” · 命中 2 段 · p.26–28',
    })
    this.emit({
      type: 'tool',
      status: 'start',
      name: 'textbook_list',
      callId: 'call-2',
    })
    this.emit({
      type: 'tool',
      status: 'end',
      name: 'textbook_list',
      callId: 'call-2',
      summary: '2 本教材 · 当前《测试教材》',
    })
    this.emit({ type: 'delta', text: '这是回答 [p.2]。' })
    this.emit({ type: 'finish', reason: 'completed' })
    this.emit({ type: 'end' })
    this.running = false
  }

  cancel() {}

  history() {
    return this.messages
  }

  async dispose() {
    this.disposed = true
    this.listeners.clear()
  }

  isRunning() {
    return this.running
  }
}

class ToolBackend {
  constructor() {
    this.opens = []
    this.connections = []
  }

  describe() {
    return { available: true, model: { provider: 'fake', model: 'fake-chat' } }
  }

  async open({ sessionId }) {
    const id = sessionId ?? `sess-${this.connections.length + 1}`
    this.opens.push(id)
    const connection = new ToolConnection(id)
    this.connections.push(connection)
    return { connection, sessionId: id, created: !sessionId }
  }
}

async function makeHarness(t) {
  const root = await mkdtemp(join(tmpdir(), 'tbr-tool-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = dataPaths(root)
  const backend = new ToolBackend()
  const service = new BookChatService({ paths, backend })
  t.after(() => service.dispose())
  return { root, paths, backend, service, book: makeBook() }
}

test('tool calls merge by call id and settle calls that omit one', () => {
  let calls = []
  calls = applyToolCall(calls, {
    status: 'start',
    name: 'textbook_search',
    callId: 'c1',
    summary: '“interaction”',
  })
  calls = applyToolCall(calls, {
    status: 'end',
    name: 'textbook_search',
    callId: 'c1',
    summary: '“interaction” · 命中 2 段 · p.26–28',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'c1')
  assert.equal(calls[0].status, 'end')
  assert.equal(calls[0].summary, '“interaction” · 命中 2 段 · p.26–28')

  calls = applyToolCall(calls, { status: 'start', name: 'read' })
  const started = calls[1]
  calls = applyToolCall(calls, { status: 'end', name: 'read', error: true })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].id, started.id)
  assert.equal(calls[1].status, 'end')
  assert.equal(calls[1].error, true)
})

test('assistant tool calls are persisted with the transcript and replayed', async (t) => {
  const { paths, service, book } = await makeHarness(t)
  const events = []
  await service.subscribe(book, (event) => events.push(event))

  await service.send(book, '这节讲什么', { bookId: book.id, bookTitle: book.title })
  const assistant = events.find((event) => event.type === 'assistant')
  assert.ok(assistant, 'the turn should emit an assistant message')
  assert.deepEqual(
    assistant.message.toolCalls.map((call) => [call.name, call.status]),
    [
      ['textbook_search', 'end'],
      ['textbook_list', 'end'],
    ],
  )
  assert.match(assistant.message.toolCalls[0].summary, /p\.26–28/)

  await service.flush(book)
  const transcript = JSON.parse(
    await readFile(join(paths.books, book.id, 'ai', 'transcript.json'), 'utf8'),
  )
  const stored = transcript.messages.at(-1)
  assert.equal(stored.role, 'assistant')
  assert.equal(stored.toolCalls.length, 2)

  // Reloading the book opens the stored session; the snapshot must carry the
  // calls, otherwise the collapsed summary disappears from the old answer.
  await service.dispose()
  const resumed = new BookChatService({ paths, backend: new ToolBackend() })
  t.after(() => resumed.dispose())
  const snapshot = await resumed.ensure(book)
  const replayed = snapshot.messages.at(-1)
  assert.equal(replayed.role, 'assistant')
  assert.deepEqual(
    replayed.toolCalls.map((call) => [call.name, call.status]),
    [
      ['textbook_search', 'end'],
      ['textbook_list', 'end'],
    ],
  )
})

test('archived conversations keep their tool calls when switched back to', async (t) => {
  const { service, book } = await makeHarness(t)
  await service.send(book, '第一问', { bookId: book.id, bookTitle: book.title })
  await service.flush(book)
  const first = await service.listSessions(book)
  const firstId = first.activeId

  await service.reset(book)
  const switched = await service.activate(book, firstId)
  const assistant = switched.messages.at(-1)
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(
    assistant.toolCalls?.map((call) => call.name),
    ['textbook_search', 'textbook_list'],
  )
})

test('legacy transcripts gain tool calls from the durable session log', async (t) => {
  const { paths, backend, service, book } = await makeHarness(t)
  const ai = join(paths.books, book.id, 'ai')
  await mkdir(ai, { recursive: true })
  await writeFile(
    join(ai, 'chat.json'),
    JSON.stringify({
      version: 1,
      sessionId: 'sess-old',
      title: '旧问题',
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:05:00.000Z',
    }),
  )
  await writeFile(
    join(ai, 'transcript.json'),
    JSON.stringify({
      version: 1,
      bookId: book.id,
      updatedAt: '2026-10-20T00:05:00.000Z',
      messages: [
        { id: 'u-old', role: 'user', text: '旧问题' },
        { id: 'a-old', role: 'assistant', text: '旧回答 [p.2]' },
      ],
    }),
  )
  backend.history = async (sessionId) =>
    sessionId === 'sess-old'
      ? [
          { id: 'h-u', role: 'user', text: '旧问题' },
          {
            id: 'h-a',
            role: 'assistant',
            text: '旧回答 [p.2]',
            toolCalls: [
              {
                id: 'call-old',
                name: 'textbook_search',
                status: 'end',
                summary: '“interaction” · 命中 2 段 · p.26–28',
              },
            ],
          },
        ]
      : []

  const snapshot = await service.ensure(book)
  assert.deepEqual(
    snapshot.messages.map((message) => message.text),
    ['旧问题', '旧回答 [p.2]'],
  )
  assert.equal(snapshot.messages[1].toolCalls.length, 1)
  assert.equal(snapshot.messages[1].toolCalls[0].name, 'textbook_search')

  const transcript = JSON.parse(await readFile(join(ai, 'transcript.json'), 'utf8'))
  assert.equal(transcript.messages[1].toolCalls[0].status, 'end')
})
