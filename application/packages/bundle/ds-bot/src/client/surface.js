import { STORAGE } from './storage.js'

// The plugin's surface mode: 'bot' paints the whole team interface over the shell,
// 'agent' withdraws every replacement so the shell's own interface comes back.
// `plain` marks a Bot-mode view whose main view is a plain session — only the
// conversation replacements come off then, the shell stays.
export function groupsFor({ mode, plain = false, panelActive = true }) {
  // Workgroup AI fork: `panelActive` says whether the product's own Bot panel is the visible
  // centre panel. Upstream painted the team over whatever the shell was showing, which is why
  // switching to a DSH Session or the Plugins page left Bot UI behind. Both groups are gated
  // on it, so every other surface gets the shell's own interface back with no cleanup of its
  // own. `panelActive` defaults to true for a profile that mounted DS Bot as a plain plugin,
  // where nothing arms the gate and the team stays the surface exactly as upstream intended.
  const on = mode === 'bot' && panelActive
  return { shell: on, conversation: on && !plain }
}

const GROUPS = ['shell', 'conversation']

// Runs every disposer even when one throws, last installed first: later entries
// lean on earlier ones (the theme's styles and tokens), never the other way round.
function disposeAll(disposers, label) {
  for (const dispose of [...disposers].reverse()) {
    try { dispose?.() } catch (error) { console.warn(`[ds-bot] ${label}`, error) }
  }
}

// Keeps the mounted groups in step with `groupsFor`. The conversation group sits on
// the shell's styles and tokens, so it comes off before the shell and goes on after.
// A group's list is cleared before it is disposed, and a failed install leaves it
// empty, so a throw never makes a later reconcile believe the group is mounted.
export function surfaceGroups(install) {
  const mounted = { shell: [], conversation: [] }
  const withdraw = (group) => {
    const disposers = mounted[group]
    mounted[group] = []
    disposeAll(disposers, `withdraw ${group}`)
  }
  return {
    reconcile(wanted) {
      for (const group of [...GROUPS].reverse()) if (!wanted[group]) withdraw(group)
      for (const group of GROUPS) {
        if (!wanted[group] || mounted[group].length > 0) continue
        try { mounted[group] = install[group]() } catch (error) { console.warn(`[ds-bot] install ${group}`, error) }
      }
    },
    dispose() { for (const group of [...GROUPS].reverse()) withdraw(group) },
  }
}

export function readMode(storage = globalThis.localStorage) {
  try { return storage.getItem(STORAGE.surface) === 'agent' ? 'agent' : 'bot' } catch { return 'bot' }
}

export function writeMode(mode, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE.surface, mode) } catch { /* storage unavailable */ }
}
