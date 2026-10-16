import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildLib, stageLib } from '../scripts/build-lib.mjs'

const ROOT_MANIFEST = new URL('../package.json', import.meta.url)

// The dev loop calls stageLib on every browser-half rebuild, so staging an unchanged tree must not
// rewrite bytes: a rewrite would move the timestamps `client-hmr` polls and reload the page for a
// build that changed nothing.
test('stageLib is idempotent: an unchanged tree finds nothing to write', () => {
  const current = buildLib()
  assert.equal(stageLib({ write: false, current }).changed, false)
  assert.equal(stageLib({ write: true, current }).changed, false, 'an unchanged tree must not be rewritten')
  assert.equal(stageLib({ write: false, current }).changed, false, 'a second check must remain a no-op')
})

test('stageLib reports a stale in-memory tree without writing the shared lib directory', () => {
  const current = buildLib()
  current.delete('client.js')
  assert.equal(stageLib({ write: false, current }).changed, true)
})

test('the staged manifest resolves the staged browser client', () => {
  const files = buildLib()
  const manifest = JSON.parse(files.get('package.json').toString('utf8'))
  const client = manifest.exports?.['./client']
  assert.equal(client, './client.js')
  assert.equal(files.has(client.slice('./'.length)), true)
})

test('the published file list includes the staged manifest', () => {
  const manifest = JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8'))
  assert.equal(manifest.files.includes('lib/package.json'), true)
})
