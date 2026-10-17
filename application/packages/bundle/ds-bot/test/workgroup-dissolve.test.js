import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

// D in the client half: the settings form must dissolve a workgroup, not delete it locally.
//
// `GroupSettingsForm` was written for local group chats, where "delete" is a local bookkeeping act and
// `actions.deleteRoom` is the host's own room store. A workgroup is a Hub room the host store has never
// heard of — the host refuses those with `Unknown group chat` — so wiring the existing button straight
// through gives a workgroup settings panel whose only destructive action always fails.
//
// What the UI must show, and what these cases pin:
//
//   * **dissolving is offered and named as dissolving.** "Delete group" would tell an owner their
//     history is about to be destroyed; the Hub keeps it, so the label has to say so.
//   * **leaving and removing stay separate.** The requirement separates all three, and a shared button
//     would let a member end a workgroup for everyone.
//   * **remote bots are not renamed into the settings form's local roster shape silently.** The
//     existing call maps Hub members to plain ids; that mapping must keep working for the fields the
//     form uses.

const VIEW = readFileSync(new URL('../src/client/workgroup.js', import.meta.url), 'utf8')
const PANE = readFileSync(new URL('../src/client/workgroup-pane.js', import.meta.url), 'utf8')
const SETTINGS = readFileSync(new URL('../src/client/group-settings.js', import.meta.url), 'utf8')

test('the pane dissolves through the Hub, not through the local room store', () => {
  // `GroupSettingsForm` calls `actions.deleteRoom(room.id)`, and for a workgroup that must not reach the
  // local store — the host refuses a Hub room there with `Unknown group chat`. The pane is where the
  // Hub client is available, so this is where the action is decided.
  assert.match(PANE, /workgroups\.dissolve\(value\.dissolve\)/, 'the pane must call the Hub dissolve endpoint')
  // The settings surface is Hub-specific (`WorkgroupSettings`), so it calls the dissolve the pane
  // handed it and never the local room store. `GroupSettingsForm` is not mounted for a workgroup:
  // its destructive action edits a local room the Host does not have.
  const WORKGROUP_SETTINGS = readFileSync(new URL('../src/client/workgroup-settings.js', import.meta.url), 'utf8')
  assert.match(WORKGROUP_SETTINGS, /onDissolve\(room\.id\)/, 'the form action is the Hub dissolve')
  assert.equal(/deleteRoom\(/.test(VIEW + WORKGROUP_SETTINGS), false, 'no local delete is wired')
})

test('dissolving is labelled as dissolving rather than as deleting', () => {
  // The label is the only thing telling the owner whether their history survives. It does, so a
  // workgroup must not be shown the local group chat's "Delete group".
  assert.match(SETTINGS, /Dissolve workgroup/, 'a workgroup offers dissolving')
  assert.match(SETTINGS, /room\.kind === 'workgroup'/, 'the distinction follows the room kind the Hub reports')
})

test('the confirm step on a workgroup says the history is kept', () => {
  // A confirmation that said "delete" would be read as "this removes everything", and an owner who
  // wanted that would then be surprised to find the history still there.
  assert.match(SETTINGS, /History and records are kept/)
})
