// Static files for the local-demo admin web.
//
// There are exactly three files, so explicit routes are safer and simpler than a directory
// handler: no wildcard, no path traversal, and no dependency beyond Node's own fs. The page is
// deliberately build-free so `server/` remains independently deployable.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../../web/admin/', import.meta.url))
const FILES = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'],
  ['style.css', 'text/css; charset=utf-8'],
])

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
}

async function sendFile(reply, name) {
  const type = FILES.get(name)
  if (type === undefined) return reply.code(404).send('Not found')
  try {
    const body = await readFile(join(ROOT, name))
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) reply.header(header, value)
    return reply.type(type).send(body)
  } catch {
    return reply.code(404).send('Not found')
  }
}

export function registerAdminWeb(server) {
  server.get('/admin', async (request, reply) => reply.code(302).header('location', '/admin/').send())
  server.get('/admin/', async (request, reply) => sendFile(reply, 'index.html'))
  server.get('/admin/index.html', async (request, reply) => sendFile(reply, 'index.html'))
  server.get('/admin/app.js', async (request, reply) => sendFile(reply, 'app.js'))
  server.get('/admin/style.css', async (request, reply) => sendFile(reply, 'style.css'))
}
