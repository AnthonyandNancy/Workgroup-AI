import { describe, expect, it, vi } from 'vitest'
import {
  createWorkgroupRoster,
  emptyWorkgroupRoster,
  loadWorkgroupPrefs,
  saveWorkgroupPrefs,
  sortWorkgroupRows,
  visibleWorkgroupRows,
  workgroupRow,
  workgroupRoomsOf,
} from '../../../packages/bundle/ds-bot/src/client/workgroup-roster.js'

const room = (overrides = {}) => ({
  id: 'r1',
  kind: 'workgroup',
  name: 'Ops',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastMessageAt: '2026-01-02T00:00:00.000Z',
  lastMessageSeq: 4,
  memberCount: 2,
  botCount: 1,
  pendingApprovalCount: 0,
  ...overrides,
})

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

function adapter(overrides = {}) {
  return {
    available: true,
    rooms: vi.fn(async () => [room(), { id: 'local-1', kind: 'ordinary', name: 'Local' }]),
    invitations: vi.fn(async () => [{ id: 'i1', roomId: 'r1' }]),
    botInvitations: vi.fn(async () => [{ id: 'b1', roomId: 'r1', botId: 'bot-1' }]),
    respondToInvitation: vi.fn(async () => ({ room: { id: 'r1' } })),
    respondToBotInvitation: vi.fn(async () => ({ invitation: { id: 'b1' } })),
    ...overrides,
  }
}

describe('the workgroup roster', () => {
  it('keeps only workgroups, so a Hub listing never becomes local rooms', async () => {
    const roster = createWorkgroupRoster({ workgroups: adapter(), pollMs: 0, prefs: () => ({}), storage: memoryStorage() })
    const state = await roster.refresh()
    expect(state.rooms.map(entry => entry.id)).toEqual(['r1'])
    expect(workgroupRoomsOf([{ id: 'a', kind: 'ordinary' }, { id: 'b' }])).toEqual([])
  })

  it('derives unread from the last sequence and the local watermark', () => {
    expect(workgroupRow(room(), {})).toMatchObject({ unread: 4, pinned: false, hidden: false })
    expect(workgroupRow(room(), { r1: { lastReadSeq: 4 } })).toMatchObject({ unread: 0 })
    expect(workgroupRow(room({ lastMessageSeq: undefined }), { r1: { lastReadSeq: 9 } }).unread).toBe(0)
  })

  it('sorts pinned rows first, then latest activity, with stable ties', () => {
    const rows = [
      workgroupRow(room({ id: 'old', name: 'Old', lastMessageAt: '2026-01-01T00:00:00.000Z' })),
      workgroupRow(room({ id: 'new', name: 'New', lastMessageAt: '2026-03-01T00:00:00.000Z' })),
      workgroupRow(room({ id: 'pinned', name: 'Zed', pinned: true }), { pinned: { pinned: true } }),
    ]
    expect(sortWorkgroupRows(rows).map(entry => entry.id)).toEqual(['pinned', 'new', 'old'])
  })

  it('drops hidden rows from the list but keeps them in the roster', async () => {
    const storage = memoryStorage({
      'ds-bot:workgroup-prefs': JSON.stringify({ r1: { hidden: true } }),
    })
    const roster = createWorkgroupRoster({ workgroups: adapter(), pollMs: 0, storage })
    const state = await roster.refresh()
    expect(state.rooms).toHaveLength(1)
    expect(visibleWorkgroupRows(state.rooms)).toEqual([])
  })

  it('marks a room read without waiting for another Hub poll', async () => {
    const storage = memoryStorage()
    const roster = createWorkgroupRoster({ workgroups: adapter(), pollMs: 0, storage })
    await roster.refresh()
    roster.markRead('r1', 4)
    expect(roster.view.getSnapshot().rooms[0].unread).toBe(0)
    expect(loadWorkgroupPrefs(storage).r1.lastReadSeq).toBe(4)
  })

  it('keeps the rooms it already had when a poll fails, and reports why', async () => {
    let fail = false
    const workgroups = adapter({
      rooms: vi.fn(async () => {
        if (fail) throw new Error('Hub is unreachable')
        return [room()]
      }),
    })
    const roster = createWorkgroupRoster({ workgroups, pollMs: 0, storage: memoryStorage() })
    await roster.refresh()
    fail = true
    const state = await roster.refresh()
    expect(state.phase).toBe('failed')
    expect(state.error).toBe('Hub is unreachable')
    expect(state.rooms.map(entry => entry.id)).toEqual(['r1'])
  })

  it('does not ask a Hub this device is not signed in to', async () => {
    const workgroups = adapter({ available: false })
    const roster = createWorkgroupRoster({ workgroups, pollMs: 0, storage: memoryStorage() })
    const state = await roster.refresh()
    expect(state).toEqual({ ...emptyWorkgroupRoster(), phase: 'blocked' })
    expect(workgroups.rooms).not.toHaveBeenCalled()
  })

  it('accepts the Hub’s wrapped invitation collections as well as bare lists', async () => {
    const workgroups = adapter({
      invitations: vi.fn(async () => ({ invitations: [{ id: 'i1', roomId: 'r1' }] })),
      botInvitations: vi.fn(async () => ({ invitations: [{ id: 'b1', roomId: 'r1', botId: 'bot-1' }] })),
    })
    const roster = createWorkgroupRoster({ workgroups, pollMs: 0, storage: memoryStorage() })
    const state = await roster.refresh()
    expect(state.invitations).toHaveLength(1)
    expect(state.botInvitations).toHaveLength(1)
  })

  it('answers an invitation through the adapter and re-reads the list', async () => {
    const workgroups = adapter()
    const roster = createWorkgroupRoster({ workgroups, pollMs: 0, storage: memoryStorage() })
    await roster.refresh()
    await roster.answerInvitation('i1', 'accept')
    expect(workgroups.respondToInvitation).toHaveBeenCalledWith('i1', 'accept')
    expect(workgroups.rooms).toHaveBeenCalledTimes(2)
  })

  it('persists preferences and tolerates a storage that refuses writes', () => {
    const storage = memoryStorage()
    saveWorkgroupPrefs({ r1: { pinned: true } }, storage)
    expect(loadWorkgroupPrefs(storage)).toEqual({ r1: { pinned: true } })
    expect(loadWorkgroupPrefs({ getItem: () => '{not json' })).toEqual({})
    expect(() => saveWorkgroupPrefs({}, { setItem: () => { throw new Error('denied') } })).not.toThrow()
  })
})
