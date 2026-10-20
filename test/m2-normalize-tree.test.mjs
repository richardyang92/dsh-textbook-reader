import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeArtifacts } from '../dist/mineru/normalize.js'
import { generateTree } from '../dist/tree/generate.js'
import { validateTree } from '../dist/store/tree.js'
import { buildContentList, buildLayout } from './fixtures.mjs'

test('M2 normalize + tree: 420-page textbook yields chapters and sections', () => {
  const contentList = buildContentList({ pages: 420, chapters: 8, sectionsPerChapter: 4, bookTitle: '微积分' })
  const normalized = normalizeArtifacts({
    bookId: 'b-test',
    pages: 420,
    contentList,
    layout: buildLayout(420),
    source: { contentListFile: 'uuid_content_list.json', layoutFile: 'layout.json' },
  })
  assert.equal(normalized.normalized.pages.length, 420)
  assert.ok(normalized.normalized.stats.blocks > 420)
  assert.ok(normalized.normalized.stats.titleBlocks >= 41)
  assert.equal(normalized.normalized.stats.images >= 1, true)
  assert.equal(normalized.normalized.stats.tables, 1)
  assert.equal(normalized.normalized.pages[2].blocks.some((block) => block.type === 'image'), true)

  const image = normalized.normalized.pages[2].blocks.find((block) => block.type === 'image')
  assert.deepEqual(image.bbox, [150, 400, 600, 650])

  const generated = generateTree({
    bookId: 'b-test',
    bookTitle: '微积分',
    pages: 420,
    headings: normalized.normalized.headings,
  })
  validateTree(generated.tree)
  const chapters = generated.tree.nodes.filter((node) => node.level === 1)
  const sections = generated.tree.nodes.filter((node) => node.level === 2)
  assert.equal(chapters.length, 8, `expected 8 chapters, got ${chapters.length}: ${chapters.map((node) => node.title)}`)
  assert.equal(sections.length, 32)
  assert.equal(chapters[0].pageStart, 1)
  assert.equal(chapters[7].pageStart, 365)
  assert.equal(chapters[7].pageEnd, 420)
  assert.equal(chapters.every((chapter) => chapter.children.length === 4), true)
  for (const chapter of chapters) {
    assert.ok(chapter.pageEnd >= chapter.pageStart)
    for (const childId of chapter.children) {
      const child = generated.tree.nodes.find((node) => node.id === childId)
      assert.equal(child.level, 2)
      assert.equal(child.parentId, chapter.id)
      assert.ok(child.pageStart >= chapter.pageStart)
      assert.ok(child.pageEnd <= chapter.pageEnd)
    }
  }
})

test('M2 tree: flat single-level headings still produce a navigable tree', () => {
  const contentList = []
  for (let page = 1; page <= 60; page += 1) {
    contentList.push({ type: 'text', text: `第 ${page} 页正文`, bbox: [100, 300, 900, 760], page_idx: page - 1 })
    if ([1, 21, 41].includes(page)) {
      contentList.push({ type: 'text', text: `第${[1, 2, 3][[1, 21, 41].indexOf(page)]}章 平面标题`, text_level: 1, bbox: [100, 150, 900, 190], page_idx: page - 1 })
    }
  }
  const normalized = normalizeArtifacts({ bookId: 'b-flat', pages: 60, contentList, source: {} })
  const generated = generateTree({ bookId: 'b-flat', bookTitle: '平面标题教材', pages: 60, headings: normalized.normalized.headings })
  validateTree(generated.tree)
  const chapters = generated.tree.nodes.filter((node) => node.level === 1)
  assert.equal(chapters.length, 3)
  assert.equal(chapters[0].title, '第1章 平面标题')
})

test('M2 tree: no headings degrades to explicit page-window chapters', () => {
  const contentList = Array.from({ length: 90 }, (_, index) => ({
    type: 'text',
    text: `第 ${index + 1} 页正文`,
    bbox: [100, 300, 900, 760],
    page_idx: index,
  }))
  const normalized = normalizeArtifacts({ bookId: 'b-flat2', pages: 90, contentList, source: {} })
  const generated = generateTree({ bookId: 'b-flat2', bookTitle: '无标题教材', pages: 90, headings: normalized.normalized.headings })
  validateTree(generated.tree)
  const chapters = generated.tree.nodes.filter((node) => node.level === 1)
  assert.equal(chapters.length, 4)
  assert.equal(generated.tree.warnings.some((warning) => /按页数自动分章/.test(warning)), true)
  assert.equal(chapters[3].pageEnd, 90)
})

test('M2 normalize: layout fallback converts PDF points into normalized boxes', () => {
  const layout = {
    _backend: 'pipeline',
    _version_name: '2.6.4',
    pdf_info: [
      {
        page_idx: 0,
        page_size: [595, 841],
        para_blocks: [
          {
            type: 'title',
            bbox: [78, 169, 189, 187],
            lines: [{ spans: [{ content: '第1章 极限' }] }],
          },
          {
            type: 'text',
            bbox: [77, 198, 518, 259],
            lines: [{ spans: [{ content: '这是正文。' }] }],
          },
        ],
      },
    ],
  }
  const normalized = normalizeArtifacts({ bookId: 'b-layout', pages: 1, layout, source: { layoutFile: 'layout.json' } })
  assert.equal(normalized.normalized.pages[0].blocks.length, 2)
  const title = normalized.normalized.pages[0].blocks.find((block) => block.type === 'title')
  assert.equal(title.text, '第1章 极限')
  assert.equal(title.bbox[0], 131.1)
  assert.equal(title.bbox[1], 201)
  assert.equal(normalized.normalized.headings.length, 1)
})
