import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SubagentChatBackend } from '../dist/chat/subagent-backend.js'

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

async function makeBackend(t) {
  const calls = { activation: undefined, sends: [], interrupts: [] }
  const queue = []
  let resolveNext
  let closed = false

  const push = (frame) => {
    if (closed) return
    if (resolveNext) {
      const resolve = resolveNext
      resolveNext = undefined
      resolve({ value: frame, done: false })
    } else {
      queue.push(frame)
    }
  }
  const end = () => {
    closed = true
    if (resolveNext) {
      const resolve = resolveNext
      resolveNext = undefined
      resolve({ value: undefined, done: true })
    }
  }

  const parent = { id: 'session-parent', status: 'running' }
  const messages = [
    { id: 'p1', role: 'user', content: [{ type: 'text', text: '[[tbr-primer]] 只回复 READY' }] },
    { id: 'p2', role: 'assistant', content: [{ type: 'text', text: 'READY' }] },
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '【教材伴读模式】只使用 textbook_* 工具。\n\n这节讲什么' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '讲反向传播 [p.2]' }] },
  ]
  const activation = {
    childId: 'session-child',
    messageId: 'm0',
    result: new Promise(() => {}),
    dispose: async () => {},
  }
  const subagents = {
    async startActivation(spec) {
      calls.activation = spec
      return activation
    },
    async sendMessage(sender, targetId, content) {
      calls.sends.push({ sender, targetId, content })
      return 'm1'
    },
    interrupt(targetId, authority) {
      calls.interrupts.push({ targetId, authority })
    },
  }
  const agents = {
    roots: () => [parent],
    get: (id) =>
      id === 'session-parent'
        ? parent
        : {
            id,
            ctx: {
              tools: {
                schemas: () => [{ name: 'textbook_search' }, { name: 'bash' }],
                restrict(filter) {
                  calls.restriction = filter
                },
              },
            },
          },
  }
  const sessions = { get: () => ({ deriveMessages: () => messages }) }
  const controller = {
    inspect: async () => ({}),
    async *follow() {
      while (!closed) {
        if (queue.length > 0) {
          yield queue.shift()
          continue
        }
        const next = await new Promise((resolve) => {
          resolveNext = resolve
        })
        if (next.done) return
        yield next.value
      }
    },
  }
  const values = {
    agents,
    subagents,
    sessions,
    sessionController: controller,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }) },
  }
  const ctx = { get: (name) => values[name] }
  const backend = new SubagentChatBackend({ ctx, paths: { books: '/tmp' }, logger: {} })
  t.after(() => end())
  return { backend, calls, push, end, book: makeBook() }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('C0 subagent backend: primes a spawn child and streams a user turn', async (t) => {
  const { backend, calls, push, end, book } = await makeBackend(t)
  const opened = await backend.open({ book })
  assert.match(opened.sessionId, /^session-/)
  assert.equal(opened.created, true)
  assert.equal(calls.activation, undefined)

  const events = []
  const unsubscribe = opened.connection.onEvent((event) => events.push(event))
  await opened.connection.send('这节讲什么')
  assert.equal(calls.activation.provider, 'spawn')
  assert.equal(calls.activation.childId, opened.sessionId)
  assert.equal(calls.activation.delivery, 'caller')
  assert.equal(calls.activation.request.parent.id, 'session-parent')
  assert.match(calls.activation.request.prompt[0].text, /^【教材伴读模式】/)
  assert.match(calls.activation.request.prompt[0].text, /这节讲什么/)
  assert.equal(calls.activation.request.agentOptions.provider, 'deepseek-account')
  assert.equal(calls.sends.length, 0)

  push({ type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: '这节讲什么' }] } } })
  push({ type: 'assistant-stream', frame: { type: 'start', turn: 1, step: 1 } })
  push({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: '讲反向传播' } } })
  push({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } } })
  push({ type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', seq: 9 } } })
  push({ type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } })
  await tick()
  await tick()

  const types = events.map((event) => event.type)
  assert.ok(types.includes('start'))
  assert.ok(types.includes('delta'))
  assert.ok(types.includes('finish'))
  assert.ok(types.includes('end'))
  assert.equal(events.find((event) => event.type === 'delta').text, '讲反向传播')

  const history = opened.connection.history()
  assert.deepEqual(history.map((message) => message.text), ['这节讲什么', '讲反向传播 [p.2]'])
  assert.deepEqual(history[1].citations, [{ page: 2 }])

  opened.connection.cancel()
  assert.equal(calls.interrupts[0].targetId, opened.sessionId)
  assert.deepEqual(calls.interrupts[0].authority, { kind: 'ancestor', agent: { id: 'session-parent', status: 'running' } })

  unsubscribe()
  await opened.connection.dispose()
  end()
})

