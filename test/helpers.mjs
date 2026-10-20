import http from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { ConfigStore, dataPaths } from '../dist/config.js'
import { BookStore } from '../dist/store/books.js'
import { ProgressStore } from '../dist/store/progress.js'
import { TreeStore } from '../dist/store/tree.js'
import { ParseManager } from '../dist/mineru/job.js'
import { ReaderRouter } from '../dist/http/router.js'

export const appRoot = fileURLToPath(new URL('..', import.meta.url))

export async function makePdf(pages = 3) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= pages; index += 1) {
    const page = doc.addPage([420, 595])
    page.drawText(`Textbook test page ${index}`, { x: 48, y: 520, size: 18, font })
    page.drawText(`Paragraph for page ${index}.`, { x: 48, y: 470, size: 12, font })
  }
  return Buffer.from(await doc.save())
}

export async function createHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tbr-m1-'))
  const paths = dataPaths(root)
  const config = new ConfigStore(paths)
  const books = new BookStore(paths, { warn: options.warn })
  const progress = new ProgressStore(paths)
  const tree = new TreeStore(paths)
  if (options.token) await config.writeToken(options.token)
  const parser = options.mineruClient
    ? new ParseManager({
        paths,
        books,
        config,
        tree,
        client: options.mineruClient,
        pollIntervalMs: options.pollIntervalMs ?? 0,
        maxPollMs: options.maxPollMs ?? 5_000,
        sleep: () => Promise.resolve(),
      })
    : undefined
  const router = new ReaderRouter({
    paths,
    config,
    books,
    progress,
    tree,
    ...(parser ? { parser } : {}),
    readerRoot: join(appRoot, 'reader'),
    ...(options.maxUploadBytes ? { maxUploadBytes: options.maxUploadBytes } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
  })
  const server = http.createServer((req, res) => {
    router.handle(req, res).catch((error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}/textbook-reader`

  return {
    root,
    paths,
    config,
    books,
    progress,
    tree,
    parser,
    router,
    server,
    port,
    base,
    async writePdf(name = 'sample.pdf', pages = 3) {
      const file = join(root, name)
      const bytes = options.pdfBytes ?? (await makePdf(pages))
      await writeFile(file, bytes)
      return file
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function request(base, path, options = {}) {
  const response = await fetch(base + path, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  })
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { response, status: response.status, headers: response.headers, text, json }
}

export function rawRequest(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

export async function fileMode(file) {
  const info = await stat(file)
  return info.mode & 0o777
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}
