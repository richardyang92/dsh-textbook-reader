import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { createHarness, makePdf, request } from './helpers.mjs'

test('M1 books: import from path, duplicate detection, active book and restart persistence', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const pdf = await h.writePdf('textbook.pdf', 4)
  const added = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdf, title: '微积分 上册' }),
  })
  assert.equal(added.status, 201)
  assert.equal(added.json.book.title, '微积分 上册')
  assert.equal(added.json.book.pages, 4)
  assert.equal(added.json.duplicate, false)
  const id = added.json.book.id
  assert.match(id, /^b-[a-f0-9]{12}$/)

  const list = await request(h.base, '/api/books')
  assert.equal(list.status, 200)
  assert.equal(list.json.books.length, 1)
  assert.equal(list.json.books[0].active, true)
  assert.equal(list.json.activeBookId, id)
  assert.equal(list.json.books[0].parseStatus, 'none')

  const detail = await request(h.base, `/api/books/${id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.book.id, id)
  assert.equal(detail.json.progress.currentPage, 1)

  const duplicate = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdf, title: '另一本同名书' }),
  })
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.json.duplicate, true)
  assert.equal(duplicate.json.book.id, id)
  assert.equal(duplicate.json.book.title, '微积分 上册')

  const restarted = await import('../dist/store/books.js')
  const { ConfigStore, dataPaths } = await import('../dist/config.js')
  const paths = dataPaths(h.paths.root)
  const restartedBooks = new restarted.BookStore(paths)
  const reread = await restartedBooks.listBooks()
  assert.equal(reread.length, 1)
  assert.equal(reread[0].id, id)
  assert.equal(await restartedBooks.activeBookId(), id)
  assert.ok(await new ConfigStore(paths).readSettings())
})

test('M1 books: raw PDF upload, title headers, and confirmed delete', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const pdf = await makePdf(2)
  const upload = await request(h.base, '/api/books', {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf',
      'x-file-name': encodeURIComponent('线性代数.pdf'),
      'x-book-title': encodeURIComponent('线性代数'),
    },
    body: pdf,
  })
  assert.equal(upload.status, 201)
  assert.equal(upload.json.book.title, '线性代数')
  assert.equal(upload.json.book.originalName, '线性代数.pdf')
  assert.equal(upload.json.book.pages, 2)
  const id = upload.json.book.id

  const refused = await request(h.base, `/api/books/${id}`, { method: 'DELETE' })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'confirmation_required')

  const deleted = await request(h.base, `/api/books/${id}?confirm=1`, { method: 'DELETE' })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.json.trashed, true)
  const list = await request(h.base, '/api/books')
  assert.equal(list.json.books.length, 0)
  assert.equal(list.json.activeBookId, null)
})

test('M1 books: upload size limit and invalid ids fail explicitly', async (t) => {
  const h = await createHarness({ maxUploadBytes: 128 })
  t.after(() => h.close())

  const tooBig = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-file-name': 'big.pdf' },
    body: Buffer.alloc(1024, 1),
  })
  assert.equal(tooBig.status, 413)
  assert.equal(tooBig.json.error.code, 'payload_too_large')

  const traversal = await request(h.base, '/api/books/..%2F..%2Fpackage.json')
  assert.equal(traversal.status, 400)
  assert.equal(traversal.json.error.code, 'invalid_book_id')

  const missing = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: join(h.root, 'does-not-exist.pdf') }),
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'not_found')
})
