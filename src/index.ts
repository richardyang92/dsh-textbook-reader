/**
 * dsh-textbook-reader — host half.
 *
 * M0 skeleton: a valid, loadable Cordis plugin with no side effects yet.
 * M1 adds the /textbook-reader routes, the book store and the MinerU job
 * manager; M4 adds the textbook_* agent tools and the browser half.
 *
 * The plugin must stay mountable without any web service so a headless
 * profile can still load the same package without crashing.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'dsh-textbook-reader'

/** No required services yet; later milestones inject tools/webServer. */
export const inject: string[] = []

/**
 * Mount the plugin skeleton.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  try {
    ctx.logger?.info?.('[dsh-textbook-reader] skeleton loaded (M0)')
  } catch {
    // A logger is optional; never fail the host composition over diagnostics.
  }
}
