/**
 * Build the DSH browser half.
 *
 * esbuild produces a CJS module whose only external is React (a platform seed).
 * The wrapper registers it with the DSH client module loader and returns the
 * module exports (named `inject` and `apply`) as the plugin body.
 */

import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildClient() {
  const outDir = join(root, 'lib')
  const temp = join(outDir, '.client.bundle.cjs')
  await mkdir(outDir, { recursive: true })
  await build({
    entryPoints: [join(root, 'src', 'client', 'index.tsx')],
    outfile: temp,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    external: ['react'],
    jsx: 'automatic',
    logLevel: 'warning',
    legalComments: 'none',
  })
  const code = await readFile(temp, 'utf8')
  const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-textbook-reader",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    (function (module, exports, require) {
${code}
    })(module, exports, require);
    return module.exports;
  }
});
`
  await writeFile(join(outDir, 'client.js'), wrapped, 'utf8')
  await rm(temp, { force: true })
  console.log('[build] browser half -> lib/client.js')
}
