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
import { BookChatService } from './chat/service.js'
import { SubagentChatBackend } from './chat/subagent-backend.js'
import { registerTutorPreset, TUTOR_PRESET_ID, type PresetContextLike } from './chat/tutor-preset.js'
import { registerTextbookTools, type ToolRegistryLike } from './tools/index.js'
import { TEXTBOOK_GUIDANCE } from './prompt.js'

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
  chat?: BookChatService
  /** Reader origin advertised to agent tools, filled when webServer is present. */
  baseUrl?: string
}

interface WebServerLike {
  readonly port?: number
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
  chat?: BookChatService
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
    ...(options.chat ? { chat: options.chat } : {}),
    ...(options.readerRoot ? { readerRoot: options.readerRoot } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
    ...(logger ? { logger } : {}),
  })
  return {
    paths,
    config,
    books,
    progress,
    tree,
    parser,
    router,
    ...(options.chat ? { chat: options.chat } : {}),
  }
}

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  const logger: ReaderLogger = {
    info: (message) => safeLog(ctx, 'info', message),
    warn: (message) => safeLog(ctx, 'warn', message),
    error: (message) => safeLog(ctx, 'error', message),
  }
  const runtime = createReaderRuntime({ logger })
  const chatBackend = new SubagentChatBackend({
    ctx,
    paths: runtime.paths,
    agentPreset: TUTOR_PRESET_ID,
    logger,
  })
  const chat = new BookChatService({
    paths: runtime.paths,
    backend: chatBackend,
    logger,
  })
  runtime.chat = chat
  runtime.router.attachChat(chat)
  ctx.inject(['agentPresets'], (scoped) => {
    const dispose = registerTutorPreset(scoped as unknown as PresetContextLike)
    scoped.effect(() => () => dispose())
  })
  // Register the dedicated tutor workspace as soon as DSH exposes it, so book
  // sessions are grouped under「教材伴读」instead of falling into 未分组.
  ctx.inject(['workspaceRegistry'], (scoped) => {
    void chatBackend.ensureWorkspace(scoped.get?.('workspaceRegistry'))
  })
  ctx.effect(() => () => {
    void chat.dispose()
  })
  ctx.effect(() => () => runtime.parser.dispose())
  void runtime.parser.recover().catch((error: unknown) => {
    safeLog(
      ctx,
      'warn',
      `[dsh-textbook-reader] parse recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  })

  ctx.inject(['webServer'], (scoped) => {
    const webServer = (scoped as unknown as { webServer?: WebServerLike }).webServer
    if (!webServer || typeof webServer.register !== 'function') return
    const connection = scoped.get?.('connection') as ConnectionLike | undefined
    runtime.router.attachConnection(connection)
    if (Number.isInteger(webServer.port) && (webServer.port ?? 0) > 0) {
      runtime.baseUrl = `http://127.0.0.1:${webServer.port}`
    }
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
    })
  })

  ctx.inject(['tools'], (scoped) => {
    const tools = (scoped as unknown as { tools?: ToolRegistryLike }).tools
    if (!tools || typeof tools.register !== 'function') return
    const dispose = registerTextbookTools(tools, {
      paths: runtime.paths,
      books: runtime.books,
      progress: runtime.progress,
      tree: runtime.tree,
      parser: runtime.parser,
      getReaderBaseUrl: () => runtime.baseUrl,
    })
    scoped.effect(() => () => dispose())
  })

  ctx.inject(['systemPrompt'], (scoped) => {
    const systemPrompt = (scoped as unknown as {
      systemPrompt?: { section?: (section: { name: string; order: number; text: string }) => () => void }
    }).systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    const dispose = systemPrompt.section({
      name: 'plugin:dsh-textbook-reader',
      order: 150,
      text: TEXTBOOK_GUIDANCE,
    })
    scoped.effect(() => () => dispose())
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
