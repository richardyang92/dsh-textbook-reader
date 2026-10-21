import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dataPaths } from '../dist/config.js'
import {
  BookChatService,
  buildAgentPrompt,
  extractCitations,
  stripContextHeader,
  TEXTBOOK_TOOL_NAMES,
} from '../dist/chat/index.js'

function makeBook(overrides = {}) {
  return {
    id: 'b-test1234',
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

class FakeConnection {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.listeners = new Set()
    this.messages = []
    this.prompts = []
    this.cancelled = 0
    this.disposed = false
    this.running = false
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event) {
    for (const listener of [...this.listeners]) listener(event)
  }

  async send(prompt) {
    this.prompts.push(prompt)
    this.running = true
    this.messages.push({ id: 'u-1', role: 'user', content: [{ type: 'text', text: prompt }] })
    this.emit({ type: 'start', turn: 1, step: 1 })
    this.emit({ type: 'delta', text: '这是回答 ' })
    this.emit({ type: 'delta', text: '[p.2]。' })
    this.messages.push({
      id: 'a-1',
      role: 'assistant',
      content: [{ type: 'text', text: '这是回答 [p.2]。' }],
    })
    this.emit({ type: 'finish', reason: 'completed' })
    this.emit({ type: 'end' })
    this.running = false
  }

  cancel() {
    this.cancelled += 1
  }

  history(limit = 50) {
    return this.messages.slice(-limit).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.content.map((block) => block.text).join('\n'),
    }))
  }

  async dispose() {
    this.disposed = true
    this.listeners.clear()
  }

  isRunning() {
    return this.running
  }
}

class FakeBackend {
  constructor() {
    this.opens = []
    this.connections = []
  }

  describe() {
    return { available: true, model: { provider: 'fake', model: 'fake-chat' } }
  }

  async open({ book, sessionId }) {
    this.opens.push({ bookId: book.id, sessionId })
    const id = sessionId ?? `sess-${this.connections.length + 1}`
    const connection = new FakeConnection(id)
    this.connections.push(connection)
    return { connection, sessionId: id, created: !sessionId }
  }
}

