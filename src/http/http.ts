/** HTTP primitives shared by the reader routes: responses, bodies, files, ranges. */

import { createReadStream } from 'node:fs'
import { open, stat, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import { AppError, badRequest, isAppError, tooLarge } from '../errors.js'

export interface RangeSelection {
  start: number
  end: number
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export function setBaseHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, cacheControl = 'no-store'): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(body.byteLength))
  res.setHeader('Cache-Control', cacheControl)
  res.end(body)
}

export function sendHtml(res: ServerResponse, html: string, status = 200): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = Buffer.from(html, 'utf8')
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Length', String(body.byteLength))
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

export function sendError(res: ServerResponse, error: unknown): void {
  const app = isAppError(error)
    ? error
    : new AppError(500, 'internal_error', '服务器内部错误。')
  sendJson(res, app.status, {
    ok: false,
    error: {
      code: app.code,
      message: app.message,
      ...(app.hint ? { hint: app.hint } : {}),
    },
  })
}

export async function readJsonBody(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) {
      req.resume()
      throw tooLarge(`请求体超过 ${Math.floor(limit / 1024 / 1024 || 1)} MB 上限。`)
    }
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('请求体不是合法 JSON。', 'invalid_json')
  }
}

/**
 * Stream a request body into a private file. Returns the byte count.
 * On overflow or write failure the partial file is removed.
 */
export async function streamBodyToFile(
  req: IncomingMessage,
  target: string,
  limit: number,
): Promise<number> {
  const handle = await open(target, 'wx', 0o600)
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > limit) {
        req.resume()
        throw tooLarge(`文件超过 ${Math.floor(limit / 1024 / 1024)} MB 上限。`)
      }
      await handle.write(buffer)
    }
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(target).catch(() => {})
    throw error
  }
  await handle.close()
  return size
}

/** Parse a single `bytes=` range; null when unbounded, throws 416 on malformed/multi-range. */
export function parseRange(header: string | undefined, size: number): RangeSelection | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) throw new AppError(416, 'invalid_range', '不支持的 Range 请求。')
  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') throw new AppError(416, 'invalid_range', 'Range 为空。')
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new AppError(416, 'invalid_range', 'Range 不合法。')
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new AppError(416, 'invalid_range', 'Range 超出文件范围。')
  }
  return { start, end: Math.min(end, size - 1) }
}

export interface ServeFileOptions {
  contentType?: string
  cacheControl?: string
  /** Optional attachment filename; absent means inline. */
  downloadName?: string
}

/** Serve one file with optional single-range support. */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  options: ServeFileOptions = {},
): Promise<void> {
  let info
  try {
    info = await stat(file)
  } catch {
    throw new AppError(404, 'not_found', '文件不存在。')
  }
  if (!info.isFile()) throw new AppError(404, 'not_found', '文件不存在。')

  const contentType = options.contentType ?? mimeType(file)
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined
  const range = parseRange(rangeHeader, info.size)

  res.setHeader('Content-Type', contentType)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', options.cacheControl ?? 'private, max-age=0, must-revalidate')
  if (options.downloadName) {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeHeaderFilename(options.downloadName)}"`)
  }

  if (range) {
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
    res.setHeader('Content-Length', String(range.end - range.start + 1))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await pipeFile(res, file, range)
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Length', String(info.size))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await pipeFile(res, file, null)
}

function pipeFile(res: ServerResponse, file: string, range: RangeSelection | null): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(file, range ? { start: range.start, end: range.end } : undefined)
    stream.on('error', (error) => {
      if (!res.headersSent) reject(error)
      else res.destroy(error)
    })
    stream.on('end', () => resolvePromise())
    stream.pipe(res)
  })
}

/** Resolve a URL path under a static root, rejecting traversal and absolute targets. */
export function resolveStaticPath(root: string, pathname: string): string {
  const decoded = decodeURIComponent(pathname)
  if (decoded.includes('\0')) throw new AppError(400, 'bad_path', '路径不合法。')
  const candidate = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`)
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw new AppError(403, 'forbidden_path', '拒绝访问该路径。')
  }
  if (!isAbsolute(candidate)) throw new AppError(400, 'bad_path', '路径不合法。')
  return candidate
}

export function mimeType(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function encodeHeaderFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '_').slice(0, 120)
}

export { MIME }
