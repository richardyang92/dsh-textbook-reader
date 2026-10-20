import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarness, request } from './helpers.mjs'

test('M1 progress: full progress persists across store instances and validates pages', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const pdf = await h.writePdf('book.pdf', 5)
  const added = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdf }),
  })
  const id = added.json.book.id

  const put = await request(h.base, `/api/books/${id}/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      currentPage: 3,
      readChapters: ['n1', 'n1', 'n2'],
      mastery: { n1: { level: 4 } },
      questions: [{ text: '第 3 页的公式怎么推的？', page: 3, nodeId: 'n2' }],
    }),
  })
  assert.equal(put.status, 200)
  assert.equal(put.json.progress.currentPage, 3)
  assert.deepEqual(put.json.progress.readChapters, ['n1', 'n2'])
  assert.equal(put.json.progress.mastery.n1.level, 4)
  assert.equal(put.json.progress.questions.length, 1)
  assert.match(put.json.progress.questions[0].id, /^q-/)

  const get = await request(h.base, `/api/books/${id}/progress`)
  assert.equal(get.json.progress.currentPage, 3)

  const { ProgressStore } = await import('../dist/store/progress.js')
  const restarted = new ProgressStore(h.paths)
  const reread = await restarted.read(id, 5)
  assert.equal(reread.currentPage, 3)
  assert.deepEqual(reread.readChapters, ['n1', 'n2'])
  assert.equal(reread.questions[0].text, '第 3 页的公式怎么推的？')

  const invalid = await request(h.base, `/api/books/${id}/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPage: 99 }),
  })
  assert.equal(invalid.status, 422)
  assert.equal(invalid.json.error.code, 'invalid_page')

  const missing = await request(h.base, '/api/books/b-not-a-real-book/progress')
  assert.equal(missing.status, 404)
})

test('M1 progress: patch-style updates keep prior questions and mastery', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const pdf = await h.writePdf('book.pdf', 8)
  const added = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdf }),
  })
  const id = added.json.book.id

  const first = await h.progress.patch(id, {
    currentPage: 2,
    addQuestion: { text: '为什么这里用极限？', page: 2 },
    mastery: { n1: 2 },
  }, 8)
  assert.equal(first.currentPage, 2)
  assert.equal(first.questions.length, 1)
  const questionId = first.questions[0].id

  const second = await h.progress.patch(id, {
    resolveQuestion: questionId,
    mastery: { n1: 3 },
  }, 8)
  assert.equal(second.questions[0].status, 'resolved')
  assert.equal(second.mastery.n1.level, 3)
  assert.equal(second.currentPage, 2)

  const third = await h.progress.patch(id, { deleteQuestion: questionId }, 8)
  assert.equal(third.questions.length, 0)
})
