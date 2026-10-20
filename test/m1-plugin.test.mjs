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

  let injected
  let registered
  let disposed = false
  const base = {
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    effect: () => undefined,
    inject: (services, callback) => {
      injected = { services, callback }
    },
  }

  apply(base)
  assert.deepEqual(injected.services, ['webServer'])

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
