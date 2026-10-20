import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../dist/index.js'

test('M1 plugin: apply registers the prefix route and disposes it with the fiber', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'tbr-plugin-'))
  const previous = process.env.TEXTBOOK_READER_DATA_DIR
  process.env.TEXTBOOK_READER_DATA_DIR = dataRoot
  t.after(async () => {
    if (previous === undefined) delete process.env.TEXTBOOK_READER_DATA_DIR
    else process.env.TEXTBOOK_READER_DATA_DIR = previous
    await rm(dataRoot, { recursive: true, force: true })
  })

  const injections = []
  let registered
  let disposed = false
  const base = {
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    effect: () => undefined,
    inject: (services, callback) => {
      injections.push({ services, callback })
    },
  }

  apply(base)
  const injected = injections.find((item) => item.services[0] === 'webServer')
  assert.ok(injected)

  const server = http.createServer()
  const scoped = {
    ...base,
    webServer: {
      register(route) {
        registered = route
        return () => {
          disposed = true
        }
      },
    },
    effect: (factory) => {
      const cleanup = factory()
      server.on('close', () => cleanup?.())
    },
  }
  injected.callback(scoped)
  assert.equal(registered.kind, 'prefix')
  assert.equal(registered.path, '/textbook-reader')
  assert.equal(typeof registered.handler, 'function')

  server.on('request', (req, res) => registered.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const response = await fetch(`http://127.0.0.1:${port}/textbook-reader/api/health`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.service, 'dsh-textbook-reader')

  const definitions = []
  const toolsInjection = injections.find((item) => item.services[0] === 'tools')
  assert.ok(toolsInjection)
  toolsInjection.callback({
    ...base,
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
    effect: () => undefined,
  })
  assert.deepEqual(
    definitions.map((definition) => definition.name).sort(),
    ['textbook_add', 'textbook_list', 'textbook_parse', 'textbook_progress', 'textbook_progress_update', 'textbook_search', 'textbook_tree'],
  )

  let promptSection
  const promptInjection = injections.find((item) => item.services[0] === 'systemPrompt')
  assert.ok(promptInjection)
  promptInjection.callback({
    ...base,
    systemPrompt: { section: (section) => { promptSection = section; return () => {} } },
    effect: () => undefined,
  })
  assert.match(promptSection.text, /textbook_search/)
  assert.match(promptSection.text, /\[p\.N\]/)
  assert.match(promptSection.text, /readerUrl/)

  await new Promise((resolve) => server.close(resolve))
  assert.equal(disposed, true)
})

test('M1 plugin: a composition without webServer stays dormant', () => {
  let called = false
  const base = {
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    effect: () => undefined,
    inject: (_services, callback) => {
      called = true
      callback({ ...base, effect: () => undefined })
    },
  }
  assert.doesNotThrow(() => apply(base))
  assert.equal(called, true)
})
