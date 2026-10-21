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
  // The chat reopen control is a toolbar icon so it cannot overlap the refresh
  // button or float over the viewport corner.
  assert.match(html.text, /id="chat-toggle"/)
  assert.match(html.text, /展开 AI 伴读/)
  // PDF text selection is built from MinerU blocks, not the embedded PDF layer.
  assert.match(html.text, /id="selection-toolbar"/)
  assert.match(html.text, /问 AI/)

  const app = await request(h.base, '/assets/app.js')
  assert.equal(app.status, 200)
  assert.match(app.headers.get('content-type'), /javascript/)
  assert.match(app.text, /pdf\.min\.mjs/)
  assert.match(app.text, /tbr:chat-open/)
  assert.match(app.text, /tbr:chat-state/)
  assert.match(app.text, /tbr:ask/)
  assert.match(app.text, /tbr:clear-selection/)
  assert.match(app.text, /pdf-block-text/)
  assert.match(app.text, /dataset\.blockId/)
  assert.match(app.text, /getSelection/)
  assert.match(app.text, /range\.intersectsNode/)
  // pdf.js >= 6 removed PDFDocumentProxy.destroy(): the viewer must tear down
  // through the loading task, otherwise every reload throws "doc.destroy is not
  // a function" and the reader shows a blank page.
  assert.match(app.text, /destroyTask/)
  assert.doesNotMatch(app.text, /doc\.destroy\(/)
  // JPX/JBIG2 scans need the pdf.js wasm decoders; without wasmUrl the reader
  // silently renders blank white pages for JPEG2000 textbooks.
  assert.match(app.text, /wasmUrl/)
  assert.match(app.text, /vendor\/wasm\//)

  const css = await request(h.base, '/assets/app.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /text\/css/)
  assert.match(css.text, /\.pdf-page/)
  assert.match(css.text, /\.pdf-block-text/)
  assert.match(css.text, /\.selection-toolbar/)

  const pdfjs = await request(h.base, '/vendor/pdf.min.mjs')
  assert.equal(pdfjs.status, 200)
  assert.match(pdfjs.headers.get('content-type'), /javascript/)

  const worker = await request(h.base, '/vendor/pdf.worker.min.mjs')
  assert.equal(worker.status, 200)
  assert.ok(Number(worker.headers.get('content-length')) > 100_000)

  const wasm = await request(h.base, '/vendor/wasm/openjpeg.wasm')
  assert.equal(wasm.status, 200)
  assert.match(wasm.headers.get('content-type'), /application\/wasm/)
  assert.ok(Number(wasm.headers.get('content-length')) > 100_000)

  const missing = await request(h.base, '/vendor/does-not-exist.mjs')
  assert.equal(missing.status, 404)
})
