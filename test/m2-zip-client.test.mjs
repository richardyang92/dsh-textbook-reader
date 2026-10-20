import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MineruClient } from '../dist/mineru/client.js'
import { extractZip, unsafeEntryReason } from '../dist/mineru/zip.js'
import { discoverArtifacts } from '../dist/mineru/discover.js'
import { buildMineruZip, buildZip } from './fixtures.mjs'
import { makePdf } from './helpers.mjs'

test('M2 zip: extracts UUID-prefixed content list, layout, markdown and images', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tbr-zip-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const zipFile = join(root, 'result.zip')
  await writeFile(zipFile, await buildMineruZip({ pages: 10, chapters: 2 }))
  const target = join(root, 'raw')
  const result = await extractZip(zipFile, target)
  assert.ok(result.files.includes('uuid_content_list.json'))
  assert.ok(result.files.includes('images/fig1.jpg'))
  assert.ok(result.bytes > 0)

  const discovered = await discoverArtifacts(target)
  assert.equal(discovered.contentListFile, 'uuid_content_list.json')
  assert.equal(discovered.layoutFile, 'layout.json')
  assert.equal(discovered.markdownFile, 'full.md')
  assert.ok(discovered.contentList.length > 0)
  assert.ok(discovered.imageFiles.some((file) => file.includes('fig1.jpg')))
})

test('M2 zip: unsafe names are rejected before extraction', async (t) => {
  assert.equal(unsafeEntryReason('../evil.txt'), '路径穿越')
  assert.equal(unsafeEntryReason('/absolute.txt'), '绝对路径')
  assert.equal(unsafeEntryReason('C:/windows.txt'), '盘符路径')
  assert.equal(unsafeEntryReason('safe/file.txt'), undefined)

  const root = await mkdtemp(join(tmpdir(), 'tbr-zip-bad-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bogus = join(root, 'bogus.zip')
  await writeFile(bogus, Buffer.from('not a zip'))
  await assert.rejects(() => extractZip(bogus, join(root, 'raw')), (error) => error.code === 'zip_invalid')
})

test('M2 zip: empty archives fail explicitly and safe files survive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tbr-zip-empty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const zipFile = join(root, 'empty.zip')
  await writeFile(zipFile, await buildZip({ 'only.txt': 'hello' }))
  const result = await extractZip(zipFile, join(root, 'raw'))
  assert.deepEqual(result.files, ['only.txt'])
  const discovered = await discoverArtifacts(join(root, 'raw'))
  assert.equal(discovered.contentList, undefined)
  assert.ok(discovered.warnings.some((warning) => /content_list/.test(warning)))
})

test('M2 MinerU client: request shape, no Content-Type on PUT, polling and token errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tbr-mineru-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pdf = join(root, 'sample.pdf')
  await writeFile(pdf, await makePdf(1))
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/file-urls/batch')) {
      return new Response(JSON.stringify({ code: 0, data: { batch_id: 'batch-abc', file_urls: ['https://upload.example/signed'] } }), { status: 200 })
    }
    if (options.method === 'PUT') return new Response('', { status: 200 })
    if (String(url).includes('/extract-results/batch/')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          batch_id: 'batch-abc',
          extract_result: [{ file_name: 'sample.pdf', state: 'running', extract_progress: { extracted_pages: 3, total_pages: 10 } }],
        },
      }), { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }
  const client = new MineruClient({ fetchImpl })
  const ticket = await client.requestUpload('mineru-token', {
    fileName: 'sample.pdf',
    dataId: 'b-test',
    isOcr: true,
    enableTable: true,
    language: 'ch',
  })
  assert.deepEqual(ticket, { batchId: 'batch-abc', fileUrls: ['https://upload.example/signed'] })

  await client.uploadFile('https://upload.example/signed', pdf)
  const uploadCall = calls.find((call) => call.options.method === 'PUT')
  assert.ok(uploadCall)
  assert.equal(uploadCall.options.headers['content-type'], undefined)
  assert.equal(uploadCall.options.headers['content-length'], String((await stat(pdf)).size))
  const batch = await client.getBatch('mineru-token', 'batch-abc')
  assert.equal(batch.files[0].state, 'running')
  assert.equal(batch.files[0].extractedPages, 3)
  assert.equal(batch.files[0].totalPages, 10)

  const authCalls = []
  const badClient = new MineruClient({
    fetchImpl: async (url, options) => {
      authCalls.push({ url, options })
      return new Response(JSON.stringify({ code: 'A0202', msg: 'Invalid Token' }), { status: 200 })
    },
  })
  let authError
  try {
    await badClient.requestUpload('bad-token', { fileName: 'x.pdf', dataId: 'x', isOcr: false, enableTable: true, language: 'ch' })
  } catch (error) {
    authError = error
  }
  assert.equal(authError.code, 'mineru_token_invalid')
  assert.equal(authError.status, 502)
  assert.equal(String(authError.message).includes('bad-token'), false)
  assert.equal(String(authError.stack ?? '').includes('bad-token'), false)
})

test('M2 MinerU client: download zip validates the archive signature', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tbr-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const zip = await buildMineruZip({ pages: 5, chapters: 1 })
  const client = new MineruClient({ fetchImpl: async () => new Response(zip, { status: 200, headers: { 'content-length': String(zip.byteLength) } }) })
  const target = join(root, 'result.zip')
  await client.downloadZip('https://cdn.example/result.zip', target)
  assert.equal((await stat(target)).size, zip.byteLength)
  assert.deepEqual((await readFile(target)).subarray(0, 2), Buffer.from([0x50, 0x4b]))

  const bad = new MineruClient({ fetchImpl: async () => new Response('not zip', { status: 200 }) })
  await assert.rejects(() => bad.downloadZip('https://cdn.example/bad', join(root, 'bad.zip')), (error) => error.code === 'mineru_zip_invalid')
})
