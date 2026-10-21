/**
 * Build the standalone reader page.
 *
 * - src/reader/main.ts -> reader/assets/app.js (ESM, bundled)
 * - pdfjs-dist browser build -> reader/vendor/ (with cmaps + standard fonts)
 *
 * The reader loads pdf.js with a runtime dynamic import so it stays out of the
 * app bundle and can be served as a static asset by the host route.
 */

import { build } from 'esbuild'
import { copyFile, cp, mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildReader() {
  await mkdir(join(root, 'reader', 'assets'), { recursive: true })
  await build({
    entryPoints: [join(root, 'src', 'reader', 'main.ts')],
    outfile: join(root, 'reader', 'assets', 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: true,
    logLevel: 'info',
    legalComments: 'none',
  })

  let pdfjsRoot
  try {
    const require = createRequire(import.meta.url)
    pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))
  } catch {
    throw new Error('[build-reader] pdfjs-dist is not installed; run `pnpm install`')
  }

  const vendor = join(root, 'reader', 'vendor')
  await mkdir(vendor, { recursive: true })
  await copyFile(join(pdfjsRoot, 'build', 'pdf.min.mjs'), join(vendor, 'pdf.min.mjs'))
  await copyFile(join(pdfjsRoot, 'build', 'pdf.worker.min.mjs'), join(vendor, 'pdf.worker.min.mjs'))
  await copyFile(join(pdfjsRoot, 'LICENSE'), join(vendor, 'pdfjs.LICENSE'))
  await cp(join(pdfjsRoot, 'cmaps'), join(vendor, 'cmaps'), { recursive: true })
  await cp(join(pdfjsRoot, 'standard_fonts'), join(vendor, 'standard_fonts'), { recursive: true })
  // pdf.js decodes JPX/JBIG2/ICC in WebAssembly. Scanned textbooks encoded with
  // JPXDecode (very common) render blank white pages without these files.
  await cp(join(pdfjsRoot, 'wasm'), join(vendor, 'wasm'), { recursive: true })

  const info = await stat(join(vendor, 'pdf.min.mjs'))
  console.log(`[build] reader -> reader/assets/app.js; pdf.js vendor ${Math.round(info.size / 1024)} KB`)
}
