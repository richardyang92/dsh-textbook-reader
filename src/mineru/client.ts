/**
 * MinerU cloud API v4 client.
 *
 * Only this module talks to the network. It never logs URLs or tokens, and it
 * maps every failure to an actionable AppError instead of leaking a raw
 * response body. The caller supplies the token per request; this class does no
 * credential caching.
 */

import { open, readFile, rm, stat } from 'node:fs/promises'
import { AppError, tooLarge, unprocessable } from '../errors.js'
import { redactSecrets } from '../config.js'
import { MAX_PDF_BYTES } from '../pdf.js'

const DEFAULT_BASE_URL = 'https://mineru.net/api/v4'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024

export type MineruState = 'waiting-file' | 'pending' | 'running' | 'converting' | 'done' | 'failed' | string

export interface UploadRequest {
  fileName: string
  dataId: string
  isOcr: boolean
  enableTable: boolean
  language: string
  pageRanges?: string
}

export interface UploadTicket {
  batchId: string
  fileUrls: string[]
}

export interface BatchFile {
  fileName?: string
  dataId?: string
  state: MineruState
  fullZipUrl?: string
  errMsg?: string
  extractedPages?: number
  totalPages?: number
}

export interface BatchStatus {
  batchId: string
  files: BatchFile[]
}

export interface MineruClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  downloadMaxBytes?: number
}

export class MineruClient {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly downloadMaxBytes: number

  constructor(options: MineruClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.TEXTBOOK_MINERU_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.downloadMaxBytes = options.downloadMaxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES
  }

  /** Ask MinerU for a signed OSS upload URL and auto-created extract task. */
  async requestUpload(token: string, request: UploadRequest): Promise<UploadTicket> {
    if (!/\.pdf$/i.test(request.fileName)) {
      throw unprocessable('pdf_invalid', 'MinerU 只接收 .pdf 文件名。')
    }
    const body = {
      files: [
        {
          name: request.fileName,
          data_id: request.dataId,
          is_ocr: request.isOcr,
          ...(request.pageRanges ? { page_ranges: request.pageRanges } : {}),
        },
      ],
      model_version: 'vlm',
      enable_table: request.enableTable,
      language: request.language,
    }
    const data = await this.requestJson('/file-urls/batch', {
      method: 'POST',
      token,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
    const batchId = stringAt(data, 'batch_id')
    const fileUrls = arrayAt(data, 'file_urls').filter((item): item is string => typeof item === 'string')
    if (!batchId || fileUrls.length === 0) {
      throw apiError('mineru_response_invalid', 'MinerU 没有返回上传地址。')
    }
    return { batchId, fileUrls }
  }

  /** PUT the PDF to the signed URL. Deliberately never sets Content-Type. */
  async uploadFile(url: string, filePath: string): Promise<void> {
    assertSafeRemoteUrl(url)
    let info
    try {
      info = await stat(filePath)
    } catch {
      throw new AppError(404, 'pdf_missing', 'PDF 文件不存在。')
    }
    if (info.size > MAX_PDF_BYTES) throw tooLarge('PDF 超过 200 MB 上限。')
    let buffer: Buffer
    try {
      buffer = await readFile(filePath)
    } catch {
      throw new AppError(500, 'pdf_unreadable', '无法读取 PDF 文件。')
    }
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'PUT',
        body: buffer,
        headers: { 'content-length': String(buffer.byteLength) },
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
      })
    } catch (error) {
      throw networkError(error)
    }
    if (response.status !== 200 && response.status !== 201) {
      throw apiError('mineru_upload_failed', `MinerU 上传失败（HTTP ${response.status}）。`)
    }
  }

  /** Poll one batch. GET calls are idempotent, so transient failures can be retried by the caller. */
  async getBatch(token: string, batchId: string): Promise<BatchStatus> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) {
      throw new AppError(400, 'invalid_batch_id', 'batch_id 不合法。')
    }
    const data = await this.requestJson(`/extract-results/batch/${encodeURIComponent(batchId)}`, {
      method: 'GET',
      token,
    })
    const rawFiles = arrayAt(data, 'extract_result')
    const files: BatchFile[] = []
    for (const raw of rawFiles) {
      if (!isRecord(raw)) continue
      const state = typeof raw.state === 'string' ? raw.state : 'failed'
      const progress = isRecord(raw.extract_progress) ? raw.extract_progress : undefined
      files.push({
        ...(typeof raw.file_name === 'string' ? { fileName: raw.file_name } : {}),
        ...(typeof raw.data_id === 'string' ? { dataId: raw.data_id } : {}),
        state,
        ...(typeof raw.full_zip_url === 'string' && raw.full_zip_url ? { fullZipUrl: raw.full_zip_url } : {}),
        ...(typeof raw.err_msg === 'string' && raw.err_msg ? { errMsg: redactSecrets(raw.err_msg) } : {}),
        ...(progress && Number.isFinite(Number(progress.extracted_pages))
          ? { extractedPages: Number(progress.extracted_pages) }
          : {}),
        ...(progress && Number.isFinite(Number(progress.total_pages))
          ? { totalPages: Number(progress.total_pages) }
          : {}),
      })
    }
    if (files.length === 0) {
      throw apiError('mineru_response_invalid', 'MinerU 返回了空的任务列表。')
    }
    return { batchId, files }
  }

  /** Download a result zip to a private file with a size cap. */
  async downloadZip(url: string, target: string): Promise<void> {
    assertSafeRemoteUrl(url)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 300_000)),
      })
    } catch (error) {
      throw networkError(error)
    }
    if (response.status !== 200) {
      throw apiError('mineru_download_failed', `MinerU 结果下载失败（HTTP ${response.status}）。`)
    }
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > this.downloadMaxBytes) {
      throw tooLarge('MinerU 结果包超过允许的大小。')
    }
    if (!response.body) throw apiError('mineru_download_failed', 'MinerU 结果下载为空。')

    const handle = await open(target, 'wx', 0o600)
    let size = 0
    let head = Buffer.alloc(0)
    try {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        size += value.byteLength
        if (size > this.downloadMaxBytes) throw tooLarge('MinerU 结果包超过允许的大小。')
        if (head.byteLength < 4) head = Buffer.concat([head, Buffer.from(value.subarray(0, 4 - head.byteLength))])
        await handle.write(value)
      }
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => {})
      await rm(target, { force: true }).catch(() => {})
      throw error
    }
    await handle.close()
    if (head.byteLength < 4 || head[0] !== 0x50 || head[1] !== 0x4b) {
      await rm(target, { force: true }).catch(() => {})
      throw apiError('mineru_zip_invalid', 'MinerU 返回的结果不是 zip 文件。')
    }
  }

  private async requestJson(
    path: string,
    options: { method: 'GET' | 'POST'; token: string; body?: string; headers?: Record<string, string> },
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: options.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
          ...(options.headers ?? {}),
        },
        ...(options.body !== undefined ? { body: options.body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw networkError(error)
    }
    const text = await response.text().catch(() => '')
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) : undefined
    } catch {
      payload = undefined
    }
    if (!isRecord(payload)) {
      throw apiError('mineru_response_invalid', `MinerU 返回了非 JSON 响应（HTTP ${response.status}）。`)
    }
    const code = payload.code
    const message = typeof payload.msg === 'string' ? redactSecrets(payload.msg, options.token) : ''
    if (response.status === 401 || response.status === 403 || code === 'A0202' || code === 'A0211') {
      throw new AppError(
        502,
        'mineru_token_invalid',
        `MinerU token 无效或已过期${message ? `：${truncate(message, 240)}` : '。'}`,
        '打开「教材伴读」→ 设置，重新填入 mineru.net 的 API token。',
      )
    }
    if (code !== 0 && code !== '0') {
      throw mapApiCode(code, message)
    }
    const data = isRecord(payload.data) ? payload.data : undefined
    if (!data) throw apiError('mineru_response_invalid', 'MinerU 响应缺少 data。')
    return data
  }
}

