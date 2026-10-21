import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarness, request } from './helpers.mjs'

class FakeChat {
  constructor() {
    this.sent = []
    this.cancelled = 0
    this.resets = 0
    this.reading = undefined
    this.activated = []
  }

  async ensure() {
    return { sessionId: 'sess-x', messages: [], created: false }
  }

  async subscribe(_book, listener) {
    listener({ type: 'snapshot', sessionId: 'sess-x', messages: [] })
    return () => {}
  }

  async send(_book, text, context) {
    this.sent.push({ text, context })
    return { accepted: true, sessionId: 'sess-x' }
  }

  async history() {
    return { sessionId: 'sess-x', messages: [{ id: 'm1', role: 'assistant', text: '历史回答 [p.2]' }] }
  }

  async status() {
    return { available: true, sessionId: 'sess-x', running: false }
  }

  async cancel() {
    this.cancelled += 1
  }

  async reset() {
    this.resets += 1
    return { sessionId: 'sess-y', conversationId: 'c1' }
  }

  async listSessions() {
    return {
      activeId: 'c1',
      sessions: [
        { id: 'c1', title: '第一问', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:01:00.000Z', messageCount: 2, active: true },
        { id: 'c0', title: '更早的问题', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:01:00.000Z', messageCount: 4, active: false },
      ],
    }
  }

  async activate(_book, id) {
    this.activated.push(id)
    return { sessionId: 'sess-z', activeId: id, messages: [{ id: 'm-old', role: 'assistant', text: '旧回答' }] }
  }

  async readReadingState() {
    return this.reading
  }

  async writeReadingState(bookId, input) {
    this.reading = { version: 1, bookId, updatedAt: 'now', ...input }
    return this.reading
  }

  async dispose() {}
}

async function setup(t) {
  const h = await createHarness({})
  t.after(() => h.close())
  const pdf = await h.writePdf('chat-routes.pdf', 3)
  const added = await h.books.addFromFile(pdf, { title: '聊天路由教材' })
  const chat = new FakeChat()
  h.router.attachChat(chat)
  return { h, book: added.book, chat }
}

test('C0 routes: session, messages, history, status, reading state, cancel, reset', async (t) => {
  const { h, book, chat } = await setup(t)

  let res = await request(h.base, `/api/books/${book.id}/chat/session`, { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal(res.json.sessionId, 'sess-x')

  res = await request(h.base, `/api/books/${book.id}/chat/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: '这页讲什么',
      context: {
        page: 3,
        nodeTitle: '1.1',
        selection: { text: '选中的原文', page: 3, pageFrom: 2, pageTo: 3, blockIds: ['b-1', 'b-2'] },
      },
    }),
  })
  assert.equal(res.status, 202)
  assert.equal(chat.sent[0].text, '这页讲什么')
  assert.equal(chat.sent[0].context.page, 3)
  assert.equal(chat.sent[0].context.bookId, book.id)
  assert.equal(chat.sent[0].context.bookTitle, '聊天路由教材')
  assert.equal(chat.sent[0].context.selection.text, '选中的原文')
  assert.equal(chat.sent[0].context.selection.pageFrom, 2)
  assert.equal(chat.sent[0].context.selection.pageTo, 3)
  assert.deepEqual(chat.sent[0].context.selection.blockIds, ['b-1', 'b-2'])

  res = await request(h.base, `/api/books/${book.id}/chat/history?limit=5`)
  assert.equal(res.status, 200)
  assert.equal(res.json.messages[0].text, '历史回答 [p.2]')

  res = await request(h.base, `/api/books/${book.id}/chat/status`)
  assert.equal(res.status, 200)
  assert.equal(res.json.available, true)

  res = await request(h.base, `/api/books/${book.id}/reading-state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      page: 3,
      nodeTitle: '1.1',
      selection: { text: '选中文本', page: 3, pageFrom: 2, pageTo: 3, blockIds: ['b-1'] },
    }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.state.page, 3)
  assert.equal(res.json.state.selection.pageFrom, 2)
  assert.equal(res.json.state.selection.pageTo, 3)

  res = await request(h.base, `/api/books/${book.id}/reading-state`)
  assert.equal(res.status, 200)
  assert.equal(res.json.state.selection.text, '选中文本')
  assert.equal(res.json.state.selection.pageFrom, 2)
  assert.equal(res.json.state.selection.pageTo, 3)

  res = await request(h.base, `/api/books/${book.id}/chat/cancel`, { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal(chat.cancelled, 1)

  res = await request(h.base, `/api/books/${book.id}/chat/sessions`)
  assert.equal(res.status, 200)
  assert.equal(res.json.activeId, 'c1')
  assert.equal(res.json.sessions[1].id, 'c0')

  res = await request(h.base, `/api/books/${book.id}/chat/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'c0' }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.activeId, 'c0')
  assert.equal(res.json.messages[0].text, '旧回答')
  assert.deepEqual(chat.activated, ['c0'])

  res = await request(h.base, `/api/books/${book.id}/chat/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)

  res = await request(h.base, `/api/books/${book.id}/chat/reset`, { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal(res.json.sessionId, 'sess-y')
  assert.equal(chat.resets, 1)
})

test('C0 routes: SSE events start with a snapshot', async (t) => {
  const { h, book } = await setup(t)
  const controller = new AbortController()
  const response = await fetch(h.base + `/api/books/${book.id}/chat/events`, {
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = response.body.getReader()
  const { value } = await reader.read()
  const frame = new TextDecoder().decode(value)
  assert.match(frame, /event: snapshot/)
  assert.match(frame, /"sessionId":"sess-x"/)
  controller.abort()
  await reader.cancel().catch(() => {})
})
