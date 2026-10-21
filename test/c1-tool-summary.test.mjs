import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { summarizeToolArgs, summarizeToolResult } from '../dist/chat/tool-summary.js'

test('tool summary: one-line digests instead of raw tool JSON', async () => {
  const search = JSON.stringify({
    bookId: 'b-test',
    title: 'Peskin and Schroeder',
    query: 'interaction',
    readerUrl: 'http://127.0.0.1:1/textbook-reader/?book=b-test',
    hits: [
      { page: 28, blockId: 's1-b209', bbox: [1, 2, 3, 4], text: 'where $H_I$ is ...' },
      { page: 26, blockId: 's1-b12', bbox: [1, 2, 3, 4], text: 'Since most particle ...' },
      { page: 28, blockId: 's1-b210', bbox: [1, 2, 3, 4], text: '...' },
    ],
  })
  assert.equal(summarizeToolResult('textbook_search', search), '“interaction” · 命中 3 段 · p.26–28')
  assert.doesNotMatch(summarizeToolResult('textbook_search', search), /bookId|blockId|\{/)

  const empty = JSON.stringify({ query: 'missing', hits: [] })
  assert.equal(summarizeToolResult('textbook_search', empty), '“missing” · 没有命中')

  const noPages = JSON.stringify({ hits: [{ text: 'no page' }] })
  assert.equal(summarizeToolResult('textbook_search', noPages), '命中 1 段')

  const books = JSON.stringify({
    books: [
      { id: 'b-1', title: 'Peskin and Schroeder', active: false },
      { id: 'b-2', title: '测试教材', active: true },
    ],
    activeBookId: 'b-2',
  })
  assert.equal(summarizeToolResult('textbook_list', books), '2 本教材 · 当前《测试教材》')
  assert.equal(summarizeToolResult('textbook_list', JSON.stringify({ books: [], activeBookId: null })), '0 本教材')

  const tree = JSON.stringify({
    tree: {
      rootTitle: '测试教材',
      chapters: [
        { id: 'c1', title: '第一章', children: [{ id: 's1' }, { id: 's2' }] },
        { id: 'c2', title: '第二章', children: [{ id: 's3' }] },
      ],
    },
  })
  assert.equal(summarizeToolResult('textbook_tree', tree), '章节树 · 2 章 · 3 节')
  assert.equal(
    summarizeToolResult('textbook_tree', JSON.stringify({ tree: null, parse: { status: 'running' } })),
    '解析状态：解析中',
  )

  const progress = JSON.stringify({
    progress: { currentPage: 42, readChapters: ['c1'], questions: [{ id: 'q1' }], mastery: {} },
  })
  assert.equal(summarizeToolResult('textbook_progress', progress), '读到 p.42 · 已读 1 节 · 1 个疑问')

  assert.equal(summarizeToolResult('textbook_parse', JSON.stringify({ started: true })), '已提交解析')
  assert.equal(
    summarizeToolResult('textbook_add', JSON.stringify({ book: { title: '测试教材' } })),
    '已加入《测试教材》',
  )

  // Failures and non-JSON text stay one line, clipped.
  assert.equal(summarizeToolResult('read', 'line one\nline two', true), '失败：line one line two')
  assert.equal(summarizeToolResult('textbook_search', '失败：找不到教材「x」。', true), '失败：找不到教材「x」。')
  assert.equal(
    summarizeToolResult('textbook_search', JSON.stringify({ message: '找不到这本教材' }), true),
    '失败：找不到这本教材',
  )
  assert.ok(summarizeToolResult('read', 'x'.repeat(300)).length <= 96)
  assert.doesNotMatch(summarizeToolResult('read', 'x'.repeat(300)), /\n/)

  // An older host caps the forwarded result at 200 chars; the digest must still
  // avoid printing truncated braces.
  const truncatedSearch =
    '{"bookId":"b-test","title":"Peskin and Schroeder","query":"interaction",' +
    '"readerUrl":"http://127.0.0.1:1/textbook-reader/?book=b-test","hits":[{"page":28,"blockId":"s1-b209","bbox":[1,2'
  assert.equal(summarizeToolResult('textbook_search', truncatedSearch), '“interaction”')
  assert.equal(
    summarizeToolResult('textbook_list', '{"books":[{"id":"b-1","title":"Peskin and Schroeder","pages":864'),
    'Peskin and Schroeder',
  )

  // Idempotent: a digest that already came from the host is not re-parsed.
  const digest = '“interaction” · 命中 3 段 · p.26–28'
  assert.equal(summarizeToolResult('textbook_search', digest), digest)

  // Running calls summarize their arguments.
  assert.equal(summarizeToolArgs('textbook_search', JSON.stringify({ query: 'interaction', book: 'b-test' })), '“interaction”')
  assert.equal(summarizeToolArgs('textbook_tree', JSON.stringify({ book: '测试教材' })), '测试教材')
  assert.equal(summarizeToolArgs('textbook_list', ''), undefined)
})

test('tool summary: the chat bundle renders the collapsed summary by default', async () => {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(code, /tbr-flow-head/)
  assert.match(code, /tbr-flow-list/)
  assert.match(code, /aria-expanded/)
  assert.match(code, /tbr-flow-chevron/)
  assert.doesNotMatch(code, /tbr-step-body/)
  assert.match(code, /summarizeToolResult/)
})
