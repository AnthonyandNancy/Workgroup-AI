// The Browser reaches the Hub through one Host route (`/api/bot`), and that route dispatches on an
// explicit whitelist. An endpoint the adapter calls but the whitelist omits is invisible until a
// real window tries it: the unit tests on either side both pass, because each tests its own half.
//
// These cases close that seam from both directions: every `hub-*` call the Browser adapter makes
// must be a case in the Host channel and a case in the Host's Hub endpoint table, and the read-only
// endpoints must be listed as reads so a read-only window can still use the workgroup.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '..', 'packages', 'bundle', 'ds-bot', 'src')
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')

const client = read('client', 'workgroup-hub.js')
const channel = read('host', 'channel.js')
const host = read('host', 'workgroup-hub.js')

const invoked = [...new Set([...client.matchAll(/invoke\('(hub-[a-z-]+)'/g)].map(match => match[1]))].sort()

// Everything below only reads Hub state. A read-only window (a second window on the same machine, or
// a Host kept read-only by another process) must still be able to open a workgroup.
const READS = [
  'hub-view', 'hub-me', 'hub-devices', 'hub-messages', 'hub-head', 'hub-tasks', 'hub-members',
  'hub-memory', 'hub-memory-search', 'hub-directory', 'hub-invitations', 'hub-bot-invitations',
  'hub-open-room', 'hub-bot-candidates', 'hub-task-events', 'hub-download-artifact',
]

const channelReads = (() => {
  const line = channel.split('\n').find(entry => entry.includes('const READS = new Set(['))
  expect(line, 'the channel must declare its read-only endpoints').toBeDefined()
  return new Set([...line.matchAll(/'([a-z-]+)'/g)].map(match => match[1]))
})()

describe('the Browser → Host → Hub bridge is complete', () => {
  it('lists the endpoints the adapter actually calls', () => {
    expect(invoked.length).toBeGreaterThan(20)
    expect(invoked).toContain('hub-bot-candidates')
    expect(invoked).toContain('hub-task-events')
  })

  it('dispatches every adapter endpoint through the Host channel', () => {
    for (const endpoint of invoked) {
      expect(channel.includes(`case '${endpoint}'`), `channel.js is missing ${endpoint}`).toBe(true)
    }
  })

  it('has a Host implementation for every adapter endpoint', () => {
    // `hub-view` and `hub-configure` are answered before the dispatch table: they are the two calls
    // that must work while no Hub session exists.
    const preSwitch = new Set(['hub-view', 'hub-configure'])
    for (const endpoint of invoked) {
      const handled = host.includes(`case '${endpoint}'`) || host.includes(`endpoint === '${endpoint}'`)
      expect(handled, `host workgroup-hub.js is missing ${endpoint}`).toBe(true)
    }
    expect(preSwitch.size).toBe(2)
  })

  it('lets a read-only window use every read endpoint', () => {
    for (const endpoint of READS) {
      expect(channelReads.has(endpoint), `READS is missing ${endpoint}`).toBe(true)
    }
    // Writes stay out: a read-only window must not be able to change a room or a Bot.
    for (const endpoint of ['hub-add-bot', 'hub-remove-bot', 'hub-invite-bot', 'hub-respond-bot-invitation', 'hub-memory-create', 'hub-memory-revise', 'hub-memory-delete', 'hub-rename-room', 'hub-update-notice']) {
      expect(channelReads.has(endpoint), `READS must not contain ${endpoint}`).toBe(false)
    }
  })
})