function mapApiCode(code: unknown, message: string): AppError {
  const numeric = typeof code === 'number' ? code : Number(code)
  const suffix = message ? `：${truncate(message, 300)}` : ''
  if (numeric === -60005) return tooLarge('MinerU 拒绝：文件超过 200 MB。')
  if (numeric === -60006) {
    return new AppError(422, 'mineru_page_limit', `MinerU 拒绝：文件超过 600 页${suffix}。`, 'M5 会支持本地分段；当前请先拆分 PDF。')
  }
  if (numeric === -60003 || numeric === -60004 || numeric === -60002) {
    return unprocessable('mineru_pdf_invalid', `MinerU 无法读取该 PDF${suffix}。`)
  }
  if (numeric === -60018) {
    return new AppError(429, 'mineru_quota_exhausted', `MinerU 今日额度已用尽${suffix}。`, '明天再试，或在 mineru.net 查看额度。')
  }
  return apiError('mineru_api_error', `MinerU 请求失败（${String(code)}）${suffix}`)
}

function assertSafeRemoteUrl(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw apiError('mineru_url_invalid', 'MinerU 返回了不合法的文件地址。')
  }
  if (url.protocol !== 'https:') {
    throw apiError('mineru_url_invalid', 'MinerU 文件地址必须是 https。')
  }
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') {
    throw apiError('mineru_url_invalid', 'MinerU 文件地址指向本机，已拒绝。')
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    throw apiError('mineru_url_invalid', 'MinerU 文件地址指向私有网络，已拒绝。')
  }
  const private172 = /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  if (private172) throw apiError('mineru_url_invalid', 'MinerU 文件地址指向私有网络，已拒绝。')
}

function networkError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/abort|timeout/i.test(message)) {
    return new AppError(504, 'mineru_timeout', '连接 MinerU 超时。', '检查网络或代理后重试。')
  }
  return new AppError(502, 'mineru_unreachable', '无法连接 MinerU。', '检查网络或代理后重试。')
}

function apiError(code: string, message: string): AppError {
  return new AppError(502, code, message)
}

function stringAt(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? (value[key] as string) : ''
}

function arrayAt(value: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(value[key]) ? (value[key] as unknown[]) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}
