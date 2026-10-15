/** Cordis Loader configuration file discovery. */

import { globSync } from 'node:fs'

/**
 * Return repository-relative Cordis Loader YAML paths under `root`.
 *
 * Translation consistency records are YAML sidecars, never Loader inputs.
 *
 * @param root Repository root to scan.
 * @returns Sorted repository-relative Loader configuration paths.
 */
export function cordisConfigFiles(root: string): string[] {
  return globSync(['**/*cordis*.yml', '**/*cordis*.yaml'], {
    cwd: root,
    // `**/node_modules/**` rather than `node_modules/**`: the latter is anchored to the scan root
    // and so lets every nested install be treated as repository configuration — including the
    // private harness a vendored package installs beside its own sources.
    exclude: ['.claude/**', '**/node_modules/**', 'vendor/**', '**/*.i18n.yaml'],
  }).sort()
}
