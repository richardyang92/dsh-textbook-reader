/**
 * Browser trust fence for /textbook-reader routes.
 *
 * The host connection service, when present, owns authentication and
 * DNS-rebinding checks. This fence adds a fail-closed local check for
 * compositions where that service is absent, and rejects cross-site writes
 * even when a valid session cookie exists.
 */

import type { IncomingMessage } from 'node:http'

export interface ConnectionFence {
  requestRejection?(request: IncomingMessage): number | false | undefined | null
}

export interface GuardOptions {
  connection?: ConnectionFence
  /** Extra authorities accepted for reads, e.g. `host:port,other-host`. */
  trustedHosts?: readonly string[]
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Returns an HTTP status to reject with, or null to allow. */
export function createRequestGuard(options: GuardOptions = {}): (req: IncomingMessage) => number | null {
  const trusted = new Set(
    (options.trustedHosts ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )

  return (req: IncomingMessage): number | null => {
    try {
      const headers = req.headers
      let hostUrl: URL
      try {
        hostUrl = new URL(`http://${String(headers.host ?? '')}`)
      } catch {
        return 403
      }
      const hostname = hostUrl.hostname.toLowerCase()
      const authority = hostUrl.host.toLowerCase()
      const loopback = isLoopbackHostname(hostname)
      if (!loopback && !trusted.has(authority) && !trusted.has(hostname)) return 403

      const method = String(req.method ?? 'GET').toUpperCase()
      if (WRITE_METHODS.has(method) && !loopback) return 403

      if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403

      const origin = headers.origin
      if (typeof origin === 'string' && origin && origin !== 'null') {
        let originUrl: URL
        try {
          originUrl = new URL(origin)
        } catch {
          return 403
        }
        if (originUrl.host.toLowerCase() !== authority) return 403
      }

      const connection = options.connection
      if (connection && typeof connection.requestRejection === 'function') {
        let rejection: number | false | undefined | null
        try {
          rejection = connection.requestRejection(req)
        } catch {
          return 403
        }
        if (typeof rejection === 'number') return rejection
      }
      return null
    } catch {
      return 403
    }
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (value === 'localhost' || value.endsWith('.localhost')) return true
  if (value === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!match) return false
  return match[1] === '127' && [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
}
