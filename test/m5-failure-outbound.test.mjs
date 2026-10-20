import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { createHarness, request } from './helpers.mjs'
import { buildMineruZip } from './fixtures.mjs'
import { MineruClient } from '../dist/mineru/client.js'

test('M5 failure: unreachable/timeout/API errors become actionable codes without token leakage', async () => {
  const token = 'mineru-secret-token-1234567890'
  const unreachable = new MineruClient({
    fetchImpl: async () => { throw new Error('socket hang up') },
  })
  await assert.rejects(
    () => unreachable.requestUpload(token, { fileName: 'x.pdf', dataId: 'x', isOcr: false, enableTable: true, language: 'ch' }),
    (error) => error.code === 'mineru_unreachable' && !String(error.message).includes(token),
  )

  const timeout = new MineruClient({
    fetchImpl: async () => { throw new Error('The operation was aborted due to timeout') },
  })
  await assert.rejects(
    () => timeout.requestUpload(token, { fileName: 'x.pdf', dataId: 'x', isOcr: false, enableTable: true, language: 'ch' }),
    (error) => error.code === 'mineru_timeout',
  )

  const pageLimit = new MineruClient({
    fetchImpl: async () => new Response(JSON.stringify({ code: -60006, msg: 'page count exceeds limit' }), { status: 200 }),
  })
  await assert.rejects(
    () => pageLimit.requestUpload(token, { fileName: 'x.pdf', dataId: 'x', isOcr: false, enableTable: true, language: 'ch' }),
    (error) => error.code === 'mineru_page_limit' && error.status === 422,
  )

  const unsafe = new MineruClient({ fetchImpl: async () => new Response('', { status: 500 }) })
  await assert.rejects(
    () => unsafe.downloadZip('http://127.0.0.1/secret', '/tmp/never-written'),
    (error) => error.code === 'mineru_url_invalid',
  )
  await assert.rejects(
    () => unsafe.downloadZip('https://localhost/secret', '/tmp/never-written'),
    (error) => error.code === 'mineru_url_invalid',
  )
})

test('M5 failure: a corrupt MinerU zip is persisted as a visible parse failure', async (t) => {
  const calls = []
  const fake = {
    async requestUpload() { return { batchId: 'batch-bad', fileUrls: ['https://upload.example/x'] } },
    async uploadFile() { calls.push('upload') },
    async getBatch() { return { batchId: 'batch-bad', files: [{ state: 'done', fullZipUrl: 'https://cdn.example/bad.zip' }] } },
    async downloadZip(_url, target) { await writeFile(target, 'not a zip at all') },
  }
  const h = await createHarness({ token: 'mineru-test-token-12345678', mineruClient: fake, maxPollMs: 5000 })
  t.after(() => h.close())
  const pdf = await h.writePdf('bad-zip.pdf', 1)
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
  assert.equal(book.parse.error.code, 'zip_invalid')
  assert.ok(book.parse.error.message.length > 0)
  assert.equal(calls.includes('upload'), true)
})

test('M5 outbound: caption VLM off -> no caption/embedding/image requests during a parse', async (t) => {
  const zip = await buildMineruZip({ pages: 5, chapters: 1, sectionsPerChapter: 1, bookTitle: '外发审计教材' })
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const target = String(url)
    calls.push({ url: target, method: options.method ?? 'GET' })
    if (target.includes('/file-urls/batch')) {
      return new Response(JSON.stringify({ code: 0, data: { batch_id: 'batch-outbound', file_urls: ['https://upload.example/signed'] } }), { status: 200 })
    }
    if (options.method === 'PUT') return new Response('', { status: 200 })
    if (target.includes('/extract-results/batch/')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { extract_result: [{ file_name: 'x.pdf', state: 'done', full_zip_url: 'https://cdn.example/result.zip' }] },
      }), { status: 200 })
    }
    if (target === 'https://cdn.example/result.zip') {
      return new Response(zip, { status: 200, headers: { 'content-length': String(zip.byteLength) } })
    }
    return new Response('unexpected', { status: 500 })
  }
  const client = new MineruClient({ fetchImpl })
  const h = await createHarness({ token: 'mineru-test-token-12345678', mineruClient: client, maxPollMs: 5000 })
  t.after(() => h.close())
  const settings = await h.config.readSettings()
  assert.equal(settings.captionVlm.enabled, false)

  const pdf = await h.writePdf('outbound.pdf', 5)
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
  assert.equal(book.parse.status, 'done')

  const captionRequests = calls.filter((call) => /(chat\/completions|embeddings|images\/generations|caption|vlm)/i.test(call.url))
  assert.deepEqual(captionRequests, [])
  const hosts = new Set(calls.map((call) => new URL(call.url).hostname))
  assert.deepEqual([...hosts].sort(), ['cdn.example', 'mineru.net', 'upload.example'])
  assert.ok(calls.some((call) => call.method === 'PUT'))
  assert.ok(calls.some((call) => call.method === 'GET' && call.url.includes('/extract-results/batch/')))
})
