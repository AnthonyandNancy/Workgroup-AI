/**
 * Virtual root of the worker host's in-memory filesystem. Kept
 * in one module so the process shim, the path/os shims, and the VFS image
 * collector cannot drift apart.
 */

/** Virtual filesystem root; `process.cwd()` and every absolute path start here. */
export const WORKGROUP_ROOT = '/dsh'

/** `$WORKGROUP_HOME`: durable-state directory inside the image. */
export const WORKGROUP_HOME = `${WORKGROUP_ROOT}/home`

/** Flat, symlink-free package tree resolved by the worker module loader. */
export const WORKGROUP_NODE_MODULES = `${WORKGROUP_ROOT}/node_modules`

/** Directory holding the composed cordis.yml. */
export const WORKGROUP_CONFIG = `${WORKGROUP_ROOT}/config`

/** Default (empty) workspace directory. */
export const WORKGROUP_WORKSPACE = `${WORKGROUP_ROOT}/workspace`

/** Temporary directory reported by `os.tmpdir()`. */
export const WORKGROUP_TMP = `${WORKGROUP_ROOT}/tmp`
