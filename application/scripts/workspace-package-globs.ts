/** Convert discovered package manifests into portable bundler workspace patterns. */
import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'

/**
 * Keep filesystem separators from becoming escapes in workspace globs, and select only the
 * members whose artifacts a bundling pass can consume.
 *
 * The workspace pass that calls this bundles the JavaScript `tsc -b` emitted, so its members
 * are exactly the packages that compile into `lib/types`. A `tsconfig.json` is what makes that
 * output exist: a workspace member shipping authored JavaScript instead — one whose own build
 * script stages `lib/` — has no such entry, and selecting it fails the whole pass with
 * "Cannot find entry" rather than skipping the one package.
 *
 * @param manifests - Repository-relative manifest paths returned by filesystem discovery.
 * @param root - Repository root the returned patterns are relative to; omission keeps every manifest.
 * @returns Package directory patterns using forward slashes on every host.
 */
export function workspacePackageGlobs(manifests: readonly string[], root?: string): string[] {
  return manifests
    .map(path => posix.dirname(path.replaceAll('\\', '/')))
    .filter((directory) => {
      if (root === undefined) return true
      // `join` accepts the POSIX separators above on every host; only the pattern spelling is normalized.
      return existsSync(join(root, directory, 'tsconfig.json'))
    })
}
