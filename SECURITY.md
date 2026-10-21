# Security Policy

## Supported versions

The `main` branch and the latest tagged release receive security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a suspected vulnerability. Use GitHub's
private vulnerability reporting:

<https://github.com/richardyang92/dsh-textbook-reader/security/advisories/new>

Include:

- affected version/commit and DSH version;
- a minimal reproduction or request sequence;
- impact and any preconditions;
- whether the issue involves the MinerU token, local files, SSRF, path traversal,
  cross-site requests, or the reader iframe bridge.

Please allow a reasonable window for a fix before public disclosure.

## Sensitive data

This plugin handles two kinds of sensitive data:

1. **MinerU API token** — stored at `~/.dsh/textbook-reader/mineru-token` with mode `0600`.
   The token is never returned by the API, never written to logs, and must never be
   included in bug reports or screenshots.
2. **Textbook contents and parsed artifacts** — stored under
   `~/.dsh/textbook-reader/`. Do not attach real books, page text, parsed images, or
   session logs to public issues without the rights holder's permission.

## Built-in protections

- The token endpoint returns only a masked value (last four characters).
- Parsed-result downloads and uploads reject non-HTTPS URLs, localhost, and private
  network addresses to reduce SSRF risk.
- Static asset and parsed-image routes validate paths against traversal.
- JSON write routes reject cross-site and non-loopback requests.
- The caption VLM path is disabled by default and makes no extra outbound requests.
