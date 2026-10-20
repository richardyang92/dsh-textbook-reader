/** Filesystem primitives: private directories, atomic writes, safe reads. */

import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AppError } from '../errors.js'

/** Create a directory and pin its mode (best-effort on platforms without POSIX modes). */
export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode })
  try {
    await chmod(dir, mode)
  } catch {
    // Windows and some network filesystems do not implement POSIX modes.
  }
}

/**
 * Write a file atomically: a private temp file in the same directory, fsync,
 * rename over the target, then pin the final mode.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await ensureDir(dirname(file), 0o700)
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const handle = await open(tmp, 'wx', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  try {
    await chmod(file, mode)
  } catch {
    // Best effort; the write itself used the requested mode.
  }
}

/** JSON serialization for state files. */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/** Read a JSON state file; `undefined` only when it does not exist. */
export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw new AppError(500, 'state_unreadable', `状态文件不可读：${basename(file)}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AppError(500, 'state_corrupt', `状态文件损坏：${basename(file)}`)
  }
}

/** Read a small text state file; `undefined` only when it does not exist. */
export async function readTextFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw new AppError(500, 'state_unreadable', `状态文件不可读：${basename(file)}`)
  }
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }
}

/** Random stable-looking identifier with a short lowercase prefix. */
export function randomId(prefix: string, bytes = 6): string {
  return `${prefix}-${randomBytes(bytes).toString('hex')}`
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
