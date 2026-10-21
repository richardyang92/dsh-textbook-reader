# Contributing

Thanks for helping improve `dsh-textbook-reader`. This project is a DeepSeek Harness
plugin, so changes usually touch both the host half (`src/`) and the browser/reader
halves (`src/client/`, `src/reader/`, `reader/`).

## Development setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

- Node.js ≥ 22 and pnpm 11 are required.
- `pnpm test` rebuilds first and runs `node:test` sequentially.
- Generated artifacts (`dist/`, `lib/client*.js`, `reader/assets/app.js`, `reader/vendor/`)
  are ignored by git. Do not commit them.
- For UI work without installing the plugin, use the fixture server:

  ```bash
  node scripts/seed-m2-demo.mjs --data test/.tmp/demo --fresh
  node scripts/dev-server.mjs --data test/.tmp/demo --port 52000
  ```

  Open <http://127.0.0.1:52000/textbook-reader/>. The seeder uses fake MinerU data and
  makes no network requests.

## Before opening a PR

1. Keep changes focused; separate refactors from behavior changes.
2. Add or update a `test/*.test.mjs` case for behavior changes.
3. Run `pnpm typecheck` and `pnpm test` (both must pass).
4. If you touched the UI, include a screenshot or a short description in the PR.
5. Never include a real MinerU token, real textbook PDF, parsed artifacts, or session logs.
6. Follow the existing citation contract: use real `page` / `blockId` values from tool
   results, never invent page numbers.

## Commit style

Use short, imperative subject lines, optionally with a conventional prefix:

```text
feat: add segmented PDF parsing
fix: make block ids globally unique
docs: clarify token storage
test: cover private URL rejection
```

## Reporting bugs

Include the DSH version, Node/pnpm version, the failing command or UI step, and the
structured error code/message. Redact tokens, absolute personal paths, book contents,
and API responses that contain signed URLs.

For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