test('C0 subagent backend: tutor sessions are created inside the dedicated workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tbr-subagent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = { created: [], workspaces: [], attached: [] }
  const tutor = { id: 'session-tutor', status: 'running' }
  const activation = {
    childId: 'session-child',
    result: new Promise(() => {}),
    dispose: async () => {},
  }
  const values = {
    agents: {
      get: (id) => (id === 'session-tutor' ? tutor : undefined),
      roots: () => [],
    },
    subagents: {
      async startActivation(spec) {
        calls.activation = spec
        return activation
      },
      async sendMessage() {
        return 'm1'
      },
      interrupt() {},
    },
    sessions: { get: () => undefined },
    workspaceRegistry: {
      async create(path, title) {
        calls.workspaces.push({ path, title })
        return {
          id: 'ws-tutor',
          path,
          attachSession: async (sessionId) => calls.attached.push(sessionId),
        }
      },
      async archiveSession() {},
    },
    sessionPersistence: {
      async list() {
        return [{ header: { id: 'session-old', cwd: join(root, 'workspace') } }]
      },
    },
    sessionController: {
      async create(request) {
        calls.created.push(request)
        return { sessionId: 'session-tutor' }
      },
      async resolveAgent(sessionId) {
        return sessionId === 'session-tutor' ? { agent: tutor } : undefined
      },
      async rename() {},
      async inspect() {
        return {}
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    },
  }
  const ctx = { get: (name) => values[name] }
  const backend = new SubagentChatBackend({
    ctx,
    paths: { root, books: join(root, 'books') },
    agentPreset: 'textbook-tutor',
    logger: {},
  })

  const opened = await backend.open({ book: makeBook() })
  t.after(() => opened.connection.dispose())

  assert.deepEqual(calls.workspaces, [{ path: join(root, 'workspace'), title: '教材伴读' }])
  assert.ok(calls.attached.includes('session-old'))
  assert.equal(calls.created.length, 1)
  assert.equal(calls.created[0].workspaceId, 'ws-tutor')
  assert.equal(Object.hasOwn(calls.created[0], 'cwd'), false)
  assert.equal(calls.created[0].agentPreset, 'textbook-tutor')
  assert.match(opened.sessionId, /^session-/)
})

test('C0 subagent backend: a legacy parent outside the workspace is replaced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tbr-stale-parent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'books'), { recursive: true })
  await writeFile(
    join(root, 'tutor-session.json'),
    JSON.stringify({
      version: 1,
      sessionId: 'session-old-parent',
      title: '教材伴读导师',
      createdAt: '2026-10-20T00:00:00.000Z',
    }),
  )

  const oldParent = {
    id: 'session-old-parent',
    status: 'running',
    session: { header: { cwd: '/Users/example/.dsh/profiles/desktop' } },
  }
  const newParent = {
    id: 'session-new-parent',
    status: 'running',
    session: { header: { cwd: join(root, 'workspace') } },
  }
  const activation = {
    childId: 'session-child',
    result: new Promise(() => {}),
    dispose: async () => {},
  }
  const calls = { created: [], activation: undefined }
  const values = {
    agents: {
      get: (id) =>
        id === 'session-old-parent' ? oldParent : id === 'session-new-parent' ? newParent : undefined,
      roots: () => [],
    },
    subagents: {
      async startActivation(spec) {
        calls.activation = spec
        return activation
      },
      async sendMessage() {
        return 'm1'
      },
      interrupt() {},
    },
    sessions: { get: () => undefined },
    workspaceRegistry: {
      async create(path) {
        return { id: 'ws-tutor', path, attachSession: async () => {} }
      },
      async archiveSession() {},
    },
    sessionPersistence: { async list() { return [] } },
    sessionController: {
      async create(request) {
        calls.created.push(request)
        return { sessionId: 'session-new-parent' }
      },
      async resolveAgent(sessionId) {
        if (sessionId === 'session-new-parent') return { agent: newParent }
        if (sessionId === 'session-old-parent') return { agent: oldParent }
        return undefined
      },
      async rename() {},
      async inspect() {
        return {}
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    },
  }
  const backend = new SubagentChatBackend({
    ctx: { get: (name) => values[name] },
    paths: { root, books: join(root, 'books') },
    agentPreset: 'textbook-tutor',
    logger: {},
  })

  const opened = await backend.open({ book: makeBook() })
  t.after(() => opened.connection.dispose())
  assert.equal(calls.created.length, 1)
  assert.equal(calls.created[0].workspaceId, 'ws-tutor')

  await opened.connection.send('这节讲什么')
  assert.equal(calls.activation.request.parent.id, 'session-new-parent')
})

test('C0 subagent backend: rebuilt history keeps tool calls for old conversations', async (t) => {
  const events = [
    { type: 'turn/start', seq: 10, data: {} },
    {
      type: 'user/message',
      seq: 11,
      data: {
        content: [
          { type: 'text', text: '【教材伴读模式】只使用 textbook_* 工具。\n\n这节讲什么' },
        ],
      },
    },
    {
      type: 'tool/call',
      seq: 12,
      data: {
        name: 'textbook_search',
        callId: 'call-1',
        arguments: JSON.stringify({ query: 'interaction' }),
      },
    },
    {
      type: 'tool/result',
      seq: 13,
      data: {
        message: {
          source: { callId: 'call-1' },
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query: 'interaction',
                hits: [{ page: 26 }, { page: 28 }],
              }),
            },
          ],
        },
      },
    },
    {
      type: 'assistant/message',
      seq: 14,
      data: { message: { content: [{ type: 'text', text: '讲反向传播 [p.2]' }] } },
    },
    { type: 'turn/end', seq: 15, data: { reason: { kind: 'completed' } } },
  ]
  const values = {
    sessionController: {
      async inspect() {
        return { events, inheritedEventCount: 0 }
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    },
  }
  const backend = new SubagentChatBackend({
    ctx: { get: (name) => values[name] },
    paths: { books: '/tmp' },
    logger: {},
  })

  const history = await backend.history('session-child')
  assert.deepEqual(history.map((message) => message.text), ['这节讲什么', '讲反向传播 [p.2]'])
  assert.equal(history[1].citations[0].page, 2)
  assert.equal(history[1].toolCalls.length, 1)
  assert.equal(history[1].toolCalls[0].name, 'textbook_search')
  assert.equal(history[1].toolCalls[0].status, 'end')
  assert.match(history[1].toolCalls[0].summary, /命中 2 段 · p\.26–28/)
})
