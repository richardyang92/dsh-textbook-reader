import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

async function readJson(relative) {
  return JSON.parse(await readFile(join(root, relative), 'utf8'))
}

test('package manifest is a DSH bundle with a patch layer', async () => {
  const pkg = await readJson('package.json')
  assert.equal(pkg.name, 'dsh-textbook-reader')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.exports?.['.'], './dist/index.js')
  assert.match(pkg.engines?.node ?? '', />=22/)
})

test('cordis patch inserts exactly the textbook-reader row', async () => {
  const text = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /- insert:/)
  assert.match(text, /id: textbook-reader/)
  assert.match(text, /name: 'dsh-textbook-reader'/)
})

test('built host half exports a loadable plugin', async () => {
  const mod = await import('../dist/index.js')
  assert.equal(mod.name, 'dsh-textbook-reader')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
})
