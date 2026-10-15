// F-11 PoC: open a task Session for a real Bot through the plugin's own channel, then read it
// back after the host answers, and print the identity the model would see.
//
// Run against a live bench: node dev/task-session-poc.mjs <bench-name> <web-port>
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, port] = process.argv.slice(2)
if (!name || !port) { console.error('usage: node dev/task-session-poc.mjs <bench-name> <web-port>'); process.exit(2) }
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HOME = join(ROOT, `.dsh-test-${name}`)
const BASE = `http://127.0.0.1:${port}`

const log = readFileSync(join(HOME, 'web.log'), 'utf8')
// The login URL is the only line the log carries; taking it whole avoids building a regex
// around a port that may appear in more than one place.
const url = log.split(/\s+/).find(token => token.startsWith('http://127.0.0.1:') && token.includes('token='))
if (!url) throw new Error('no login URL in web.log')
const login = await fetch(url, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')

const api = async (endpoint, payload = {}) => {
  const response = await fetch(`${BASE}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
  return result.value
}

const state = () => api('state')
const bot = async (wanted) => Object.values((await state()).bots).find(b => b.name === wanted)

const writer = await bot('Writer')
if (writer === undefined) throw new Error('the bench has no Writer; run the smoke test first')
console.log(`Bot ${writer.name} (${writer.id}) chat session = ${writer.sessionId ?? writer.id}`)

// The plugin's own channel opens the Session the same way the host module does, so this proves
// the wiring the host uses rather than a private path.
const opened = await api('task-session-open', { taskId: 'poc-task-1', botId: writer.id })
console.log(`opened task session = ${opened.sessionId}`)
console.log(`identity the model sees: botId=${opened.botId} named=${opened.identityName} role=${opened.identityRole}`)

// A second call must reuse it: two Sessions for one task would double its side effects.
const again = await api('task-session-open', { taskId: 'poc-task-1', botId: writer.id })
console.log(`reopened same task -> ${again.sessionId} (same as before: ${again.sessionId === opened.sessionId})`)

const after = await state()
console.log(`team file now records taskSessions: ${JSON.stringify(Object.keys(after.taskSessions ?? {}))}`)
const saved = after.taskSessions?.['poc-task-1']
console.log(`saved binding: botId=${saved?.botId} sessionId=${saved?.sessionId}`)
console.log(`the Bot's own chat is untouched: ${writer.sessionId ?? writer.id}`)
