/**
 * Type face of the forwarded-Host-event allowlist: the consumer key projection
 * and the selection seat it fills. The allowlist VALUE lives in
 * `./remote-events.ts`, keeping this module type-only per the package
 * convention; both compiler faces list both files, so the Host forwarding loop
 * and the consumer `ctx.remote.$on` key face read one declaration instead of
 * two copies that could drift.
 *
 * @module @deepseek-ai/dsh-api-remotes/types
 */

import type { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

/** Type projection of the allowlist; the consumer and the Host read this one. */
export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]['event']

/**
 * One Workgroup Hub realtime event envelope, as `server/contracts/events.schema.json`
 * defines it (`wg.v1`). DS Bot's Host adapter forwards each received envelope
 * verbatim, so the payload stays unprojected: that contract, not this type, is the
 * authority on per-type payloads.
 */
export interface WorkgroupEvent {
  /** Contract generation this envelope was issued under. */
  readonly schemaVersion: 'wg.v1'
  /** Envelope identity, unique within the Hub. */
  readonly eventId: string
  /** Realtime event discriminator, drawn from the contract's closed enum. */
  readonly type: string
  /** Issue time, an ISO 8601 instant. */
  readonly issuedAt: string
  /** Room the event belongs to, when the event is room-scoped. */
  readonly roomId?: string
  /** Per-room monotonic sequence, when the Hub assigns one. */
  readonly roomSeq?: number
  /** Request this event answers, when the event is a reply. */
  readonly requestId?: string
  /** Event-specific body; its fields are defined by the event `type`. */
  readonly payload: Readonly<Record<string, unknown>>
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One Workgroup Hub realtime envelope arrived over the Bridge connection.
     * DS Bot publishes it from `packages/bundle/ds-bot/src/host/workgroup-hub.js`.
     * @mode emit
     * @param event - the received envelope, forwarded without renaming.
     */
    'workgroup/event'(event: WorkgroupEvent): void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}
