/**
 * The `textbook-tutor` agent preset.
 *
 * A subagent created with this preset keeps the host-global `textbook_*` tools
 * (registered by this plugin) but does not mount the coding shell, filesystem,
 * or web tools. The persona carries the teaching contract; the delegation group
 * provides `send_message` so a spawned child can report back.
 */

import { TUTOR_GUIDANCE } from './prompt.js'

export const TUTOR_PRESET_ID = 'textbook-tutor'

export const TUTOR_PERSONA = `${TUTOR_GUIDANCE}
你只使用 textbook_* 工具核对教材；不要使用 shell、文件、网络或代码执行工具。
回答先给结论，再给依据；每个事实后给真实页码引用。`

/**
 * Build the registry declaration for the tutor preset. Rows are ordinary
 * agent-plane composition rows; the persona is the only prompt row, and the
 * delegation group supplies the parent/child messaging tool.
 */
export function tutorPresetDefinition(): Record<string, unknown> {
  return {
    id: TUTOR_PRESET_ID,
    name: '教材伴读导师',
    description: '教材精读导师：只使用教材工具，按页码引用，先导读再精读，不跑 shell。',
    order: 60,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: TUTOR_PERSONA },
      },
      {
        id: 'delegation',
        name: 'cordis:group',
        group: true,
        isolate: { workflowEngine: true },
        config: [
          {
            id: 'tool-subagent-control',
            name: '@deepseek-ai/dsh-tool-subagent-control',
          },
          {
            id: 'tool-subagent-list-agents',
            name: '@deepseek-ai/dsh-tool-subagent-control/list-agents',
          },
        ],
      },
    ],
  }
}

export interface AgentPresetRegistryLike {
  register(definition: unknown): Promise<undefined | (() => unknown)>
}

export interface PresetContextLike {
  get?(name: string): unknown
  logger?: { warn?: (message: string) => void }
}

/**
 * Declare the preset when this deployment has an agent-preset registry. The
 * lookup is not retried here: callers use `ctx.inject(['agentPresets'], ...)`,
 * which runs once the service exists. Every failure is non-fatal; the chat
 * backend falls back to the parent preset if activation cannot use this one.
 */
export function registerTutorPreset(ctx: PresetContextLike): () => void {
  const registry = resolveRegistry(ctx)
  if (!registry) return () => {}
  let disposed = false
  let release: (() => unknown) | undefined
  void Promise.resolve(registry.register(tutorPresetDefinition()))
    .then((next) => {
      if (disposed) {
        try {
          void Promise.resolve(next?.()).catch(() => {})
        } catch {
          // The registry is already tearing down.
        }
        return
      }
      release = next
    })
    .catch((error: unknown) => {
      ctx.logger?.warn?.(
        `[dsh-textbook-reader] tutor preset registration failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  return () => {
    disposed = true
    const dispose = release
    release = undefined
    try {
      void Promise.resolve(dispose?.()).catch(() => {})
    } catch {
      // Best effort during plugin teardown.
    }
  }
}

function resolveRegistry(ctx: PresetContextLike): AgentPresetRegistryLike | undefined {
  try {
    const value = ctx.get?.('agentPresets')
    if (!value || typeof value !== 'object') return undefined
    const register = (value as { register?: unknown }).register
    return typeof register === 'function' ? (value as AgentPresetRegistryLike) : undefined
  } catch {
    return undefined
  }
}
