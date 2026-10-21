import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHarness, request } from './helpers.mjs'
import { buildMineruZip } from './fixtures.mjs'

class SegmentMineru {
  constructor(zips) {
    this.zips = zips
    this.index = -1
    this.requests = []
    this.uploaded = []
  }
  async requestUpload(_token, request) {
    this.requests.push(request)
    this.index += 1
    return { batchId: `batch-seg-${this.index + 1}`, fileUrls: [`https://upload.example/part-${this.index + 1}`] }
  }
  async uploadFile(_url, filePath) {
    this.uploaded.push(filePath)
  }
  async getBatch() {
    return { batchId: 'batch-seg', files: [{ state: 'done', fullZipUrl: 'https://cdn.example/result.zip' }] }
  }
  async downloadZip(_url, target) {
    const zip = this.zips[this.index]
    if (!zip) throw new Error(`no zip for segment ${this.index}`)
    await writeFile(target, zip)
  }
}

test('M5 segmentation: >max pages are split, parsed and merged back to original page numbers', async (t) => {
  const zips = [
    await buildMineruZip({ pages: 10, chapters: 1, sectionsPerChapter: 2, bookTitle: '分段教材' }),
    await buildMineruZip({ pages: 10, chapters: 1, sectionsPerChapter: 2, bookTitle: '分段教材' }),
    await buildMineruZip({ pages: 3, chapters: 1, sectionsPerChapter: 1, bookTitle: '分段教材' }),
  ]
  const fake = new SegmentMineru(zips)
  const h = await createHarness({ token: 'mineru-test-token-12345678', mineruClient: fake, maxPollMs: 10_000, maxPagesPerTask: 10 })
  t.after(() => h.close())

  // createHarness passes options.mineruClient only; allow maxPagesPerTask through a local manager.
  const { ParseManager } = await import('../dist/mineru/job.js')
  const parser = new ParseManager({
    paths: h.paths,
    books: h.books,
    config: h.config,
    tree: h.tree,
    client: fake,
    pollIntervalMs: 0,
    maxPollMs: 10_000,
    maxPagesPerTask: 10,
    sleep: () => Promise.resolve(),
  })
  const pdf = await h.writePdf('segmented.pdf', 23)
  const added = await h.books.addFromFile(pdf, { title: '分段教材' })
  await h.books.setActive(added.book.id)
  const result = await parser.start(added.book.id)
  await result.completion
  const book = await h.books.getBook(added.book.id)
  assert.equal(book.parse.status, 'done')
  assert.equal(fake.requests.length, 3)
  assert.deepEqual(fake.requests.map((request) => request.dataId), [
    `${added.book.id}-p1`,
    `${added.book.id}-p2`,
    `${added.book.id}-p3`,
  ])

  const normalized = JSON.parse(await readFile(join(h.paths.books, added.book.id, 'parse', 'normalized.json'), 'utf8'))
  assert.equal(normalized.pages.length, 23)
  assert.deepEqual(normalized.pages.map((page) => page.page), Array.from({ length: 23 }, (_, i) => i + 1))
  assert.equal(normalized.pages[10].page, 11)
  assert.equal(normalized.pages[10].blocks.every((block) => block.page === 11), true)
  assert.equal(normalized.pages[22].blocks.every((block) => block.page === 23), true)
  assert.ok(normalized.headings.some((heading) => heading.page === 11))
  assert.ok(normalized.headings.some((heading) => heading.page === 21))
  assert.match(normalized.source.contentListFile, /^segment-1\//)
  assert.equal(normalized.stats.blocks > 0, true)

  const tree = await h.tree.read(added.book.id)
  assert.equal(tree.nodes.filter((node) => node.level === 1).length, 3)
  assert.ok(book.parse.warnings.some((warning) => /分为 3 段/.test(warning)))

  await assert.rejects(() => access(join(h.paths.books, added.book.id, 'parse', 'segments')), /ENOENT/)
  const asset = await fetch(`${h.base}/api/books/${added.book.id}/asset/images/fig1.jpg`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /image\/jpeg/)
})

test('M5 segmentation: splitPdf copies exactly the requested inclusive ranges', async (t) => {
  const { splitPdf } = await import('../dist/mineru/split.js')
  const { PDFDocument } = await import('pdf-lib')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'tbr-split-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const doc = await PDFDocument.create()
  for (let i = 0; i < 23; i += 1) doc.addPage([300, 400])
  const source = join(dir, 'source.pdf')
  await writeFile(source, await doc.save())
  const parts = await splitPdf(source, [{ from: 1, to: 10 }, { from: 11, to: 20 }, { from: 21, to: 23 }], join(dir, 'parts'))
  assert.deepEqual(parts.map((part) => part.pages), [10, 10, 3])
  for (const part of parts) {
    const bytes = await readFile(part.file)
    const parsed = await PDFDocument.load(bytes)
    assert.equal(parsed.getPageCount(), part.pages)
  }
})

test('M5 segmentation: default task ceiling is MinerU\'s 200-page limit', async () => {
  const { planPageRanges, MAX_PAGES_PER_TASK } = await import('../dist/pdf.js')
  assert.equal(MAX_PAGES_PER_TASK, 200)
  assert.deepEqual(planPageRanges(864), [
    { from: 1, to: 200 },
    { from: 201, to: 400 },
    { from: 401, to: 600 },
    { from: 601, to: 800 },
    { from: 801, to: 864 },
  ])
})

test('M5 segmentation: a lower MinerU page limit triggers automatic re-splitting', async (t) => {
  const { ParseManager } = await import('../dist/mineru/job.js')
  const { PDFDocument } = await import('pdf-lib')
  const limit = 6
  const h = await createHarness({ token: 'mineru-test-token-12345678' })
  t.after(() => h.close())

  class TinyLimitMineru {
    constructor() {
      this.requests = []
      this.entries = []
      this.byUrl = new Map()
    }
    async requestUpload(_token, request) {
      this.requests.push(request)
      const batchId = `batch-tiny-${this.requests.length}`
      const url = `https://upload.example/${batchId}`
      const entry = { batchId, dataId: request.dataId, url, pages: 0, zip: null }
      this.entries.push(entry)
      this.byUrl.set(url, entry)
      return { batchId, fileUrls: [url] }
    }
    async uploadFile(url, filePath) {
      const doc = await PDFDocument.load(await readFile(filePath))
      this.byUrl.get(url).pages = doc.getPageCount()
    }
    async getBatch(_token, batchId) {
      const entry = this.entries.find((item) => item.batchId === batchId)
      const file = {
        dataId: entry.dataId,
        state: 'done',
        fullZipUrl: `https://cdn.example/${batchId}.zip`,
        totalPages: entry.pages,
        extractedPages: entry.pages,
      }
      if (entry.pages > limit) {
        return {
          batchId,
          files: [
            {
              ...file,
              state: 'failed',
              fullZipUrl: undefined,
              errMsg: `number of pages exceeds limit (${limit} pages), please split the file and try again`,
            },
          ],
        }
      }
      if (!entry.zip) {
        entry.zip = await buildMineruZip({ pages: entry.pages, chapters: 1, sectionsPerChapter: 1, bookTitle: '二分教材' })
      }
      this.byUrl.set(file.fullZipUrl, entry)
      return { batchId, files: [file] }
    }
    async downloadZip(url, target) {
      await writeFile(target, this.byUrl.get(url).zip)
    }
  }

  const fake = new TinyLimitMineru()
  const parser = new ParseManager({
    paths: h.paths,
    books: h.books,
    config: h.config,
    tree: h.tree,
    client: fake,
    pollIntervalMs: 0,
    maxPollMs: 10_000,
    maxPagesPerTask: 10,
    sleep: () => Promise.resolve(),
  })
  const pdf = await h.writePdf('tiny-limit.pdf', 23)
  const added = await h.books.addFromFile(pdf, { title: '二分教材' })
  const result = await parser.start(added.book.id)
  await result.completion

  const book = await h.books.getBook(added.book.id)
  assert.equal(book.parse.status, 'done')
  // 10 -> (5, 5); 10 -> (5, 5); 3 stays: the failed chunks are halved, not retried whole.
  assert.deepEqual(fake.entries.map((entry) => entry.pages), [10, 5, 5, 10, 5, 5, 3])
  assert.ok(book.parse.warnings.some((warning) => /自动二分/.test(warning)))

  const normalized = JSON.parse(await readFile(join(h.paths.books, added.book.id, 'parse', 'normalized.json'), 'utf8'))
  assert.equal(normalized.pages.length, 23)
  assert.deepEqual(normalized.pages.map((page) => page.page), Array.from({ length: 23 }, (_, i) => i + 1))
  const ids = normalized.pages.flatMap((page) => page.blocks.map((block) => block.id))
  assert.equal(ids.length, new Set(ids).size)
  assert.equal(normalized.pages.every((page) => page.blocks.every((block) => block.page === page.page)), true)
})
