#!/usr/bin/env node
/**
 * One-shot MinerU live calibration.
 *
 * Reads the token from the plugin's 0600 file (or --token-file), uploads a tiny
 * PDF, polls one task, downloads the zip, and prints only sanitized structure:
 * states, entry names, JSON top-level keys, sample block keys and bbox ranges.
 * It never prints the token, Authorization header or signed URLs.
 *
 * This consumes a small amount of MinerU daily page quota. It sends no image
 * caption/VLM request.
 *
 *   node scripts/mineru-probe.mjs --pdf /path/to/one-page.pdf
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { MineruClient } from '../dist/mineru/client.js'
import { discoverArtifacts } from '../dist/mineru/discover.js'
import { extractZip } from '../dist/mineru/zip.js'

const args = parseArgs(process.argv.slice(2))
const tokenFile = args['token-file'] ?? join(homedir(), '.dsh', 'textbook-reader', 'mineru-token')
const timeoutMs = Number(args.timeout ?? 10 * 60_000)
const intervalMs = Number(args.interval ?? 4_000)
const baseUrl = typeof args['base-url'] === 'string' ? args['base-url'] : undefined

let token
try {
  const info = await stat(tokenFile)
  if ((info.mode & 0o077) !== 0) console.error(`[probe] warning: ${tokenFile} mode is not 0600; fix with chmod 600`)
  token = (await readFile(tokenFile, 'utf8')).trim()
} catch {
  console.error(`[probe] cannot read token file: ${tokenFile}`)
  console.error('[probe] configure the token in 教材伴读 → 设置, or pass --token-file')
  process.exit(1)
}
if (!token) {
  console.error('[probe] token file is empty')
  process.exit(1)
}

const temp = await mkdtemp(join(tmpdir(), 'mineru-probe-'))
let pdfPath = typeof args.pdf === 'string' ? args.pdf : ''
if (!pdfPath) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([420, 595])
  page.drawText('MinerU probe — one page. This is a fixture.', { x: 48, y: 520, size: 14, font })
  page.drawText('One-page probe fixture; uploads only when run manually.', { x: 48, y: 480, size: 12, font })
  pdfPath = join(temp, 'probe.pdf')
  await writeFile(pdfPath, await doc.save())
}

const client = new MineruClient({ ...(baseUrl ? { baseUrl } : {}) })
try {
  console.log('[probe] requesting upload URL...')
  const ticket = await client.requestUpload(token, {
    fileName: 'probe.pdf',
    dataId: `probe-${Date.now()}`,
    isOcr: false,
    enableTable: true,
    language: 'ch',
  })
  console.log(JSON.stringify({ stage: 'request', batchIdPrefix: ticket.batchId.slice(0, 8) + '…', uploadUrlCount: ticket.fileUrls.length }))

  console.log('[probe] uploading...')
  await client.uploadFile(ticket.fileUrls[0], pdfPath)

  const deadline = Date.now() + timeoutMs
  let file
  let lastState = ''
  while (Date.now() < deadline) {
    const batch = await client.getBatch(token, ticket.batchId)
    file = batch.files[0]
    const state = `${file.state}${file.extractedPages !== undefined ? ` (${file.extractedPages}/${file.totalPages ?? '?'})` : ''}`
    if (state !== lastState) {
      console.log(JSON.stringify({ stage: 'poll', state, hasZipUrl: Boolean(file.fullZipUrl), error: file.errMsg ?? null }))
      lastState = state
    }
    if (file.state === 'done') break
    if (file.state === 'failed') throw new Error(file.errMsg || 'MinerU task failed')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  if (!file || file.state !== 'done' || !file.fullZipUrl) throw new Error('probe timed out before completion')

  const zipPath = join(temp, 'result.zip')
  await client.downloadZip(file.fullZipUrl, zipPath)
  const rawDir = join(temp, 'raw')
  const extracted = await extractZip(zipPath, rawDir)
  console.log(JSON.stringify({ stage: 'zip', entryCount: extracted.files.length, entries: extracted.files.slice(0, 60) }))

  const discovered = await discoverArtifacts(rawDir)
  const summary = {
    stage: 'shape',
    warnings: discovered.warnings,
    contentListFile: discovered.contentListFile ?? null,
    contentListLength: discovered.contentList?.length ?? null,
    contentListSampleKeys: isRecord(discovered.contentList?.[0]) ? Object.keys(discovered.contentList[0]) : null,
    contentListSample: isRecord(discovered.contentList?.[0])
      ? {
          type: discovered.contentList[0].type,
          page_idx: discovered.contentList[0].page_idx,
          bbox: discovered.contentList[0].bbox,
          text_level: discovered.contentList[0].text_level,
        }
      : null,
    layoutFile: discovered.layoutFile ?? null,
    layoutPageCount: Array.isArray(discovered.layout?.pdf_info) ? discovered.layout.pdf_info.length : null,
    layoutBackend: discovered.layout?._backend ?? null,
    layoutVersion: discovered.layout?._version_name ?? null,
    firstLayoutPageKeys: Array.isArray(discovered.layout?.pdf_info) && isRecord(discovered.layout.pdf_info[0])
      ? Object.keys(discovered.layout.pdf_info[0])
      : null,
    markdownFile: discovered.markdownFile ?? null,
    imageCount: discovered.imageFiles.length,
  }
  console.log(JSON.stringify(summary, null, 2))
  console.log('[probe] done. No token or signed URL was printed.')
} catch (error) {
  console.error(`[probe] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  if (args.keep !== true) await rm(temp, { recursive: true, force: true })
  else console.error(`[probe] kept temp dir: ${temp}`)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}
