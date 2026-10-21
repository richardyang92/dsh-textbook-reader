#!/usr/bin/env node
/**
 * Repair and regroup textbook-reader chat Sessions in the local DSH store.
 *
 * Two problems motivated this one-off migration:
 *
 *  1. Early builds called `agent.followup({ content, source })` without an
 *     `id`/`role`. DSH appends that object verbatim as a `user/message` event,
 *     and the Session loader then rejects the whole log with
 *     "lacks an identified message". We backfill the missing identity.
 *  2. Tutor Sessions were created in the profile directory, which is not a
 *     registered Workspace, so every book chat appeared under "未分组".
 *     We move those Session directories into the plugin's dedicated
 *     Workspace and update the stored header cwd.
 *
 * The script is deliberately conservative:
 *   - dry-run by default; pass --apply to write;
 *   - every rewritten log is backed up under <data root>/session-backups;
 *   - live Sessions (their session.lock is held by DSH) are skipped;
 *   - only Sessions that look like textbook-reader chats are touched.
 *
 * Usage:
 *   node scripts/migrate-chat-sessions.mjs
 *   node scripts/migrate-chat-sessions.mjs --apply
 *   node scripts/migrate-chat-sessions.mjs --apply --session session-xxxx
 *
 * Quit the DSH desktop app before --apply if you also want to move a Session
 * whose lock is currently held; otherwise that Session is repaired/left in
 * place and reported so the next run can move it.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const APPLY = process.argv.includes('--apply')
const FORCE_RETIRE = process.argv.includes('--force-retire')
const MOVE = !process.argv.includes('--no-move')
const REPAIR = !process.argv.includes('--no-repair')
const QUIET = process.argv.includes('--quiet')

const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const DATA_ROOT = process.env.TEXTBOOK_READER_DATA_DIR?.trim() || join(DSH_HOME, 'textbook-reader')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const WORKSPACE_DIR = join(DATA_ROOT, 'workspace')
const BACKUP_DIR = join(DATA_ROOT, 'session-backups')
const RETIRED_DIR = join(DATA_ROOT, 'session-retired')
const NOW = new Date().toISOString().replace(/[:.]/g, '-')

const MESSAGE_ROLES = new Map([
  ['user/message', 'user'],
  ['developer/message', 'developer'],
  ['system/message', 'system'],
  ['assistant/message', 'assistant'],
  ['tool/result', 'tool'],
])

const TUTOR_MARKERS = ['【教材伴读模式】', '<reading-context>', '[[tbr-primer]]']

function log(message) {
  if (!QUIET) console.log(message)
}

function warn(message) {
  if (!QUIET) console.warn(message)
}

function sessionFiles() {
  const out = []
  if (!existsSync(SESSIONS_ROOT)) return out
  for (const cwdDir of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!cwdDir.isDirectory()) continue
    const cwdPath = join(SESSIONS_ROOT, cwdDir.name)
    for (const sessionDir of readdirSync(cwdPath, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue
      const dir = join(cwdPath, sessionDir.name)
      const file = join(dir, 'session.v4.jsonl.zstd')
      if (existsSync(file)) out.push({ id: sessionDir.name, dir, file })
    }
  }
  return out
}

function zstdRead(file) {
  const result = spawnSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 })
  if (result.error) {
    throw new Error(`cannot run zstd (${result.error.message}); install zstd or add it to PATH`)
  }
  if (result.status !== 0) {
    throw new Error(`zstd -dc failed: ${String(result.stderr).trim()}`)
  }
  return result.stdout.toString('utf8')
}

function zstdWrite(jsonl) {
  const result = spawnSync('zstd', ['-q', '-c', '-3'], {
    input: Buffer.from(jsonl, 'utf8'),
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) {
    throw new Error(`cannot run zstd (${result.error.message}); install zstd or add it to PATH`)
  }
  if (result.status !== 0) {
    throw new Error(`zstd -c failed: ${String(result.stderr).trim()}`)
  }
  return result.stdout
}

function readSession(file) {
  const jsonl = zstdRead(file)
  const lines = jsonl.split('\n')
  if (lines.length > 0 && lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error('empty session log')
  const header = JSON.parse(lines[0])
  const events = lines.slice(1).map((line) => JSON.parse(line))
  return { header, events, lines }
}

function titleOf(events) {
  let title = ''
  for (const event of events) {
    if (event?.type === 'session/title' && typeof event?.data?.title === 'string') {
      title = event.data.title
    }
  }
  return title
}

function firstUserTextOf(events) {
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const content = event?.data?.content
    if (!Array.isArray(content)) continue
    const parts = []
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

function referencedSessionIds() {
  const ids = new Set()
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) ids.add(value.trim())
  }
  const books = join(DATA_ROOT, 'books')
  if (existsSync(books)) {
    for (const book of readdirSync(books, { withFileTypes: true })) {
      if (!book.isDirectory()) continue
      const ai = join(books, book.name, 'ai')
      for (const name of ['chat.json', 'history.json']) {
        const file = join(ai, name)
        if (!existsSync(file)) continue
        try {
          const record = JSON.parse(readFileSync(file, 'utf8'))
          if (name === 'chat.json') add(record?.sessionId)
          else if (Array.isArray(record?.sessions)) {
            for (const entry of record.sessions) add(entry?.sessionId)
          }
        } catch {
          // A broken plugin metadata file must not block Session repair.
        }
      }
    }
  }
  const tutor = join(DATA_ROOT, 'tutor-session.json')
  if (existsSync(tutor)) {
    try {
      add(JSON.parse(readFileSync(tutor, 'utf8'))?.sessionId)
    } catch {
      // Ignore.
    }
  }
  return ids
}

function optionSessionIds(flag) {
  const ids = new Set()
  const argv = process.argv
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && typeof argv[index + 1] === 'string') {
      ids.add(argv[index + 1])
      index += 1
    } else if (argv[index].startsWith(`${flag}=`)) {
      ids.add(argv[index].slice(flag.length + 1))
    }
  }
  return ids
}

function explicitSessionIds() {
  return optionSessionIds('--session')
}

function retireSessionIds() {
  return optionSessionIds('--retire')
}

function looksLikeTutorSession(session, referenced, explicit) {
  const { id } = session
  const header = session.header
  if (explicit.has(id)) return true
  if (referenced.has(id)) return true
  if (header?.agentPreset === 'textbook-tutor') return true
  const title = titleOf(session.events)
  if (title === '教材伴读导师' || title.startsWith('教材伴读 · ')) return true
  const first = firstUserTextOf(session.events).trimStart()
  return TUTOR_MARKERS.some((marker) => first.startsWith(marker))
}

/** Add the identity DSH requires to every message event that lacks it. */
function repairEvents(events) {
  let changed = 0
  const problems = []
  for (const event of events) {
    const expectedRole = MESSAGE_ROLES.get(event?.type)
    if (!expectedRole) continue
    const data = event.data
    if (!data || typeof data !== 'object') {
      problems.push(`seq ${event.seq} ${event.type} has no data object`)
      continue
    }
    const message = event.type === 'user/message' ? data : data.message
    if (!message || typeof message !== 'object') {
      problems.push(`seq ${event.seq} ${event.type} has no message object`)
      continue
    }
    if (typeof message.id !== 'string' || message.id === '') {
      message.id = randomUUID()
      changed += 1
    }
    if (message.role !== expectedRole) {
      message.role = expectedRole
      changed += 1
    }
    if (!message.source || typeof message.source !== 'object' || typeof message.source.kind !== 'string') {
      const kind = event.type === 'user/message' ? 'user' : event.type === 'system/message' ? 'system-prompt' : ''
      if (kind) {
        message.source = { kind }
        changed += 1
      } else {
        problems.push(`seq ${event.seq} ${event.type} has no repairable source`)
      }
    }
    if (!Array.isArray(message.content)) {
      problems.push(`seq ${event.seq} ${event.type} has no content array`)
    }
  }
  return { changed, problems }
}

