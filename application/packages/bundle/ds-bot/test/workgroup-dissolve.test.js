import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

// The settings surface must dissolve a workgroup through the Hub, not delete a local room.
//
// A workgroup is a Hub room the host's own room store has never heard of, so `actions.deleteRoom`
// would always fail for it. The interface that offers the ending is the copied workgroup settings
// form; the original group chat's form edits local rooms only and must not learn about workgroups.
//
// These cases pin three things:
//
//   * dissolving is offered by the workgroup form and named as dissolving;
//   * the confirmation says the history is kept, because the Hub keeps it;
//   * the original group chat's form carries no workgroup branch — the isolation rule.

const VIEW = readFileSync(new URL('../src/client/workgroup.js', import.meta.url), 'utf8')
const PANE = readFileSync(new URL('../src/client/workgroup-pane.js', import.meta.url), 'utf8')
const SETTINGS = readFileSync(new URL('../src/client/workgroup-ui/settings.js', import.meta.url), 'utf8')
const LOCAL_SETTINGS = readFileSync(new URL('../src/client/group-settings.js', import.meta.url), 'utf8')

test('the pane dissolves through the Hub, not through the local room store', () => {
  assert.match(PANE, /workgroups\.dissolve\(value\.dissolve\)/, 'the pane must call the Hub dissolve endpoint')
  assert.match(SETTINGS, /onDissolve\(room\.id\)/, 'the form action is the Hub dissolve')
  assert.equal(/deleteRoom\(/.test(VIEW + SETTINGS), false, 'no local delete is wired')
})

test('dissolving is labelled as dissolving rather than as deleting', () => {
  assert.match(SETTINGS, /Dissolve workgroup/, 'a workgroup offers dissolving')
  assert.equal(/Delete group/.test(SETTINGS), false, 'a workgroup never shows the local group label')
})

test('the confirm step on a workgroup says the history is kept', () => {
  assert.match(SETTINGS, /History and records are kept/)
  assert.match(SETTINGS, /stays readable/)
})

test('the original group-chat settings form is back to local semantics', () => {
  assert.equal(/workgroup/i.test(LOCAL_SETTINGS), false, 'the original form must carry no workgroup branch')
  assert.match(LOCAL_SETTINGS, /data-group-action': 'delete'/)
  assert.match(LOCAL_SETTINGS, /Delete group/)
})
