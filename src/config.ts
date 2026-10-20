/**
 * Runtime configuration and the MinerU token.
 *
 * The token lives in its own 0600 file and never appears in config.json, API
 * responses, logs or error messages. `tokenStatus()` is the only read path the
 * HTTP layer may use when rendering the UI.
 */

import { chmod, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { MineruSettings, ReaderSettings, TokenStatus } from './types.js'
import { AppError, badRequest, unprocessable } from './errors.js'
import { ensureDir, readJsonFile, readTextFile, writeFileAtomic, writeJsonAtomic } from './store/atomic.js'

export interface DataPaths {
  root: string
  books: string
  tmp: string
  trash: string
  configFile: string
  tokenFile: string
  activeFile: string
}

export const SETTINGS_DEFAULTS: ReaderSettings = {
  mineru: {
    modelVersion: 'vlm',
    isOcr: true,
    enableTable: true,
    language: 'ch',
  },
  captionVlm: {
    enabled: false,
  },
}

/** Resolve `~/.dsh/textbook-reader`, honoring DSH_HOME and the test override. */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TEXTBOOK_READER_DATA_DIR?.trim()
  if (override) return resolve(override)
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'textbook-reader')
}

export function dataPaths(root = resolveDataRoot()): DataPaths {
  const absolute = resolve(root)
  return {
    root: absolute,
    books: join(absolute, 'books'),
    tmp: join(absolute, 'tmp'),
    trash: join(absolute, '.trash'),
    configFile: join(absolute, 'config.json'),
    tokenFile: join(absolute, 'mineru-token'),
    activeFile: join(absolute, 'active.json'),
  }
}

export interface SettingsPatch {
  mineru?: Partial<MineruSettings>
  captionVlm?: Partial<{ enabled: boolean }>
}

export class ConfigStore {
  readonly paths: DataPaths

  constructor(paths: DataPaths = dataPaths()) {
    this.paths = paths
  }

  async ensure(): Promise<void> {
    await ensureDir(this.paths.root, 0o700)
    await ensureDir(this.paths.books, 0o700)
    await ensureDir(this.paths.tmp, 0o700)
  }

  async readSettings(): Promise<ReaderSettings> {
    await this.ensure()
    const stored = await readJsonFile<unknown>(this.paths.configFile)
    if (stored === undefined) return structuredClone(SETTINGS_DEFAULTS)
    return normalizeSettings(stored)
  }

  async updateSettings(patch: SettingsPatch): Promise<ReaderSettings> {
    const current = await this.readSettings()
    const next = normalizeSettings({
      ...current,
      mineru: { ...current.mineru, ...(patch.mineru ?? {}) },
      captionVlm: { ...current.captionVlm, ...(patch.captionVlm ?? {}) },
    })
    await this.ensure()
    await writeJsonAtomic(this.paths.configFile, next, 0o600)
    return next
  }

  /** Read the raw token for an outbound request; throws an actionable error when absent. */
  async requireToken(): Promise<string> {
    const token = await this.readToken()
    if (!token) {
      throw new AppError(
        409,
        'token_missing',
        '尚未配置 MinerU token。',
        '打开「教材伴读」→ 设置，填入 mineru.net 的 API token（只保存到本机 0600 文件）。',
      )
    }
    return token
  }

  async readToken(): Promise<string | undefined> {
    const text = await readTextFile(this.paths.tokenFile)
    if (text === undefined) return undefined
    const token = text.trim()
    if (!token) return undefined
    // Repair permissive modes written by an older version or a manual copy.
    try {
      const info = await stat(this.paths.tokenFile)
      if ((info.mode & 0o077) !== 0) await chmod(this.paths.tokenFile, 0o600)
    } catch {
      // The read already succeeded; mode repair is best effort.
    }
    return token
  }

  async writeToken(raw: string): Promise<TokenStatus> {
    const token = validateToken(raw)
    await this.ensure()
    await writeFileAtomic(this.paths.tokenFile, `${token}\n`, 0o600)
    return this.tokenStatus()
  }

  async clearToken(): Promise<TokenStatus> {
    await rm(this.paths.tokenFile, { force: true })
    return this.tokenStatus()
  }

  async tokenStatus(): Promise<TokenStatus> {
    const token = await this.readToken()
    if (!token) return { configured: false, mask: '' }
    let updatedAt: string | undefined
    try {
      updatedAt = (await stat(this.paths.tokenFile)).mtime.toISOString()
    } catch {
      // The token was read; a missing mtime is not a failure.
    }
    return {
      configured: true,
      mask: maskToken(token),
      ...(updatedAt ? { updatedAt } : {}),
    }
  }
}

/** Interface mask: never reveal the token's start, only its last four characters. */
export function maskToken(token: string): string {
  const trimmed = token.trim()
  if (trimmed.length <= 4) return '••••'
  return `••••${trimmed.slice(-4)}`
}

export function validateToken(raw: string): string {
  if (typeof raw !== 'string') throw badRequest('token 必须是字符串')
  const token = raw.trim()
  if (token.length < 8) throw unprocessable('token_invalid', 'token 太短，请粘贴完整 token。')
  if (token.length > 4096) throw unprocessable('token_invalid', 'token 过长。')
  if (/[\u0000-\u001f\u007f\s]/.test(token)) {
    throw unprocessable('token_invalid', 'token 不能包含空白或控制字符。')
  }
  return token
}

/** Remove a token and Authorization headers from any text before logging. */
export function redactSecrets(text: unknown, token?: string): string {
  let value = typeof text === 'string' ? text : String(text)
  if (token) value = value.split(token).join('[REDACTED]')
  value = value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  value = value.replace(/(authorization\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  return value
}

export function normalizeSettings(value: unknown): ReaderSettings {
  const record = isRecord(value) ? value : {}
  const mineru = isRecord(record.mineru) ? record.mineru : {}
  const caption = isRecord(record.captionVlm) ? record.captionVlm : {}

  const modelVersion = 'vlm' as const
  const isOcr = typeof mineru.isOcr === 'boolean' ? mineru.isOcr : SETTINGS_DEFAULTS.mineru.isOcr
  const enableTable =
    typeof mineru.enableTable === 'boolean' ? mineru.enableTable : SETTINGS_DEFAULTS.mineru.enableTable
  const language =
    typeof mineru.language === 'string' && /^[a-z][a-z0-9_-]{1,31}$/i.test(mineru.language.trim())
      ? mineru.language.trim()
      : SETTINGS_DEFAULTS.mineru.language

  return {
    mineru: { modelVersion, isOcr, enableTable, language },
    captionVlm: {
      enabled:
        typeof caption.enabled === 'boolean' ? caption.enabled : SETTINGS_DEFAULTS.captionVlm.enabled,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
