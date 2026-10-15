/** Type declarations for the product-identity module consumed by the packaging scripts. */

/** Reverse-DNS application id. Differs from the official product's `ai.deepseek.harness`. */
export const PRODUCT_APP_ID: 'ai.workgroup.workgroup-ai'

/** Human-facing product name, also the Electron `app.name`. */
export const PRODUCT_NAME: 'Workgroup AI'

/** URL scheme for deep links; the official product claims `dsh`. */
export const PRODUCT_PROTOCOL: 'wgai'

/** Data-root directory name used when `WORKGROUP_HOME` is unset. */
export const PRODUCT_DATA_DIR_NAME: '.workgroup-ai'

/** File-name prefix shared by packaging's `artifactName` and the upload plan's download URL. */
export const PRODUCT_ARTIFACT_PREFIX: string

/** Update-feed path prefix, distinct from upstream's `dsh-desk`. */
export const PRODUCT_UPDATE_KEY_PREFIX: string

/** Raised when an identity value is malformed or would collide with the official product. */
export class ProductIdentityError extends Error {}

/** Product identity as the build and runtime consume it. */
export interface ProductIdentity {
  readonly appId: string
  readonly protocol: string
  readonly name: string
  readonly dataDirName: string
}

/**
 * Resolve product identity, applying validated environment overrides.
 * @param env - Environment mapping; defaults to `process.env`.
 * @returns Frozen identity values.
 * @throws {ProductIdentityError} When an override is malformed.
 */
export function resolveProductIdentity(env?: Record<string, string | undefined>): Readonly<ProductIdentity>

/**
 * Resolve the data root for one user.
 * @param options - Environment mapping and the operating-system home directory.
 * @returns The configured `WORKGROUP_HOME`, or the product default under `home`.
 */
export function resolveDataRoot(options: { env?: Record<string, string | undefined>, home: string }): string

/**
 * Assert this product and the official one cannot share writable state.
 * @param values - The official and fork values to compare.
 * @returns True when every value differs.
 * @throws {ProductIdentityError} When a value is shared, naming which one.
 */
export function assertCoexistence(values: {
  officialAppId: string
  forkAppId: string
  officialScheme: string
  forkScheme: string
  officialDataRoot: string
  forkDataRoot: string
}): boolean