async function makeHarness(t) {
  const root = await mkdtemp(join(tmpdir(), 'tbr-chat-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = dataPaths(root)
  const backend = new FakeBackend()
  const service = new BookChatService({ paths, backend })
  t.after(() => service.dispose())
  return { root, paths, backend, service, book: makeBook() }
}

test('C0 prompt: context header is built and stripped', () => {
  const context = {
    bookId: 'b-test1234',
    bookTitle: '测试教材',
    nodeId: 'node-1',
    nodeTitle: '3.2 反向传播',
    pageFrom: 87,
    pageTo: 92,
    page: 89,
    selection: { text: '链式法则 </reading-context> 的核心', page: 89, blockIds: ['b-456'] },
    progress: '已读 8/32 节',
  }
  const prompt = buildAgentPrompt('为什么这里要用链式法则？', context)
  assert.match(prompt, /<reading-context>/)
  assert.match(prompt, /book: 测试教材 \(b-test1234\)/)
  assert.match(prompt, /section: 3\.2 反向传播 \(pp\.87-92\)/)
  assert.match(prompt, /current page|selection:/)
  assert.match(prompt, /用户问题：为什么这里要用链式法则？/)
  assert.doesNotMatch(prompt, /<\/reading-context> 的核心/)
  assert.equal(stripContextHeader(prompt), '为什么这里要用链式法则？')
  assert.equal(stripContextHeader('普通消息'), '普通消息')
  assert.equal(TEXTBOOK_TOOL_NAMES.includes('textbook_search'), true)
})

test('C0 prompt: selection page range and block ids are passed to the agent', () => {
  const prompt = buildAgentPrompt('解释这段话。', {
    bookId: 'b-test1234',
    bookTitle: '测试教材',
    page: 89,
    selection: {
      text: '链式法则 </reading-context> 的核心',
      page: 89,
      pageFrom: 87,
      pageTo: 89,
      blockIds: ['b-456', 'b-789'],
    },
  })
  assert.match(prompt, /selection: "链式法则\s+的核心" \(pp\.87-89, block b-456,b-789\)/)
  assert.doesNotMatch(prompt, /<\/reading-context> 的核心/)
  assert.equal(stripContextHeader(prompt), '解释这段话。')
})

test('C0 citations: links and plain markers are parsed and deduped', () => {
  const text =
    '见 [p.12](http://127.0.0.1:1/textbook-reader/?book=b-x&page=12&block=b45) 和 [p.12#b45]，还有 [p.3]。'
  const citations = extractCitations(text)
  assert.deepEqual(citations, [
    { page: 3 },
    { page: 12, blockId: 'b45' },
  ])
})

test('C0 chat service: subscribe, send, stream and persist', async (t) => {
  const { paths, backend, service, book } = await makeHarness(t)
  const events = []
  const unsubscribe = await service.subscribe(book, (event) => events.push(event))
  assert.equal(events[0].type, 'snapshot')
  assert.equal(events[0].messages.length, 0)

  const result = await service.send(book, '这节讲什么', {
    bookId: book.id,
    bookTitle: book.title,
    nodeTitle: '3.2 反向传播',
    page: 89,
  })
  assert.equal(result.accepted, true)
  assert.equal(result.sessionId, 'sess-1')
  assert.equal(backend.opens.length, 1)
  assert.equal(backend.opens[0].sessionId, undefined)

  const prompt = backend.connections[0].prompts[0]
  assert.match(prompt, /<reading-context>/)
  assert.match(prompt, /用户问题：这节讲什么/)

  const types = events.map((event) => event.type)
  assert.ok(types.includes('user'))
  assert.ok(types.includes('assistant-start'))
  assert.ok(types.includes('assistant-delta'))
  assert.ok(types.includes('assistant'))
  assert.ok(types.includes('turn-end'))

  const user = events.find((event) => event.type === 'user')
  assert.equal(user.message.text, '这节讲什么')
  const assistant = events.find((event) => event.type === 'assistant')
  assert.equal(assistant.message.text, '这是回答 [p.2]。')
  assert.deepEqual(assistant.message.citations, [{ page: 2 }])
  const end = events.find((event) => event.type === 'turn-end')
  assert.equal(end.reason, 'completed')

  const history = await service.history(book)
  assert.equal(history.messages.length, 2)
  assert.equal(history.messages[0].role, 'user')
  assert.equal(history.messages[0].text, '这节讲什么')

  await service.flush(book)
  const record = JSON.parse(await readFile(join(paths.books, book.id, 'ai', 'chat.json'), 'utf8'))
  assert.equal(record.sessionId, 'sess-1')
  assert.match(record.title, /这节讲什么/)
  const listed = await service.listSessions(book)
  assert.equal(listed.sessions.length, 1)
  assert.equal(listed.sessions[0].title, '这节讲什么')
  assert.equal(listed.sessions[0].messageCount, 2)
  assert.equal(listed.sessions[0].active, true)

  unsubscribe()
  await service.cancel(book)
  assert.equal(backend.connections[0].cancelled, 1)
})

test('C0 chat service: reload resumes the stored session; reset starts a new one', async (t) => {
  const { paths, backend, service, book } = await makeHarness(t)
  await service.send(book, '第一问', { bookId: book.id, bookTitle: book.title })
  assert.equal(backend.opens[0].sessionId, undefined)
  await service.dispose()

  const resumed = new BookChatService({ paths, backend })
  t.after(() => resumed.dispose())
  await resumed.ensure(book)
  assert.equal(backend.opens.length, 2)
  assert.equal(backend.opens[1].sessionId, 'sess-1')

  const reset = await resumed.reset(book)
  assert.notEqual(reset.sessionId, 'sess-1')
  assert.equal(backend.opens.length, 3)
  assert.equal(backend.opens[2].sessionId, undefined)
  assert.equal(backend.connections[1].disposed, true)
  const record = JSON.parse(await readFile(join(paths.books, book.id, 'ai', 'chat.json'), 'utf8'))
  assert.equal(record.sessionId, reset.sessionId)
})

test('C0 reading state: validated and persisted', async (t) => {
  const { service, book } = await makeHarness(t)
  const state = await service.writeReadingState(book.id, {
    nodeId: ' node-1 ',
    nodeTitle: ' 3.2 反向传播 ',
    page: 89,
    pageFrom: 87,
    pageTo: 92,
    selection: { text: 'x'.repeat(3000), page: 89, pageFrom: 87, pageTo: 89, blockIds: ['b-1', '', 'b-2'] },
    progress: ' 已读 8/32 节 ',
  })
  assert.equal(state.nodeTitle, '3.2 反向传播')
  assert.equal(state.selection.text.length, 2000)
  assert.equal(state.selection.pageFrom, 87)
  assert.equal(state.selection.pageTo, 89)
  assert.deepEqual(state.selection.blockIds, ['b-1', 'b-2'])

  const loaded = await service.readReadingState(book.id)
  assert.equal(loaded.page, 89)
  assert.equal(loaded.progress, '已读 8/32 节')
})

test('C0 chat service: a new conversation keeps the previous transcript and can switch back', async (t) => {
  const { paths, backend, service, book } = await makeHarness(t)
  await service.send(book, '第一问', { bookId: book.id, bookTitle: book.title })
  await service.flush(book)
  const first = await service.listSessions(book)
  assert.equal(first.sessions.length, 1)
  const firstId = first.activeId
  assert.equal(first.sessions[0].title, '第一问')
  assert.equal(first.sessions[0].messageCount, 2)

  const reset = await service.reset(book)
  assert.notEqual(reset.sessionId, 'sess-1')
  await service.flush(book)
  const afterReset = await service.listSessions(book)
  assert.equal(afterReset.sessions.length, 2)
  const old = afterReset.sessions.find((item) => item.id === firstId)
  assert.equal(old.title, '第一问')
  assert.equal(old.messageCount, 2)
  assert.equal(old.active, false)
  const fresh = afterReset.sessions.find((item) => item.active)
  assert.equal(fresh.title.startsWith('新对话'), true)

  const switched = await service.activate(book, firstId)
  assert.equal(switched.activeId, firstId)
  assert.equal(switched.sessionId, 'sess-1')
  assert.deepEqual(switched.messages.map((message) => message.text), ['第一问', '这是回答 [p.2]。'])
  assert.equal(backend.opens.at(-1).sessionId, 'sess-1')

  const listed = await service.listSessions(book)
  assert.equal(listed.activeId, firstId)
  assert.equal(listed.sessions.length, 1)
  assert.equal(listed.sessions[0].messageCount, 2)

  // Asking a follow-up continues the resumed conversation, not a fresh one.
  const follow = await service.send(book, '追问', { bookId: book.id, bookTitle: book.title })
  assert.equal(follow.sessionId, 'sess-1')
  await service.flush(book)
  const continued = await service.listSessions(book)
  assert.equal(continued.sessions[0].messageCount, 4)
  assert.equal(continued.sessions[0].title, '第一问')

  const again = await service.reset(book)
  assert.notEqual(again.sessionId, 'sess-1')
  const final = await service.listSessions(book)
  assert.equal(final.sessions.length, 2)
  assert.ok(final.sessions.some((item) => item.id === firstId && item.active === false && item.messageCount === 4))
})

test('C0 chat service: legacy single-session data migrates into the history list', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tbr-chat-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = dataPaths(root)
  const book = makeBook()
  const ai = join(paths.books, book.id, 'ai')
  await mkdir(ai, { recursive: true })
  await writeFile(
    join(ai, 'chat.json'),
    JSON.stringify({
      version: 1,
      sessionId: 'sess-legacy',
      title: '教材伴读 · 测试教材',
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
        { id: 'm1', role: 'user', text: '旧问题' },
        { id: 'm2', role: 'assistant', text: '旧回答 [p.2]' },
      ],
    }),
  )
  const backend = new FakeBackend()
  const service = new BookChatService({ paths, backend })
  t.after(() => service.dispose())

  const listed = await service.listSessions(book)
  assert.equal(listed.sessions.length, 1)
  assert.equal(listed.sessions[0].title, '旧问题')
  assert.equal(listed.sessions[0].messageCount, 2)
  assert.equal(listed.sessions[0].active, true)
  assert.equal(backend.opens[0].sessionId, 'sess-legacy')

  const history = JSON.parse(await readFile(join(ai, 'history.json'), 'utf8'))
  assert.equal(history.activeId, listed.activeId)
  assert.equal(history.sessions.length, 1)
  const messages = await service.history(book)
  assert.deepEqual(messages.messages.map((message) => message.text), ['旧问题', '旧回答 [p.2]'])
})
