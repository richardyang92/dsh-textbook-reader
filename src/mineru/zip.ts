/**
 * Safe zip extraction for MinerU result archives.
 *
 * MinerU names are not a stable contract: the zip may contain a UUID-prefixed
 * content list, layout.json, full.md and an images directory. This module
 * extracts every safe entry and leaves discovery to the adaptive scanner.
 */

import { createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { openPromise, type Entry, type ZipFile } from 'yauzl'
import { AppError, unprocessable } from '../errors.js'
import { ensureDir } from '../store/atomic.js'

export interface ExtractLimits {
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1536 * 1024 * 1024,
}

export interface ExtractedZip {
  files: string[]
  bytes: number
}

export async function extractZip(
  zipPath: string,
  targetDir: string,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<ExtractedZip> {
  const magic = Buffer.alloc(4)
  try {
    const handle = await open(zipPath, 'r')
    try {
      await handle.read(magic, 0, 4, 0)
    } finally {
      await handle.close()
    }
  } catch {
    throw unprocessable('zip_invalid', '结果包不是有效 zip。')
  }
  if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
    throw unprocessable('zip_invalid', '结果包不是有效 zip。')
  }
  await rm(targetDir, { recursive: true, force: true })
  await ensureDir(targetDir, 0o700)

  let zip: ZipFile
  try {
    zip = await openPromise(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true })
  } catch {
    throw unprocessable('zip_invalid', '结果包无法打开，可能已损坏。')
  }

  const files: string[] = []
  let totalBytes = 0

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        try {
          zip.close()
        } catch {
          // Already closed.
        }
        rejectPromise(error)
      }

      zip.on('error', fail)
      zip.on('end', () => {
        if (settled) return
        settled = true
        resolvePromise()
      })
      zip.on('entry', (entry: Entry) => {
        void handleEntry(entry).catch(fail)
      })

      async function handleEntry(entry: Entry): Promise<void> {
        if (files.length >= limits.maxEntries) {
          throw unprocessable('zip_too_large', `结果包条目超过 ${limits.maxEntries} 个。`)
        }
        const name = entry.fileName
        const unsafe = unsafeEntryReason(name)
        if (unsafe) throw unprocessable('zip_unsafe', `结果包包含不安全路径（${unsafe}）。`)

        const mode = (entry.externalFileAttributes >>> 16) & 0xffff
        if ((mode & 0o170000) === 0o120000) {
          throw unprocessable('zip_unsafe', '结果包包含符号链接，已拒绝解压。')
        }

        if (name.endsWith('/')) {
          await ensureDir(join(targetDir, name), 0o700)
          zip.readEntry()
          return
        }

        if (entry.uncompressedSize > limits.maxEntryBytes) {
          throw unprocessable('zip_too_large', `结果包单文件超过 ${Math.floor(limits.maxEntryBytes / 1024 / 1024)} MB。`)
        }
        totalBytes += entry.uncompressedSize
        if (totalBytes > limits.maxTotalBytes) {
          throw unprocessable('zip_too_large', '结果包解压后超过允许的大小。')
        }

        const target = resolve(targetDir, name)
        if (!target.startsWith(`${targetDir}${sep}`)) {
          throw unprocessable('zip_unsafe', '结果包路径越界。')
        }
        await ensureDir(dirname(target), 0o700)

        const stream = await openEntry(zip, entry)
        await pipeline(stream, createWriteStream(target, { mode: 0o600, flags: 'wx' }))
        files.push(name)
        zip.readEntry()
      }

      zip.readEntry()
    })
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    if (error instanceof AppError) throw error
    throw new AppError(422, 'zip_invalid', '结果包解压失败。')
  }

  if (files.length === 0) throw unprocessable('zip_empty', '结果包为空。')
  return { files, bytes: totalBytes }
}

function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolvePromise, rejectPromise) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) rejectPromise(error)
      else resolvePromise(stream)
    })
  })
}

/** Reject absolute paths, drive letters, traversal segments and NUL bytes. */
export function unsafeEntryReason(name: string): string | undefined {
  if (typeof name !== 'string' || name.length === 0) return '空路径'
  if (name.includes('\0')) return '空字节'
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return '绝对路径'
  if (/^[A-Za-z]:/.test(normalized)) return '盘符路径'
  if (normalized.split('/').some((part) => part === '..')) return '路径穿越'
  return undefined
}
