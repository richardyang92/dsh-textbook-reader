/**
 * Build pipeline.
 *
 * M0 compiles the host half with the workspace TypeScript. Later milestones
 * append the browser bundle (lib/client.js) and the standalone reader app
 * (reader/app.js) here so `pnpm build` stays the single entry point.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  console.error('[build] typescript is not installed; run `pnpm install` first')
  process.exit(1)
}

execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
})

console.log('[build] host -> dist/')
