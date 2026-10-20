import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHarness, request } from './helpers.mjs'
import { buildMineruZip } from './fixtures.mjs'

class FakeMineru {
  constructor(zip, options = {}) {
    this.zip = zip
    this.polls = 0
    this.uploads = 0
    this.requests = []
    this.failState = options.failState ?? false
  }

  async requestUpload(token, request) {
    this.requests.push(request)
    assert.equal(token.length > 0, true)
    return { batchId: 'batch-fake-1', fileUrls: ['https://upload.example/signed'] }
  }

  async uploadFile(_url, filePath) {
    this.uploads += 1
    this.uploadedFile = filePath
  }

  async getBatch() {
    this.polls += 1
    if (this.failState) {
      return { batchId: 'batch-fake-1', files: [{ state: 'failed', errMsg: 'synthetic parse failure' }] }
    }
    if (this.polls < 2) {
      return {
        batchId: 'batch-fake-1',
        files: [{ state: 'running', extractedPages: 10, totalPages: 30 }],
      }
    }
    return {
      batchId: 'batch-fake-1',
      files: [{ state: 'done', fullZipUrl: 'https://cdn.example/result.zip' }],
    }
  }

  async downloadZip(_url, target) {
    this.downloadedTo = target
    await writeFile(target, this.zip)
  }
}

test('M2 parse: fake MinerU job produces normalized pages, tree, assets and status', async (t) => {
  const zip = await buildMineruZip({ pages: 30, chapters: 3, sectionsPerChapter: 2, bookTitle: '测试教材' })
  const fake = new FakeMineru(zip)
  const h = await createHarness({ token: 'mineru-test-token-12345678', mineruClient: fake, maxPollMs: 10_000 })
  t.after(() => h.close())

  const pdf = await h.writePdf('textbook.pdf', 30)
  const added = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdf, title: '测试教材' }),
  })
  const id = added.json.book.id

  const started = await request(h.base, `/api/books/${id}/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(started.status, 202)
  assert.equal(started.json.started, true)
  assert.equal(started.json.parse.status, 'preparing')

  await h.parser.whenIdle(id)
  assert.ok(fake.requests[0])
  assert.equal(fake.requests[0].fileName, `${id}.pdf`)
  assert.equal(fake.requests[0].isOcr, true)

  const status = await request(h.base, `/api/books/${id}/parse`)
  assert.equal(status.status, 200)
  assert.equal(status.json.parse.status, 'done')
  assert.equal(status.json.parse.progress, 100)
  assert.equal(status.json.parse.batchId, 'batch-fake-1')
  assert.ok(fake.uploads >= 1)
  assert.ok(fake.polls >= 2)

  const tree = await request(h.base, `/api/books/${id}/tree`)
  assert.equal(tree.status, 200)
  assert.equal(tree.json.parseStatus, 'done')
  assert.ok(tree.json.tree)
  const chapters = tree.json.tree.nodes.filter((node) => node.level === 1)
  assert.equal(chapters.length, 3)

  const page = await request(h.base, `/api/books/${id}/pages/3`)
  assert.equal(page.status, 200)
  assert.equal(page.json.page.page, 3)
  assert.ok(page.json.page.blocks.some((block) => block.type === 'image'))

  const assetResponse = await fetch(`${h.base}/api/books/${id}/asset/images/fig1.jpg`)
  assert.equal(assetResponse.status, 200)
  assert.match(assetResponse.headers.get('content-type'), /image\/jpeg/)
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 0)

  const normalizedPath = join(h.paths.books, id, 'parse', 'normalized.json')
  assert.ok((await stat(normalizedPath)).size > 0)
  const normalized = JSON.parse(await readFile(normalizedPath, 'utf8'))
  assert.equal(normalized.source.contentListFile, 'uuid_content_list.json')
  assert.equal(normalized.source.layoutFile, 'layout.json')
})

test('M2 parse: missing token fails fast without any upload', async (t) => {
  const zip = await buildMineruZip({ pages: 5, chapters: 1 })
  const fake = new FakeMineru(zip)
  const h = await createHarness({ mineruClient: fake })
  t.after(() => h.close())
  const pdf = await h.writePdf('no-token.pdf', 5)
  const added = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdf }),
  })
  const id = added.json.book.id
  const started = await request(h.base, `/api/books/${id}/parse`, { method: 'POST' })
  assert.equal(started.status, 409)
  assert.equal(started.json.error.code, 'token_missing')
  assert.equal(started.json.error.hint.includes('设置'), true)
  assert.equal(fake.uploads, 0)
  assert.equal(fake.polls, 0)
  const book = await h.books.getBook(id)
  assert.equal(book.parse.status, 'none')
})

test('M2 parse: MinerU failure is persisted with a visible error, not silent success', async (t) => {
  const zip = await buildMineruZip({ pages: 10, chapters: 1 })
  const fake = new FakeMineru(zip, { failState: true })
  const h = await createHarness({ token: 'mineru-test-token-12345678', mineruClient: fake, maxPollMs: 10_000 })
  t.after(() => h.close())
  const pdf = await h.writePdf('failure.pdf', 10)
  const added = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdf }),
  })
  const id = added.json.book.id
  const started = await request(h.base, `/api/books/${id}/parse`, { method: 'POST' })
  assert.equal(started.status, 202)
  await h.parser.whenIdle(id)
  const book = await h.books.getBook(id)
  assert.equal(book.parse.status, 'failed')
  assert.equal(book.parse.error.code, 'mineru_parse_failed')
  assert.match(book.parse.error.message, /synthetic parse failure/)
  const tree = await request(h.base, `/api/books/${id}/tree`)
  assert.equal(tree.json.tree, null)
})

test('M2 parse: restart recovery marks an orphaned running job interrupted', async (t) => {
  const zip = await buildMineruZip({ pages: 5, chapters: 1 })
  const h = await createHarness({ token: 'mineru-test-token-12345678', mineruClient: new FakeMineru(zip) })
  t.after(() => h.close())
  const pdf = await h.writePdf('orphan.pdf', 5)
  const added = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdf }),
  })
  const id = added.json.book.id
  await h.books.updateBook(id, (book) => ({
    ...book,
    parse: { status: 'polling', progress: 40, batchId: 'batch-orphan', warnings: [] },
  }))
  await h.parser.recover()
  const recovered = await h.books.getBook(id)
  assert.equal(recovered.parse.status, 'interrupted')
  assert.equal(recovered.parse.error.code, 'parse_interrupted')
  assert.equal(recovered.parse.batchId, 'batch-orphan')
})
