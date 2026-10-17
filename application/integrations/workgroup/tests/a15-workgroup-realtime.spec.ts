import { describe, expect, it } from 'vitest'
import { createSource } from '../../../packages/bundle/ds-bot/src/client/sources.js'
import { createWorkgroupHub } from '../../../packages/bundle/ds-bot/src/client/workgroup-hub.js'
import { composeMessage, mentionCandidates } from '../../../packages/bundle/ds-bot/src/client/workgroup-mentions.js'
import { createWorkgroupClient } from '../client/index.mjs'

function bridge() {
  const view = createSource({ configured: true, signedIn: true, state: 'open' })
  return {
    view,
    send: async (endpoint, payload) => {
      if (endpoint === 'hub-open-room') {
        return {
          room: { id: payload.roomId, name: 'Ops' },
          members: [{ userId: 'u1', online: false }],
          messages: [],
          tasks: [],
          head: 0,
        }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    },
  }
}

describe('the Browser workgroup room state', () => {
  it('reduces a Bridge presence event into the opened room state', async () => {
    const hub = createWorkgroupHub({ bridge: bridge() })
    await hub.openRoom('room-1')
    const source = hub.roomState('room-1')

    hub.applyEvent({
      type: 'presence.changed',
      roomId: 'room-1',
      payload: { userId: 'u1', online: true },
    })

    expect(source.getSnapshot().members[0].online).toBe(true)
  })
})


describe('the opened room Bot directory', () => {
  it('loads only member directories and exposes published Bots with stable mention ids', async () => {
    const requests = []
    const client = {
      request: async (method, path) => {
        requests.push(path)
        if (path === '/rooms/room-1') return { room: { id: 'room-1' }, members: [{ userId: 'u1' }] }
        if (path.includes('/messages')) return { messages: [] }
        if (path.includes('/tasks')) return { tasks: [] }
        if (path === '/bots/directory?ownerUserId=u1') return { bots: [
          { botId: 'writer', ownerUserId: 'u1', displayName: 'Writer', visibility: 'public', state: 'idle', instructions: 'private instructions' },
          { botId: 'private', ownerUserId: 'u1', displayName: 'Private', visibility: 'private' },
          { botId: 'outsider', ownerUserId: 'u2', displayName: 'Outsider', visibility: 'public' },
        ] }
        throw new Error(`unexpected directory request ${path}`)
      },
    }
    const state = await createWorkgroupClient({ client }).openRoom('room-1')
    expect(state.bots).toEqual([
      { botId: 'writer', ownerUserId: 'u1', displayName: 'Writer', visibility: 'public', state: 'idle' },
    ])
    expect(requests.filter(path => path.includes('directory'))).toEqual(['/bots/directory?ownerUserId=u1'])
    const bots = mentionCandidates(state).filter(entry => entry.kind === 'bot')
    expect(bots).toHaveLength(1)
    expect(composeMessage('Writer, help', bots).mentions).toEqual([{ userId: 'u1', botId: 'writer' }])
  })

  it('forwards the complete message once with an explicit retry id', async () => {
    const requests = []
    const workgroup = createWorkgroupClient({ client: { request: async (...args) => { requests.push(args) } } })
    await workgroup.sendMessage('room-1', 'ask the Bot', {
      clientMessageId: 'client-1', replyToMessageId: 'm1',
      mentions: [{ userId: 'u1', botId: 'writer' }], attachments: [{ artifactId: 'a1' }],
    })
    expect(requests).toEqual([['POST', '/rooms/room-1/messages', { body: {
      clientMessageId: 'client-1', body: 'ask the Bot', replyToMessageId: 'm1',
      mentions: [{ userId: 'u1', botId: 'writer' }], attachments: [{ artifactId: 'a1' }],
    } }]])
  })
})

describe('room baseline and event ordering', () => {
  it('retains events received during the baseline read and deduplicates catch-up', async () => {
    let finish
    const transport = bridge()
    transport.send = () => new Promise(resolve => { finish = resolve })
    const hub = createWorkgroupHub({ bridge: transport })
    const opened = hub.openRoom('room-1')
    const message = { id: 'm1', roomId: 'room-1', roomSeq: 1, body: 'arrived during load' }
    const event = { eventId: 'e1', type: 'message.created', roomId: 'room-1', payload: { message } }
    hub.applyEvent(event)
    finish({ room: { id: 'room-1' }, members: [], messages: [], tasks: [], head: 0 })
    await opened
    expect(hub.roomState('room-1').getSnapshot().messages).toEqual([message])
    hub.applyEvent(event)
    expect(hub.roomState('room-1').getSnapshot().messages).toEqual([message])
    expect(hub.roomState('room-1').getSnapshot().head).toBe(1)
  })
})
