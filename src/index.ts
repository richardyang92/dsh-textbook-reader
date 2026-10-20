/**
 * dsh-textbook-reader — host half.
 *
 * The plugin stays lightweight at mount: it creates the on-disk stores and
 * registers the /textbook-reader prefix route once the web server service is
 * available. MinerU jobs, agent tools and the browser half arrive in later
 * milestones. Headless profiles without a web server simply keep the plugin
 * dormant instead of failing the composition.
 */

import type { Context } from '@deepseek-ai/cordis'
import { ConfigStore, dataPaths, type DataPaths } from './config.js'
import { BookStore } from './store/books.js'
import { ProgressStore } from './store/progress.js'
import { TreeStore } from './store/tree.js'
import { ParseManager, type MineruApi } from './mineru/job.js'
import { ReaderRouter, type ReaderLogger } from './http/router.js'

export const name = 'dsh-textbook-reader'

/** Optional services are resolved with ctx.inject; nothing is a hard dependency yet. */
export const inject: string[] = []

export interface ReaderRuntime {
  paths: DataPaths
  config: ConfigStore
  books: BookStore
  progress: ProgressStore
  tree: TreeStore
  parser: ParseManager
  router: ReaderRouter
}

interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
}

interface ConnectionLike {
  requestRejection?(req: import('node:http').IncomingMessage): number | false | undefined | null
}

/** Build the storage + HTTP runtime for one host context. Exported for tests. */
export function createReaderRuntime(options: {
  dataRoot?: string
  readerRoot?: string
  connection?: ConnectionLike
  mineruClient?: MineruApi
  logger?: ReaderLogger
} = {}): ReaderRuntime {
  const paths = dataPaths(options.dataRoot)
  const logger = options.logger
  const config = new ConfigStore(paths)
  const books = new BookStore(paths, {
    warn: (message) => {
      try {
        logger?.warn?.(message)
      } catch {
        // Diagnostics never affect storage.
      }
    },
  })
  const progress = new ProgressStore(paths)
  const tree = new TreeStore(paths)
  const parser = new ParseManager({
    paths,
    books,
    config,
    tree,
    ...(options.mineruClient ? { client: options.mineruClient } : {}),
    logger: {
      warn: (message) => {
        try {
          logger?.warn?.(message)
        } catch {
          // Diagnostics never affect parsing.
        }
      },
      error: (message) => {
        try {
          logger?.error?.(message)
        } catch {
          // Diagnostics never affect parsing.
        }
      },
    },
  })
  const router = new ReaderRouter({
    paths,
    config,
    books,
    progress,
    tree,
    parser,
    ...(options.readerRoot ? { readerRoot: options.readerRoot } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
    ...(logger ? { logger } : {}),
  })
  return { paths, config, books, progress, tree, parser, router }
}

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (scoped) => {
    const webServer = (scoped as unknown as { webServer?: WebServerLike }).webServer
    if (!webServer || typeof webServer.register !== 'function') return
    const connection = scoped.get?.('connection') as ConnectionLike | undefined
    const runtime = createReaderRuntime({
      ...(connection ? { connection } : {}),
      logger: {
        info: (message) => safeLog(ctx, 'info', message),
        warn: (message) => safeLog(ctx, 'warn', message),
        error: (message) => safeLog(ctx, 'error', message),
      },
    })
    let dispose: (() => void) | undefined
    try {
      dispose = webServer.register({
        kind: 'prefix',
        path: '/textbook-reader',
        handler: (req, res) => runtime.router.handle(req, res),
      })
    } catch (error) {
      safeLog(
        ctx,
        'error',
        `[dsh-textbook-reader] route registration failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    scoped.effect(() => () => {
      try {
        dispose?.()
      } catch {
        // Disposal is best effort; the host is already tearing down.
      }
      runtime.parser.dispose()
    })
    void runtime.parser.recover().catch((error: unknown) => {
      safeLog(
        ctx,
        'warn',
        `[dsh-textbook-reader] parse recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  })
}

function safeLog(ctx: Context, level: 'info' | 'warn' | 'error', message: string): void {
  try {
    const logger = ctx.logger as { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void } | undefined
    logger?.[level]?.(message)
  } catch {
    // Logging must never break plugin activation or a request.
  }
}
