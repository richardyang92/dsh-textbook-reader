#!/usr/bin/env node
/**
 * Dev-only demo seeder: creates one synthetic parsed textbook so the reader
 * tree/progress UI can be reviewed without a MinerU token. It uses a fake
 * MinerU client and a generated zip; no network request is made.
 *
 *   node scripts/seed-m2-demo.mjs --data test/.tmp/m2-dev --fresh
 *
 * Not part of the shipped host behavior. It imports test fixtures and yazl,
 * which are dev dependencies.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { ConfigStore, dataPaths } from '../dist/config.js'
import { BookStore } from '../dist/store/books.js'
import { TreeStore } from '../dist/store/tree.js'
import { ParseManager } from '../dist/mineru/job.js'
import { buildMineruZip } from '../test/fixtures.mjs'

const args = parseArgs(process.argv.slice(2))
const root = resolve(args.data ?? 'test/.tmp/m2-dev')
const pages = Number(args.pages ?? 30)
const chapters = Number(args.chapters ?? 3)
const sections = Number(args.sections ?? 3)
const fresh = args.fresh === true || args.fresh === 'true'

if (![pages, chapters, sections].every((value) => Number.isInteger(value) && value > 0)) {
  console.error('[seed] invalid numeric arguments')
  process.exit(1)
}
if (fresh) await rm(root, { recursive: true, force: true })

const paths = dataPaths(root)
const config = new ConfigStore(paths)
const books = new BookStore(paths)
const tree = new TreeStore(paths)
await config.ensure()

const existing = await books.listBooks()
if (existing.length > 0) {
  console.log(`[seed] data root already has ${existing.length} book(s); pass --fresh to replace`)
  console.log(`[seed] book: ${existing[0].id}`)
  process.exit(0)
}

const inbox = await mkdtemp(join(tmpdir(), 'tbr-seed-'))
try {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let page = 1; page <= pages; page += 1) {
    const pdfPage = doc.addPage([595, 841])
    pdfPage.drawText(`Demo Textbook — page ${page}`, { x: 48, y: 760, size: 18, font })
    pdfPage.drawText(`Sample body text for page ${page}.`, { x: 48, y: 720, size: 12, font })
  }
  const pdfPath = join(inbox, 'demo.pdf')
  await writeFile(pdfPath, await doc.save())
  const title = `示例教材（${pages} 页）`
  const added = await books.addFromFile(pdfPath, { title })
  await books.setActive(added.book.id)
  await config.writeToken('demo-token-1234567890')

  const zip = await buildMineruZip({ pages, chapters, sectionsPerChapter: sections, bookTitle: title })
  let polls = 0
  const fake = {
    async requestUpload() {
      return { batchId: 'demo-batch', fileUrls: ['https://upload.example/demo'] }
    },
    async uploadFile() {},
    async getBatch() {
      polls += 1
      return polls < 2
        ? { batchId: 'demo-batch', files: [{ state: 'running', extractedPages: Math.ceil(pages / 2), totalPages: pages }] }
        : { batchId: 'demo-batch', files: [{ state: 'done', fullZipUrl: 'https://cdn.example/demo.zip' }] }
    },
    async downloadZip(_url, target) {
      await writeFile(target, zip)
    },
  }
  const parser = new ParseManager({ paths, books, config, tree, client: fake, pollIntervalMs: 0, sleep: () => Promise.resolve() })
  const result = await parser.start(added.book.id)
  await result.completion
  const saved = await tree.read(added.book.id)
  console.log(JSON.stringify({
    bookId: added.book.id,
    status: (await books.getBook(added.book.id)).parse.status,
    chapters: saved.nodes.filter((node) => node.level === 1).length,
    sections: saved.nodes.filter((node) => node.level === 2).length,
  }))
} finally {
  await rm(inbox, { recursive: true, force: true })
}

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}