function validateSession(session) {
  const errors = []
  const seenSeq = new Set()
  for (const event of session.events) {
    if (typeof event?.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) {
      errors.push('event with invalid seq')
      continue
    }
    if (seenSeq.has(event.seq)) errors.push(`duplicate seq ${event.seq}`)
    seenSeq.add(event.seq)
    const expectedRole = MESSAGE_ROLES.get(event.type)
    if (!expectedRole) continue
    const message = event.type === 'user/message' ? event.data : event.data?.message
    if (!message || typeof message !== 'object') errors.push(`seq ${event.seq} ${event.type} has no message`)
    else if (typeof message.id !== 'string' || message.id === '') errors.push(`seq ${event.seq} ${event.type} lacks id`)
    else if (message.role !== expectedRole) errors.push(`seq ${event.seq} ${event.type} has wrong role`)
    else if (!Array.isArray(message.content)) errors.push(`seq ${event.seq} ${event.type} has no content`)
  }
  return errors
}

function encodeCwd(cwd) {
  let out = '--'
  for (const ch of cwd.replace(/^\/+/, '')) {
    if (ch === '/') out += '-'
    else if (/[A-Za-z0-9._-]/.test(ch)) out += ch
    else out += `~${ch.charCodeAt(0).toString(16).toUpperCase()}`
  }
  return `${out}--`
}

