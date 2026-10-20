import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarness, rawRequest, request } from './helpers.mjs'

test('M1 http: reader shell renders and unknown routes return JSON errors', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const page = await request(h.base, '/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(page.text, /教材伴读/)
  assert.match(page.text, /MinerU/)

  const health = await request(h.base, '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.service, 'dsh-textbook-reader')

  const missing = await request(h.base, '/api/nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'not_found')

  const method = await request(h.base, '/api/health', { method: 'POST' })
  assert.equal(method.status, 405)
  assert.equal(method.json.error.code, 'method_not_allowed')
})

test('M1 http: PDF streaming supports range requests and HEAD', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const pdfFile = await h.writePdf('range.pdf', 3)
  const added = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdfFile }),
  })
  const id = added.json.book.id
  const pdfUrl = `${h.base}/api/books/${id}/pdf`
  const full = await fetch(pdfUrl)
  assert.equal(full.status, 200)
  assert.match(full.headers.get('content-type'), /application\/pdf/)
  const fullBytes = Buffer.from(await full.arrayBuffer())
  assert.equal(fullBytes.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.equal(Number(full.headers.get('content-length')), fullBytes.byteLength)

  const ranged = await fetch(pdfUrl, { headers: { range: 'bytes=0-99' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), `bytes 0-99/${fullBytes.byteLength}`)
  assert.equal((await ranged.arrayBuffer()).byteLength, 100)

  const suffix = await fetch(pdfUrl, { headers: { range: 'bytes=-20' } })
  assert.equal(suffix.status, 206)
  assert.equal((await suffix.arrayBuffer()).byteLength, 20)

  const invalid = await fetch(pdfUrl, { headers: { range: 'bytes=999999-' } })
  assert.equal(invalid.status, 416)

  const head = await fetch(pdfUrl, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers.get('content-length')), fullBytes.byteLength)
})

test('M1 http: trust fence rejects bad Host, cross-site and mismatched Origin', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const evilHost = await rawRequest(h.port, '/textbook-reader/api/health', { host: 'evil.example' })
  assert.equal(evilHost.status, 403)

  const crossSite = await rawRequest(h.port, '/textbook-reader/api/health', {
    host: `127.0.0.1:${h.port}`,
    'sec-fetch-site': 'cross-site',
  })
  assert.equal(crossSite.status, 403)

  const badOrigin = await rawRequest(h.port, '/textbook-reader/api/health', {
    host: `127.0.0.1:${h.port}`,
    origin: 'https://evil.example',
  })
  assert.equal(badOrigin.status, 403)

  const good = await rawRequest(h.port, '/textbook-reader/api/health', {
    host: `127.0.0.1:${h.port}`,
    origin: `http://127.0.0.1:${h.port}`,
  })
  assert.equal(good.status, 200)
})

test('M1 http: static traversal is rejected', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const traversal = await request(h.base, '/assets/%2e%2e/%2e%2e/package.json')
  assert.ok([403, 404].includes(traversal.status), `unexpected ${traversal.status}`)
  assert.equal(traversal.text.includes('"name": "dsh-textbook-reader"'), false)
})
