# Screenshots

These screenshots were refreshed on 2026-10-21 from the generated fixtures
(`scripts/seed-m2-demo.mjs` / `scripts/dev-server.mjs`) and an isolated DSH
profile. They contain no real textbook content, tokens, or personal workspace
names. The DSH shell sidebar is cropped out except in `m4-dsh-sidebar.png`,
where the account row is hidden.

M4 captures use the 0.6.0 split panel: reader on the left, per-book「AI 伴读」
chat on the right. The chapter tree and learning progress live in the reader's
「目录」 drawer when embedded; the standalone reader (M1–M3, M5) shows the tree
directly.

| File | Shows |
|---|---|
| `m1-library.png` / `m1-reader.png` | Library and an unparsed 5-page fixture in the reader |
| `m2-tree.png` | Parsed 30-page fixture with the generated chapter tree |
| `m3-reader.png` / `m3-highlight.png` | Reader with tree, learning progress and a bbox highlight |
| `m3-progress.png` | Mastery and question list at page 15 |
| `m4-chat-tools.png` | 「AI 伴读」 panel with collapsed tool calls and clickable `[p.N]` citations |
| `m4-citation-jump.png` | Citation click landing on the cited page with the source block highlighted |
| `m4-selection.png` | Selecting PDF text, the「问 AI」toolbar and the selection context chip |
| `m4-dsh-sidebar.png` | Sidebar entry, tutor workspace and the split reader/chat panel |
| `m5-420-pages.png` | 420-page fixture with 8 chapters / 32 sections |
| `m5-no-token.png` | Explicit `token_missing` degradation |
| `m5-dsh-latest.png` | Reader panel inside the DSH shell (library + empty tutor chat) |
