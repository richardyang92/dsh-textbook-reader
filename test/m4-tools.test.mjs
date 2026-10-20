import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarness } from './helpers.mjs'
import { buildMineruZip } from './fixtures.mjs'
import { registerTextbookTools } from '../dist/tools/index.js'

class FakeMineru {
  constructor(zip) { this.zip = zip; this.polls = 0 }
  async requestUpload() { return { batchId: 'batch-tools', fileUrls: ['https://upload.example/x'] } }
  async uploadFile() {}
  async getBatch() {
    this.polls += 1
    return this.polls < 2
      ? { batchId: 'batch-tools', files: [{ state: 'running', extractedPages: 10, totalPages: 30 }] }
      : { batchId: 'batch-tools', files: [{ state: 'done', fullZipUrl: 'https://cdn.example/x.zip' }] }
  }
  async downloadZip(_url, target) { const { writeFile } = await import('node:fs/promises'); await writeFile(target, this.zip) }
}

async function setup(t) {
  const zip = await buildMineruZip({ pages: 30, chapters: 3, sectionsPerChapter: 3, bookTitle: '工具教材' })
  const h = await createHarness({ token: 'mineru-test-token-12345678', mineruClient: new FakeMineru(zip), maxPollMs: 10_000 })
  t.after(() => h.close())
  const pdf = await h.writePdf('tools.pdf', 30)
  const added = await h.books.addFromFile(pdf, { title: '工具教材' })
  await h.books.setActive(added.book.id)
  const parsed = await h.parser.start(added.book.id)
  await parsed.completion
  const definitions = []
  const dispose = registerTextbookTools(
    { register(definition) { definitions.push(definition); return () => {} } },
    {
      paths: h.paths,
      books: h.books,
      progress: h.progress,
      tree: h.tree,
      parser: h.parser,
      getReaderBaseUrl: () => 'http://127.0.0.1:55555',
    },
  )
  return { h, book: added.book, definitions, dispose }
}

test('M4 tools: list, tree, search and progress expose real page/block citations', async (t) => {
  const { h, book, definitions, dispose } = await setup(t)
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  assert.equal(byName.size, 7)

  const list = await byName.get('textbook_list').execute({}, {})
  assert.equal(list.books.length, 1)
  assert.equal(list.books[0].id, book.id)
  assert.equal(list.books[0].active, true)
  assert.equal(list.books[0].parse.status, 'done')

  const tree = await byName.get('textbook_tree').execute({}, {})
  assert.equal(tree.tree.rootTitle, '工具教材')
  assert.equal(tree.tree.chapters.length, 3)
  assert.equal(tree.tree.chapters[0].children.length, 3)
  assert.match(tree.readerUrl, /^http:\/\/127\.0\.0\.1:55555\/textbook-reader\/\?book=/)

  const search = await byName.get('textbook_search').execute({ query: '正文', limit: 3 }, {})
  assert.equal(search.hits.length, 3)
  const hit = search.hits[0]
  assert.equal(hit.page >= 1, true)
  assert.match(hit.blockId, /^b\d+$/)
  assert.match(hit.citationUrl, /&page=\d+&block=b\d+$/)
  assert.match(hit.citationUrl, new RegExp(`book=${book.id}`))
  assert.ok(hit.text.length > 0)

  const firstChapter = tree.tree.chapters[0]
  const updated = await byName.get('textbook_progress_update').execute({
    currentPage: 5,
    markRead: [firstChapter.id],
    mastery: [{ nodeId: firstChapter.id, level: 4 }],
    addQuestion: { text: '第 5 页的结论怎么推出来？', page: 5 },
  }, {})
  assert.equal(updated.progress.currentPage, 5)
  assert.equal(updated.progress.readChapters.includes(firstChapter.id), true)
  assert.equal(updated.progress.mastery[firstChapter.id].level, 4)
  assert.equal(updated.progress.questions.length, 1)

  const progress = await byName.get('textbook_progress').execute({}, {})
  assert.equal(progress.progress.currentPage, 5)
  assert.equal(progress.progress.questions[0].page, 5)

  const again = await byName.get('textbook_parse').execute({}, {})
  assert.equal(again.started, false)
  dispose()
})

test('M4 tools: textbook_add imports and activates a new PDF', async (t) => {
  const { h, definitions } = await setup(t)
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  const pdf = await h.writePdf('second.pdf', 4)
  const added = await byName.get('textbook_add').execute({ path: pdf, title: '第二本教材' }, {})
  assert.equal(added.book.title, '第二本教材')
  assert.equal(added.book.pages, 4)
  assert.equal(await h.books.activeBookId(), added.book.id)
  assert.match(added.readerUrl, new RegExp(`book=${added.book.id}`))
})
