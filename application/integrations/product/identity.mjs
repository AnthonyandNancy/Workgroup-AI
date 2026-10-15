// Workgroup AI product identity.
//
// This fork ships beside an installed official DeepSeek Harness, so every value that the
// operating system uses to decide "which app is this" must differ from upstream's:
// the application id, the URL scheme, the single-instance lock, and the on-disk data root.
// Getting any one of them wrong makes the two products fight: a shared appId makes Windows
// treat them as the same install, a shared protocol steals the other's deep links, and a
// shared data root lets the two writers corrupt each other's sessions.
//
// The values live here, in the application tree, so the build reads them from one place
// instead of them being scattered through the packaging scripts.

import { join } from 'node:path'

/** Reverse-DNS application id. Must differ from upstream's `ai.deepseek.harness`. */
export const PRODUCT_APP_ID = 'ai.workgroup.workgroup-ai'

/** Human-facing product name. Also the Electron `app.name`, so it names the userData dir. */
export const PRODUCT_NAME = 'Workgroup AI'

/** URL scheme for deep links. Upstream claims `dsh`; this fork must not. */
export const PRODUCT_PROTOCOL = 'wgai'

/**
 * Data-root directory name used when `WORKGROUP_HOME` is unset.
 *
 * The fork must not default to `~/.dsh`: that is the official product's data root, and two
 * writers in one directory can interleave session files. The override is only ever
 * read for the default, so an operator who sets `WORKGROUP_HOME` keeps full control.
 */
export const PRODUCT_DATA_DIR_NAME = '.workgroup-ai'

/**
 * File-name prefix for release artifacts.
 *
 * Shared by the packaging config's `artifactName` and the upload plan's fixed-download URL, so a
 * downloaded file cannot be mistaken for an official DeepSeek Harness build — and the URL the
 * plan publishes always names the file packaging actually produced.
 */
export const PRODUCT_ARTIFACT_PREFIX = 'workgroup-ai'

/**
 * Update-feed path prefix, distinct from upstream's `dsh-desk`.
 *
 * The origin is a separate concern (it is deployment configuration, resolved by the packaging
 * script from `DOWNLOAD_*_ORIGIN`); the prefix is identity, because it decides which objects in
 * a shared bucket this product reads and writes.
 */
export const PRODUCT_UPDATE_KEY_PREFIX = 'workgroup-ai-desk'

/** Errors thrown by these resolvers name the variable an operator must set. */
export class ProductIdentityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProductIdentityError'
  }
}

const REVERSE_DNS = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const SCHEME = /^[a-z][a-z0-9+.-]*$/

/**
 * Product identity as the build and runtime consume it.
 *
 * Environment overrides exist so a downstream distributor can rebrand without editing
 * source, but each is validated: a malformed appId or scheme is rejected at build time
 * rather than producing an install that cannot register its protocol handler.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveProductIdentity(env = process.env) {
  const appId = env.WORKGROUP_APP_ID ?? PRODUCT_APP_ID
  if (!REVERSE_DNS.test(appId)) {
    throw new ProductIdentityError('WORKGROUP_APP_ID must be a reverse-DNS identifier such as ai.example.product')
  }
  const protocol = env.WORKGROUP_PROTOCOL ?? PRODUCT_PROTOCOL
  if (!SCHEME.test(protocol)) {
    throw new ProductIdentityError('WORKGROUP_PROTOCOL must be a URL scheme such as wgai')
  }
  const name = env.WORKGROUP_PRODUCT_NAME ?? PRODUCT_NAME
  if (name.trim().length === 0) throw new ProductIdentityError('WORKGROUP_PRODUCT_NAME must not be empty')
  const dataDirName = env.WORKGROUP_DATA_DIR_NAME ?? PRODUCT_DATA_DIR_NAME
  // A data-root name becomes a path segment, so anything with a separator or a parent
  // reference would let it escape the home directory.
  if (!/^\.[A-Za-z0-9._-]+$/.test(dataDirName) || dataDirName.includes('..') || dataDirName.includes('/') || dataDirName.includes('\\')) {
    throw new ProductIdentityError('WORKGROUP_DATA_DIR_NAME must be a single hidden directory name such as .workgroup-ai')
  }
  return Object.freeze({ appId, protocol, name, dataDirName })
}

/**
 * Data root for a user, given the environment.
 *
 * `WORKGROUP_HOME` keeps working, because it is what an operator and the existing test bench
 * already use to point a run at a scratch directory. Only the *default* changes.
 *
 * @param {{ env?: Record<string, string | undefined>, home: string }} options
 */
export function resolveDataRoot({ env = process.env, home }) {
  const configured = env.WORKGROUP_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  // `join`, not string concatenation: the default must use this platform's separator, or a
  // Windows run would produce a path the filesystem layer has to guess about.
  return join(home, resolveProductIdentity(env).dataDirName)
}

/**
 * Assert this fork and the official product cannot share writable state.
 *
 * Called by the coexistence test and available to a build that wants to prove isolation
 * before packaging. A shared data root is the dangerous case: two products writing one
 * session store corrupt each other silently, with no error a user could report.
 *
 * @param {{ officialAppId: string, forkAppId: string, officialScheme: string, forkScheme: string, officialDataRoot: string, forkDataRoot: string }} values
 */
export function assertCoexistence(values) {
  const problems = []
  if (values.officialAppId === values.forkAppId) problems.push(`appId is shared (${values.forkAppId})`)
  if (values.officialScheme === values.forkScheme) problems.push(`protocol scheme is shared (${values.forkScheme})`)
  if (values.officialDataRoot === values.forkDataRoot) problems.push(`data root is shared (${values.forkDataRoot})`)
  if (problems.length > 0) throw new ProductIdentityError(`This fork does not coexist with the official product: ${problems.join('; ')}`)
  return true
}
