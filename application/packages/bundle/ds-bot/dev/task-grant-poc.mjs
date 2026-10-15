// F-13 PoC: an approved task's tool allowance, checked against the running runtime.
//
// Run against a live bench: node dev/task-grant-poc.mjs <bench-name> <web-port>
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, port] = process.argv.slice(2)
if (!name || !port) { console.error('usage: node dev/task-grant-poc.mjs <bench-name> <web-port>'); process.exit(2) }
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HOME = join(ROOT, `.dsh-test-${name}`)

const log = readFileSync(join(HOME, 'web.log'), 'utf8')
const url = log.split(/\s+/).find(token => token.startsWith('http://127.0.0.1:') && token.includes('token='))
if (!url) throw new Error('no login URL in web.log')
const login = await fetch(url, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')

const api = async (endpoint, payload = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/bot`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
  return result.value
}
const state = await api('state')
const writer = Object.values(state.bots).find(b => b.name === 'Writer')
if (writer === undefined) throw new Error('the bench has no Writer; run the smoke test first')

// The approved folder is a real directory this task may work in, and a second one it may not.
const approved = resolve(HOME, 'approved')
const outside = resolve(HOME, 'outside')
const { mkdirSync } = await import('node:fs')
mkdirSync(approved, { recursive: true })
mkdirSync(outside, { recursive: true })

console.log('=== 1. 打开 Task Session 并授予批准的范围 ===')
const opened = await api('task-session-open', { taskId: 'poc-grant-1', botId: writer.id, workDir: approved })
console.log(`session = ${opened.sessionId}`)
const grant = await api('task-grant-set', {
  taskId: 'poc-grant-1',
  allowedTools: ['read_file', 'write_file'],
  workDir: approved,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  revocationVersion: 0,
})
console.log(`grant: tools=${JSON.stringify(grant.allowedTools)} workDir=${grant.workDir}`)

const check = (toolName, input) => api('task-grant-check', { sessionId: opened.sessionId, toolName, input })

console.log('\n=== 2. 允许范围内的调用 ===')
for (const [tool, input] of [['read_file', { path: join(approved, 'q4.csv') }], ['write_file', { path: join(approved, 'out.csv') }], ['read_file', { path: 'relative.csv' }]]) {
  const r = await check(tool, input)
  console.log(`  ${tool}(${JSON.stringify(input).slice(0, 44)}) -> allowed=${r.allowed}`)
}

console.log('\n=== 3. 越权调用（应全部拒绝） ===')
for (const [label, tool, input] of [
  ['未批准的工具（Bash）', 'bash', { command: 'rm -rf /' }],
  ['批准目录之外', 'read_file', { path: join(outside, 'secret.txt') }],
  ['上级目录穿越', 'read_file', { path: join(approved, '..', 'outside', 'secret.txt') }],
  ['另一个卷', 'read_file', { path: 'D:/private/x.txt' }],
]) {
  const r = await check(tool, input)
  console.log(`  ${label}: allowed=${r.allowed}`)
  console.log(`     → ${r.reason}`)
}

console.log('\n=== 4. 上报工具仍可用（被拒绝的任务能向所有者报告） ===')
const ask = await check('ask_user', {})
console.log(`  ask_user -> allowed=${ask.allowed}`)

console.log('\n=== 5. 撤销后所有调用被拒（含上报工具） ===')
await api('task-grant-revoke', { taskId: 'poc-grant-1', reason: 'requester cancelled' })
for (const [tool, input] of [['read_file', { path: join(approved, 'q4.csv') }], ['ask_user', {}]]) {
  const r = await check(tool, input)
  console.log(`  ${tool} -> allowed=${r.allowed}`)
  console.log(`     → ${r.reason}`)
}

console.log('\n=== 6. 过期后调用被拒 ===')
await api('task-grant-set', {
  taskId: 'poc-grant-1',
  allowedTools: ['read_file'],
  workDir: approved,
  expiresAt: new Date(Date.now() - 1000).toISOString(),
})
const expired = await check('read_file', { path: join(approved, 'q4.csv') })
console.log(`  allowed=${expired.allowed}`)
console.log(`     → ${expired.reason}`)
