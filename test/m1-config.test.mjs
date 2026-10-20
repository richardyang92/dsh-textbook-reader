import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { createHarness, fileMode, request } from './helpers.mjs'

test('M1 config: token is private, masked and never returned in a response', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const token = 'mineru-test-token-1234567890'
  const put = await request(h.base, '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  assert.equal(put.status, 200)
  assert.equal(put.json.ok, true)
  assert.equal(put.json.token.configured, true)
  assert.equal(put.json.token.mask, '••••7890')
  assert.equal(put.text.includes(token), false)
  assert.equal(await fileMode(h.paths.tokenFile), 0o600)
  assert.equal(await h.config.readToken(), token)

  const get = await request(h.base, '/api/config')
  assert.equal(get.status, 200)
  assert.equal(get.text.includes(token), false)
  assert.equal(get.json.token.mask, '••••7890')
  assert.equal(get.json.capabilities.captionVlm, false)

  const cleared = await request(h.base, '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clearToken: true }),
  })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.token.configured, false)
  assert.equal(await h.config.readToken(), undefined)
})

test('M1 config: bad tokens and conflicting commands are explicit errors', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())

  const short = await request(h.base, '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tiny' }),
  })
  assert.equal(short.status, 422)
  assert.equal(short.json.error.code, 'token_invalid')

  const conflict = await request(h.base, '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'mineru-test-token-1234567890', clearToken: true }),
  })
  assert.equal(conflict.status, 400)
  assert.equal(conflict.json.error.code, 'bad_request')

  const settings = await request(h.base, '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { mineru: { isOcr: false, language: 'en' } } }),
  })
  assert.equal(settings.status, 200)
  assert.equal(settings.json.settings.mineru.isOcr, false)
  assert.equal(settings.json.settings.mineru.language, 'en')
  assert.equal(settings.json.settings.mineru.modelVersion, 'vlm')

  assert.equal(await fileMode(h.paths.tokenFile).catch(() => -1), -1)
  assert.ok(join(h.paths.root, 'config.json'))
})
