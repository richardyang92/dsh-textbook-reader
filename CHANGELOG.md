# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-10-21

First public release.

### Added

- PDF textbook library with upload, path import, SHA-256 deduplication and Range streaming.
- MinerU v4 parsing (`model_version=vlm`) with adaptive zip discovery and normalized blocks.
- Auto-generated book → chapter → section tree with rename, merge and relevel operations.
- Bundled pdf.js reader with lazy page rendering, chapter navigation and bbox highlights.
- Page-anchored `[p.N]` citations with click-to-jump and source-block highlight.
- Selectable text overlay for parsed PDFs, including scanned books without a text layer.
- Learning progress: current page, read chapters, per-chapter mastery and question list.
- Per-book DSH chat sessions in a dedicated workspace, plus seven `textbook_*` agent tools.
- Collapsible tool-call summaries persisted with chat history.
- Local segmentation for books over MinerU's 200-page task limit, with automatic re-splitting.
- Structured failure codes for missing token, network, timeout, bad zip and MinerU errors.
- SSRF-safe result downloads, private token storage (`0600`) and masked token responses.
- Fixture server, demo seeder and a MinerU probe script for offline development.

### Known limitations

- PDF only; no EPUB, multi-book comparison, auto-grading or full-book translation.
- Real MinerU cloud response calibration is still performed with `pnpm probe:mineru`;
  the repository ships a synthetic 420-page fixture for tree, segmentation and citation tests.
- Caption VLM stays disabled and has no outbound implementation.
