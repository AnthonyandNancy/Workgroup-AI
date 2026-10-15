/**
 * Resolve the Workgroup AI product identity sealed into the installed application manifest.
 *
 * Packaging writes these fields into the app manifest from
 * `integrations/product/identity.mjs`, so the running app reports the same identity the
 * installer registered. Reading them at run time rather than hardcoding them keeps one
 * source of truth: a rebranded build cannot end up with an installer that registers one
 * protocol scheme and a runtime that listens for another.
 *
 * An unsealed manifest (a development tree, or an older install) falls back to the values
 * this fork ships, so a developer running from source still gets the fork's scheme.
 */

/** Fork defaults, matching `integrations/product/identity.mjs`. */
const DEFAULTS = Object.freeze({
  name: 'Workgroup AI',
  protocol: 'wgai',
  dataDirName: '.workgroup-ai',
})

const SCHEME = /^[a-z][a-z0-9+.-]*$/

/** Identity the running application uses for deep links and data-root naming. */
export interface DesktopProductIdentity {
  /** Human-facing product name, also used for the window and About panel. */
  readonly name: string
  /** URL scheme this install owns for deep links. */
  readonly protocol: string
  /** Default data-root directory name under the OS home, used only when `WORKGROUP_HOME` is unset. */
  readonly dataDirName: string
}

function stringField(manifest: Record<string, unknown>, key: string, fallback: string): string {
  const value = manifest[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`desktop product: ${key} must be a non-empty string when present`)
  }
  return value
}

/**
 * Read the packaged product identity.
 * @param manifest Parsed application manifest.
 * @returns Validated identity. An unusable sealed value rejects rather than silently
 *          registering a scheme the installer did not claim.
 */
export function desktopProductIdentity(manifest: unknown): DesktopProductIdentity {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop product: invalid application manifest')
  const record = manifest as Record<string, unknown>
  const name = stringField(record, 'workgroupProductName', DEFAULTS.name)
  const protocol = stringField(record, 'workgroupProtocol', DEFAULTS.protocol)
  if (!SCHEME.test(protocol)) throw new Error(`desktop product: invalid deep-link scheme ${protocol}`)
  const dataDirName = stringField(record, 'workgroupDataDirName', DEFAULTS.dataDirName)
  if (!dataDirName.startsWith('.') || dataDirName.includes('/') || dataDirName.includes('\\') || dataDirName.includes('..')) {
    throw new Error(`desktop product: invalid data root name ${dataDirName}`)
  }
  return Object.freeze({ name, protocol, dataDirName })
}

export const desktopProductDefaults = DEFAULTS
