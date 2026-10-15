// DS Bot: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under WORKGROUP_HOME so they survive restarts without new Session
// event types.
//
// The Host half is authored as plain JavaScript under `src/host` and `src/shared`, and the
// package's build script stages it into `lib/` with that structure intact. This declaration
// states the module's public face: the Cordis plugin contract the Loader reads.
import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export declare const name = 'ds-bot'

/** Core services this plugin requires before any Bot can run. */
export declare const inject: string[]

/** One of the palette colours the Bot surface renders. */
export declare const COLORS: Readonly<Record<string, string>>

/**
 * Plugin configuration, as a profile's `cordis.patch.yml` may override it.
 */
export interface Config {
  /** Team data root; defaults to `<WORKGROUP_HOME>/bot`. */
  home?: string
  /** Display name of the Main Bot; defaults to `Chief`. */
  mainName?: string
  /** Role line of the Main Bot; defaults to `Chief of Staff`. */
  mainRole?: string
}

/**
 * Mount the Bot team host: registers its tools, listeners, and effects.
 * @param ctx - plugin context carrying the injected services.
 * @param config - optional per-profile configuration.
 */
export declare function apply(ctx: Context, config?: Config): void

/**
 * Build the team runtime without mounting it, for callers that need the closure directly.
 * @param ctx - plugin context carrying the injected services.
 * @param config - optional per-profile configuration.
 * @returns the runtime object the Host modules share.
 */
export declare function createRuntime(ctx: Context, config?: Config): unknown
