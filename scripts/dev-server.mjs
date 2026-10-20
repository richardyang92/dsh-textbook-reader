/**
 * Development fixture server for the reader shell.
 *
 * This is NOT a replacement for DSH: it starts only the plugin's own
 * /textbook-reader router against a throwaway data root, seeds one generated
 * PDF, and prints a loopback URL. Use it to verify the reader UI and the M1
 * storage contract without installing anything into a DSH profile.
 *
 *   node scripts/dev-server.mjs --data test/.tmp/m1-dev --port 51999 --fresh
 */

import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { ConfigStore, dataPaths } from '../dist/config.js'
import { BookStore } from '../dist/store/books.js'
import { ProgressStore } from '../dist/store/progress.js'
import { TreeStore } from '../dist/store/tree.js'
import { ParseManager } from '../dist/mineru/job.js'
import { ReaderRouter } from '../dist/http/router.js'

const args = parseArgs(process.argv.slice(2))
const dataRoot = resolve(args.data ?? 'test/.tmp/m1-dev')
const port = Number(args.port ?? 51999)
const fresh = args.fresh === true || args.fresh === 'true'

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('[dev-server] invalid --port')
  process.exit(1)
}

if (fresh) await rm(dataRoot, { recursive: true, force: true })

const paths = dataPaths(dataRoot)
const config = new ConfigStore(paths)
const books = new BookStore(paths, { warn: (message) => console.warn(message) })
const progress = new ProgressStore(paths)
const tree = new TreeStore(paths)
const parser = new ParseManager({ paths, books, config, tree })
await config.ensure()

if ((await books.listBooks()).length === 0) {
  const inbox = await mkdtemp(join(tmpdir(), 'tbr-seed-'))
  try {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let page = 1; page <= 5; page += 1) {
      const pdfPage = doc.addPage([420, 595])
      pdfPage.drawText(`Sample Textbook — page ${page}`, { x: 48, y: 520, size: 16, font })
      pdfPage.drawText('This is a generated fixture, not a real textbook.', { x: 48, y: 480, size: 11, font })
    }
    const file = join(inbox, 'sample-textbook.pdf')
    await writeFile(file, await doc.save())
    const added = await books.addFromFile(file, { title: '示例教材（5 页）' })
    await books.setActive(added.book.id)
    console.log(`[dev-server] seeded book ${added.book.id} (${added.book.pages} pages)`)
  } finally {
    await rm(inbox, { recursive: true, force: true })
  }
}

const router = new ReaderRouter({
  paths,
  config,
  books,
  progress,
  tree,
  parser,
  readerRoot: join(dirname(fileURLToPath(import.meta.url)), '..', 'reader'),
})
const server = http.createServer((req, res) => {
  router.handle(req, res).catch((error) => {
    console.error('[dev-server] unhandled:', error)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
    }
    res.end(JSON.stringify({ ok: false, error: { code: 'internal_error', message: 'dev server error' } }))
  })
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  const actual = typeof address === 'object' && address ? address.port : port
  console.log(`[dev-server] data root: ${dataRoot}`)
  console.log(`[dev-server] reader: http://127.0.0.1:${actual}/textbook-reader/`)
  console.log('[dev-server] Ctrl+C to stop')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2_000).unref()
  })
}

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      index += 1
    }
  }
  return out
}
