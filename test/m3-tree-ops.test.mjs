import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTreeOp } from '../dist/tree/ops.js'
import { generateTree } from '../dist/tree/generate.js'
import { validateTree } from '../dist/store/tree.js'
import { buildContentList, buildLayout } from './fixtures.mjs'
import { normalizeArtifacts } from '../dist/mineru/normalize.js'
import { createHarness, request } from './helpers.mjs'

function makeTree() {
  const contentList = buildContentList({ pages: 120, chapters: 4, sectionsPerChapter: 3, bookTitle: '结构教材' })
  const normalized = normalizeArtifacts({
    bookId: 'b-ops',
    pages: 120,
    contentList,
    layout: buildLayout(120),
    source: { contentListFile: 'uuid_content_list.json', layoutFile: 'layout.json' },
  })
  return generateTree({ bookId: 'b-ops', bookTitle: '结构教材', pages: 120, headings: normalized.normalized.headings }).tree
}

test('M3 tree ops: rename, merge section/chapter and relevel keep a valid tree', () => {
  const tree = makeTree()
  const chapters = tree.nodes.filter((node) => node.level === 1)
  const firstChapter = chapters[0]
  const firstSection = tree.nodes.find((node) => node.id === firstChapter.children[0])
  const secondSection = tree.nodes.find((node) => node.id === firstChapter.children[1])

  const renamed = applyTreeOp(tree, { op: 'rename', nodeId: firstSection.id, title: '手动改名的节' })
  assert.equal(renamed.nodes.find((node) => node.id === firstSection.id).title, '手动改名的节')
  assert.equal(renamed.nodes.find((node) => node.id === firstSection.id).source, 'manual')
  validateTree(renamed)

  const merged = applyTreeOp(tree, { op: 'merge', nodeId: secondSection.id })
  assert.equal(merged.nodes.some((node) => node.id === secondSection.id), false)
  const mergedPrevious = merged.nodes.find((node) => node.id === firstSection.id)
  assert.ok(mergedPrevious.pageEnd >= secondSection.pageEnd)
  validateTree(merged)

  const firstSectionAgain = tree.nodes.find((node) => node.id === firstChapter.children[0])
  const mergedIntoChapter = applyTreeOp(tree, { op: 'merge', nodeId: firstSectionAgain.id })
  assert.equal(mergedIntoChapter.nodes.some((node) => node.id === firstSectionAgain.id), false)
  validateTree(mergedIntoChapter)

  const chapterTwo = chapters[1]
  const mergedChapter = applyTreeOp(tree, { op: 'merge', nodeId: chapterTwo.id })
  assert.equal(mergedChapter.nodes.some((node) => node.id === chapterTwo.id), false)
  const newParent = mergedChapter.nodes.find((node) => node.id === chapters[0].id)
  for (const oldChild of chapterTwo.children) {
    assert.equal(newParent.children.includes(oldChild), true)
    assert.equal(mergedChapter.nodes.find((node) => node.id === oldChild).parentId, newParent.id)
  }
  validateTree(mergedChapter)

  const lastSection = tree.nodes.find((node) => node.id === firstChapter.children.at(-1))
  const promoted = applyTreeOp(tree, { op: 'relevel', nodeId: lastSection.id, level: 1 })
  const promotedNode = promoted.nodes.find((node) => node.id === lastSection.id)
  assert.equal(promotedNode.level, 1)
  assert.equal(promotedNode.parentId, undefined)
  validateTree(promoted)

  const secondChapter = chapters[1]
  const demoted = applyTreeOp(tree, { op: 'relevel', nodeId: secondChapter.id, level: 2 })
  const demotedNode = demoted.nodes.find((node) => node.id === secondChapter.id)
  assert.equal(demotedNode.level, 2)
  assert.equal(demotedNode.parentId, chapters[0].id)
  validateTree(demoted)
})

test('M3 tree ops: ambiguous operations fail with actionable errors', () => {
  const tree = makeTree()
  const firstChapter = tree.nodes.find((node) => node.level === 1)
  assert.throws(() => applyTreeOp(tree, { op: 'merge', nodeId: firstChapter.id }), (error) => error.code === 'tree_op_invalid')
  assert.throws(() => applyTreeOp(tree, { op: 'rename', nodeId: firstChapter.id, title: '   ' }), (error) => error.code === 'tree_op_invalid')
  assert.throws(() => applyTreeOp(tree, { op: 'relevel', nodeId: firstChapter.id, level: 2 }), (error) => error.code === 'tree_op_invalid')
  assert.throws(() => applyTreeOp(tree, { op: 'merge', nodeId: 'n-missing' }), (error) => error.code === 'node_not_found')
})

test('M3 tree ops: HTTP POST persists the edited tree', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const pdf = await h.writePdf('tree.pdf', 30)
  const added = await request(h.base, '/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pdf }),
  })
  const id = added.json.book.id
  const tree = makeTree()
  tree.bookId = id
  const saved = await h.tree.save(id, tree)
  const chapter = saved.nodes.find((node) => node.level === 1)
  const renamed = await request(h.base, `/api/books/${id}/tree`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'rename', nodeId: chapter.id, title: '重命名后的章' }),
  })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.json.tree.nodes.find((node) => node.id === chapter.id).title, '重命名后的章')
  const again = await request(h.base, `/api/books/${id}/tree`)
  assert.equal(again.json.tree.nodes.find((node) => node.id === chapter.id).title, '重命名后的章')
  const bad = await request(h.base, `/api/books/${id}/tree`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'rename', nodeId: chapter.id, title: '' }),
  })
  assert.equal(bad.status, 422)
})
