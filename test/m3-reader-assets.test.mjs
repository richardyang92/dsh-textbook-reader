import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarness, request } from './helpers.mjs'

test('M3 reader: html, app bundle, css and vendored pdf.js are served', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const html = await request(h.base, '/')
  assert.equal(html.status, 200)
  assert.match(html.text, /assets\/app\.js/)
  assert.match(html.text, /pdf-scroll/)

  const app = await request(h.base, '/assets/app.js')
  assert.equal(app.status, 200)
  assert.match(app.headers.get('content-type'), /javascript/)
  assert.match(app.text, /pdf\.min\.mjs/)

  const css = await request(h.base, '/assets/app.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /text\/css/)
  assert.match(css.text, /\.pdf-page/)

  const pdfjs = await request(h.base, '/vendor/pdf.min.mjs')
  assert.equal(pdfjs.status, 200)
  assert.match(pdfjs.headers.get('content-type'), /javascript/)

  const worker = await request(h.base, '/vendor/pdf.worker.min.mjs')
  assert.equal(worker.status, 200)
  assert.ok(Number(worker.headers.get('content-length')) > 100_000)

  const missing = await request(h.base, '/vendor/does-not-exist.mjs')
  assert.equal(missing.status, 404)
})
