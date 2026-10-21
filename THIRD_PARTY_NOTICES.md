# Third-Party Notices

`dsh-textbook-reader` is distributed under the MIT License (see [LICENSE](LICENSE)).
The reader bundles the following third-party components. Their license texts are
copied into `reader/vendor/` by `pnpm build` and are shipped with the built reader.
The paths below refer to that build output; a fresh source checkout does not
contain `reader/vendor/` until it is built.

## PDF.js

- Component: `pdfjs-dist` (PDF.js), bundled at `reader/vendor/pdf.min.mjs`,
  `reader/vendor/pdf.worker.min.mjs`, `reader/vendor/cmaps/`,
  `reader/vendor/standard_fonts/`, and `reader/vendor/wasm/`.
- License: Apache License 2.0.
- License text: [`reader/vendor/pdfjs.LICENSE`](reader/vendor/pdfjs.LICENSE),
  [`reader/vendor/cmaps/LICENSE`](reader/vendor/cmaps/LICENSE).
- Project: <https://github.com/mozilla/pdf.js>

Bundled PDF.js optional components carry their own license files:

| Component | License file |
|---|---|
| JBIG2 decoder | `reader/vendor/wasm/LICENSE_JBIG2`, `LICENSE_PDFJS_JBIG2` |
| OpenJPEG / JPEG 2000 | `reader/vendor/wasm/LICENSE_OPENJPEG`, `LICENSE_PDFJS_OPENJPEG` |
| QCMS color management | `reader/vendor/wasm/LICENSE_QCMS`, `LICENSE_PDFJS_QCMS` |
| Liberation fonts | `reader/vendor/standard_fonts/LICENSE_LIBERATION` |
| Foxit fonts | `reader/vendor/standard_fonts/LICENSE_FOXIT` |

## Runtime dependencies

The host half depends on `pdf-lib` (MIT) and `yauzl` (MIT); development dependencies
include `pdfjs-dist` (Apache-2.0), `esbuild` (MIT), `typescript` (Apache-2.0), and
`yazl` (MIT). See `pnpm-lock.yaml` and the packages' own license files for details.

## DeepSeek Harness

The plugin integrates with DeepSeek Harness and its client packages. Those packages
are not redistributed here; install them through DSH and refer to their licenses.