function isLocked(lockFile) {
  if (!existsSync(lockFile)) return false
  const result = spawnSync('lsof', ['-t', lockFile], { encoding: 'utf8' })
  if (result.error) return undefined
  return typeof result.stdout === 'string' && result.stdout.trim().length > 0
}

function backup(file, id) {
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 })
  const target = join(BACKUP_DIR, `${id}.${NOW}.jsonl.zstd`)
  copyFileSync(file, target)
  return target
}

function writeLog(file, header, events) {
  const body = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join('\n')
  writeFileSync(file, zstdWrite(`${body}\n`), { mode: 0o600 })
  chmodSync(file, 0o600)
}

function main() {
  if (!existsSync(SESSIONS_ROOT)) {
    warn(`No DSH session directory at ${SESSIONS_ROOT}`)
    return 0
  }
  if (APPLY) mkdirSync(WORKSPACE_DIR, { recursive: true, mode: 0o700 })
  const workspace = existsSync(WORKSPACE_DIR) ? realpathSync(WORKSPACE_DIR) : WORKSPACE_DIR
  const referenced = referencedSessionIds()
  const explicit = explicitSessionIds()
  const retireIds = retireSessionIds()
  const rows = []

  for (const entry of sessionFiles()) {
    let session
    try {
      session = readSession(entry.file)
    } catch (error) {
      warn(`skip ${entry.id}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const tutor = looksLikeTutorSession({ ...session, id: entry.id, ...entry }, referenced, explicit)
    const repaired = REPAIR ? repairEvents(session.events) : { changed: 0, problems: [] }
    const malformed = validateSession({ header: session.header, events: session.events })
    const retire = retireIds.has(entry.id)
    const relevant = tutor || repaired.changed > 0 || malformed.length > 0 || retire
    if (!relevant) continue
    if (retire && referenced.has(entry.id) && !FORCE_RETIRE) {
      warn(`skip retire ${entry.id}: still referenced by plugin metadata (use --force-retire to override)`)
      continue
    }

    // Repair is safe even for an otherwise untouchable Session, but only move
    // one we identified as a textbook-reader chat.
    const shouldMove =
      !retire &&
      MOVE &&
      tutor &&
      typeof session.header.cwd === 'string' &&
      session.header.cwd !== workspace
    // Unknown lock state is treated as live: never rewrite a log another
    // process may be appending to.
    const willWrite = repaired.changed > 0 || shouldMove || retire
    const lockState = willWrite ? isLocked(join(entry.dir, 'session.lock')) : false
    const locked = lockState === true || lockState === undefined

    const row = {
      id: entry.id,
      dir: entry.dir,
      file: entry.file,
      title: titleOf(session.events) || '(no title)',
      cwd: session.header.cwd,
      tutor,
      repaired: repaired.changed,
      problems: repaired.problems,
      malformed,
      move: shouldMove,
      retire,
      locked,
      target: shouldMove ? join(SESSIONS_ROOT, encodeCwd(workspace), entry.id) : undefined,
      retireTarget: retire ? join(RETIRED_DIR, entry.id) : undefined,
    }
    rows.push(row)

    if (!APPLY) {
      printPlan(row, workspace)
      continue
    }

    let backupFile
    if (repaired.changed > 0 || shouldMove || retire) backupFile = backup(entry.file, entry.id)

    if (!locked) {
      if (retire) {
        writeRetired(row, session)
      } else if (repaired.changed > 0) {
        session.header = { ...session.header, cwd: shouldMove ? workspace : session.header.cwd }
        if (shouldMove) writeMoved(row, session, workspace)
        else writeLog(entry.file, session.header, session.events)
      } else if (shouldMove) {
        writeMoved(row, session, workspace)
      }
    }

    if (backupFile) row.backup = backupFile
    printPlan(row, workspace)
  }

  const changed = rows.filter(
    (row) =>
      (row.repaired > 0 && !row.locked) || (row.move && !row.locked) || (row.retire && !row.locked),
  )
  if (!APPLY) {
    log(`\nDry run: ${changed.length} of ${rows.length} textbook-reader Session(s) need changes.`)
    log('Run again with --apply to write. Backup files go to ' + BACKUP_DIR + '.')
  } else {
    log(`\nApplied: ${changed.length} of ${rows.length} textbook-reader Session(s) changed.`)
  }
  const blocked = rows.filter(
    (row) => row.locked && (row.repaired > 0 || row.move || row.retire),
  )
  if (blocked.length > 0) {
    log(`Live Session(s) skipped (quit DSH and rerun --apply to repair/move/retire them):`)
    for (const row of blocked) log(`  - ${row.id}  ${row.title}`)
  }
  const broken = rows.filter((row) => row.malformed.length > 0 || row.problems.length > 0)
  if (broken.length > 0) {
    log('Unrepaired problems:')
    for (const row of broken) {
      for (const problem of [...row.malformed, ...row.problems]) log(`  - ${row.id}: ${problem}`)
    }
  }
  return broken.length > 0 ? 1 : 0
}

function writeMoved(row, session, workspace) {
  if (existsSync(row.target)) {
    warn(`skip move ${row.id}: target already exists at ${row.target}`)
    return
  }
  const targetCwd = { ...session.header, cwd: workspace }
  mkdirSync(row.target, { recursive: true, mode: 0o700 })
  writeLog(join(row.target, 'session.v4.jsonl.zstd'), targetCwd, session.events)
  // Preserve any auxiliary files (the lock file is just an empty marker).
  for (const name of readdirSync(row.dir)) {
    if (name === 'session.v4.jsonl.zstd') continue
    try {
      copyFileSync(join(row.dir, name), join(row.target, name))
    } catch {
      // Best effort.
    }
  }
  rmSync(row.dir, { recursive: true, force: true })
  row.moved = true
}

function writeRetired(row, session) {
  if (existsSync(row.retireTarget)) {
    warn(`skip retire ${row.id}: target already exists at ${row.retireTarget}`)
    return
  }
  mkdirSync(row.retireTarget, { recursive: true, mode: 0o700 })
  writeLog(join(row.retireTarget, 'session.v4.jsonl.zstd'), session.header, session.events)
  for (const name of readdirSync(row.dir)) {
    if (name === 'session.v4.jsonl.zstd') continue
    try {
      copyFileSync(join(row.dir, name), join(row.retireTarget, name))
    } catch {
      // Best effort.
    }
  }
  rmSync(row.dir, { recursive: true, force: true })
  row.retired = true
}

function printPlan(row, workspace) {
  const actions = []
  if (row.repaired > 0) actions.push(`repair ${row.repaired} identity field(s)`)
  if (row.retire) {
    if (row.locked) actions.push('skip retire (live)')
    else if (row.retired) actions.push(`retired to ${row.retireTarget}`)
    else actions.push(`retire to ${row.retireTarget}`)
  } else if (row.move) {
    if (row.locked) actions.push('skip move (live)')
    else if (row.moved) actions.push('moved')
    else actions.push(`move to ${workspace}`)
  } else if (row.locked && row.repaired > 0) {
    actions.push('skip repair (live)')
  }
  if (row.problems.length > 0) actions.push(`${row.problems.length} unrepaired problem(s)`)
  log(
    `${row.id}\n  title: ${row.title}\n  cwd:   ${row.cwd}\n  action: ${
      actions.length > 0 ? actions.join('; ') : 'no change'
    }`,
  )
}

process.exitCode = main()
