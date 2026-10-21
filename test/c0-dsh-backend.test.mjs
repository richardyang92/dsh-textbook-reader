import assert from 'node:assert/strict'
import test from 'node:test'
import { DshAgentBackend } from '../dist/chat/dsh-backend.js'

function makeBook() {
  return {
    id: 'b-test1234',
    title: '测试教材',
    pdf: 'source.pdf',
    pages: 100,
    bytes: 1024,
    sha256: 'abc',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    parse: { status: 'done', warnings: [] },
  }
}

test('C0 DSH backend: followup carries a complete identified UserMessage', async (t) => {
  const sent = []
  const agent = {
    id: 'session-test',
    status: 'idle',
    followup(input) {
      sent.push(input)
    },
  }
  const agents = {
    get: () => undefined,
    create: async (options) => {
      options.setup({}, agent)
      return { agent, dispose: async () => {} }
    },
    resume: async () => ({ agent, dispose: async () => {} }),
  }
  const values = {
    agents,
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory: '/tmp' },
  }
  const backend = new DshAgentBackend({
    ctx: { get: (name) => values[name] },
    paths: { root: '/tmp', books: '/tmp' },
    getModel: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    logger: {},
  })

  const opened = await backend.open({ book: makeBook() })
  t.after(() => opened.connection.dispose())
  await opened.connection.send('这节讲什么')

  assert.equal(sent.length, 1)
  assert.equal(typeof sent[0].id, 'string')
  assert.ok(sent[0].id.length > 0)
  assert.equal(sent[0].role, 'user')
  assert.deepEqual(sent[0].source, { kind: 'user' })
  assert.deepEqual(sent[0].content, [{ type: 'text', text: '这节讲什么' }])
})
