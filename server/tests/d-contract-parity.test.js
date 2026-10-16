// The realtime event list and the published contract must agree.
//
// `realtime/events.js` says it plainly: the whitelist "must stay a superset of
// `contracts/events.schema.json`'s enum", because an event the contract promises but the Hub omits
// makes `makeEvent` throw at the moment it is published — a 500 on the request that caused it. The
// reverse drift is quieter and was already present: `member.changed` has been emitted since the room
// routes existed and was missing from the contract, so a client validating envelopes against the
// schema would have rejected a real event.
//
// This file is the check that was missing in both directions.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { EVENT_TYPES } from '../src/realtime/events.js'

const schemaPath = fileURLToPath(new URL('../contracts/events.schema.json', import.meta.url))
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))

test('every event the Hub can publish is listed in the contract enum', () => {
  const contract = new Set(schema.properties.type.enum)
  const missing = EVENT_TYPES.filter(type => !contract.has(type))
  assert.deepEqual(missing, [], 'an event a client cannot validate is an event a client must guess about')
})

test('every event the contract lists is one the Hub can actually publish', () => {
  // The other direction, which is the one that produces a 500: `makeEvent` refuses a type outside the
  // whitelist, so a contract promising one would fail on the request that first tried to publish it.
  const whitelist = new Set(EVENT_TYPES)
  const promised = schema.properties.type.enum.filter(type => !whitelist.has(type))
  assert.deepEqual(promised, [], 'a promised event the Hub cannot emit fails at publish time')
})

test('the contract lists room.dissolved, which the dissolution route announces', () => {
  // Named explicitly so a future edit that drops it fails a test that says why, rather than only
  // shifting a set comparison.
  assert.equal(schema.properties.type.enum.includes('room.dissolved'), true)
})
