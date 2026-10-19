import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { WORKGROUP_UI_CSS } from '../src/client/workgroup-ui/styles.js'

// The workgroup's rules live in two sheets: the conversation surface and the sidebar rows. The
// sidebar module imports shell packages, so its sheet is read as text rather than imported; a class
// rendered by either surface must be styled by one of them, so both are searched.
const SIDEBAR_SOURCE = readFileSync(new URL('../src/client/workgroup-sidebar.js', import.meta.url), 'utf8')
const SIDEBAR_CSS = SIDEBAR_SOURCE.slice(SIDEBAR_SOURCE.indexOf('export const WORKGROUP_SIDEBAR_CSS'))
const WORKGROUP_CSS = `${WORKGROUP_UI_CSS}
${SIDEBAR_CSS}`

// The workgroup view reuses the original room chrome, so it also reuses that chrome's class
// convention: `bt-wg*` for this fork's own additions. A class with no rule is not a cosmetic
// defect — an unstyled members list, message row, or compose bar renders as bare text stacked
// against the other rows, which reads as a broken panel rather than a workgroup.
//
// The list is read from the modules that use the names instead of being copied here, so a class
// added to the view without a rule fails this test rather than shipping invisible.
const SOURCES = [
  'workgroup.js',
  'workgroup-pane.js',
  'workgroup-sidebar.js',
  'workgroup-ui/index.js',
  'workgroup-ui/composer.js',
  'workgroup-ui/thread.js',
  'workgroup-ui/activity.js',
  'workgroup-ui/details.js',
  'workgroup-ui/settings.js',
]

function classNamesUsed() {
  const names = new Set()
  for (const name of SOURCES) {
    const text = readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
    for (const match of text.matchAll(/bt-wg[a-z-]*/g)) {
      // `bt-wg-member-${presenceOf(member)}` contributes a static prefix, not a whole class name:
      // the actual names it produces are spelled out by the module it calls, and are checked there.
      // Treating the prefix as a class would demand a rule for a name nothing renders.
      if (text.slice(match.index + match[0].length).startsWith('${')) continue
      names.add(match[0])
    }
  }
  return [...names].sort()
}

test('every workgroup class the view renders has a rule', () => {
  const css = WORKGROUP_CSS
  assert.equal(typeof css, 'string')
  // `bt-wg-settings-form` is a modifier on the shared `bt-bs` card, which carries the rules; the
  // modifier itself needs none, so it is exempt rather than demanding a duplicate rule.
  const modifiers = new Set(['bt-wg-settings-form'])
  const missing = classNamesUsed()
    .filter(name => !modifiers.has(name))
    .filter(name => !new RegExp(`\.${name}(?![a-z-])`).test(css))
  assert.deepEqual(missing, [], 'these classes would render unstyled')
})

test('both presence states are styled, since the class name is built at render time', () => {
  // The member row's class comes from a template literal, so the scan above cannot see the two
  // names it produces. They are named here instead — otherwise the dot would render for online
  // members and vanish for the rest, which is the visual half of the same bug.
  for (const state of ['online', 'offline']) {
    assert.match(WORKGROUP_CSS, new RegExp(`\\.bt-wg-member-${state}(?![a-z-])`), `${state} must have a dot color`)
  }
})

test('the pane keeps the original panel geometry instead of restating it', () => {  // `left` is the only inline style the pane sets, because it is the measured width of the
  // overlay the pane stands in for. Restating position/size here would drift from `.bt-pane`.
  assert.match(WORKGROUP_CSS, /\.bt-wg-pane\{/)
  assert.doesNotMatch(WORKGROUP_CSS, /\.bt-wg-pane\{[^}]*position:/)
})

test('the offline state is styled as its own state, not as a quiet room', () => {
  // A workgroup whose Hub is absent can show neither messages nor an empty room: leaving it to the
  // default look would say the room was read and found quiet.
  const scoped = [...WORKGROUP_CSS.matchAll(/\.bt-wg-offline(?![a-z-])/g)].length
  assert.ok(scoped > 0, 'the offline state needs rules of its own')
})

test('the layer adds no colors of its own', () => {
  // The workgroup sits inside the team's own surface, so it uses the design tokens the surface
  // already defines; a literal color here would be the one element that ignores the dark theme.
  // Literals the shell itself already uses are reused rather than invented.
  const shell = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  const literals = new Set([...WORKGROUP_CSS.matchAll(/#[0-9a-f]{3,8}\b/gi)].map(match => match[0].toLowerCase()))
  const invented = [...literals].filter(color => !shell.toLowerCase().includes(color))
  assert.deepEqual(invented, [], 'these colors exist nowhere in the shell')
})
