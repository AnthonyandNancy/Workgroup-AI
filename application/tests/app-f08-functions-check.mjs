// F-08 deeper: the Bot entry keeps the original team interface usable.
//
// A rendered Chief proves the team mounted; F-08 also requires that the original surface stays
// usable inside it. This drives the team's own controls — located by the `bt-` class prefix its
// components actually carry, never by "the first button with an svg", which in a collapsed rail
// is the shell's own toggle.
//
// Usage: node app-f08-functions-check.mjs <dsh-repo> <login-url> <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const [repo, loginUrl, outDir] = process.argv.slice(2)
if (!repo || !loginUrl || !outDir) {
  console.error('usage: node app-f08-functions-check.mjs <dsh-repo> <login-url> <out-dir>')
  process.exit(2)
}

const require = createRequire(join(resolve(repo), 'package.json'))
const { chromium } = require(require.resolve('playwright-core', {
  paths: [join(resolve(repo), 'node_modules', '.pnpm', 'node_modules')],
}))

const results = []
const check = (passed, label) => {
  results.push([passed, label])
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${label}`)
}

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, locale: 'en-US' })

await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForTimeout(14_000)
await page.evaluate(() => {
  for (const button of document.querySelectorAll('button')) {
    if (/^(continue|ok|got it)$/i.test((button.textContent ?? '').trim())) { button.click(); return }
  }
})
await page.waitForTimeout(1500)
await page.evaluate(() => {
  for (const node of document.querySelectorAll('[class*="_mask_"], [role="presentation"]')) node.remove()
})

const rows = await page.$$eval('nav button', nodes => nodes.map(node => (node.getAttribute('aria-label') ?? node.textContent ?? '').trim()))
await page.click(`nav button >> nth=${String(rows.indexOf('Bot'))}`)
await page.waitForTimeout(4000)

// --- the team's own surface, located by its real class prefix ------------------------------

const surface = await page.evaluate(() => {
  const team = document.querySelectorAll('[class*="bt-"]').length
  const text = document.body.innerText
  return {
    teamNodes: team,
    // The team's regions that the original interface always carries.
    hasTeamSidebar: team > 0,
    hasChiefCard: Boolean([...document.querySelectorAll('[class*="bt-"]')]
      .find(node => /Chief of Staff/i.test(node.textContent ?? ''))),
    hasComposer: Boolean(document.querySelector('[role=textbox][contenteditable=true]')),
    hasSettingsEntry: /Settings/i.test(text),
    // Group chats and the workgroup entry live in the new-chat menu that the team renders.
    hasGroupCopy: /Create group chat/i.test(text),
    hasWorkgroupCopy: /Create workgroup chat/i.test(text),
  }
})
console.log('team surface:', JSON.stringify(surface))
check(surface.hasTeamSidebar, `the team renders its own components (${String(surface.teamNodes)} nodes)`)
check(surface.hasChiefCard, 'the original Chief card is present with its role label')
check(surface.hasComposer, 'the team composer is present')
check(surface.hasSettingsEntry, 'the team exposes its Settings surface')
await page.screenshot({ path: join(outDir, 'f08-team-surface.png') })

// The new-chat menu is what carries "Create group chat" and "Create workgroup chat". Open it the
// way the interface exposes it: the team list header's create control.
const opened = await page.evaluate(() => {
  // The team's create control carries `bt-` classes; the shell's rail toggle does not.
  const candidate = [...document.querySelectorAll('button[class*="bt-"]')]
    .find(button => /new|add|create/i.test(`${button.className} ${button.getAttribute('aria-label') ?? ''} ${button.title ?? ''}`))
  if (!candidate) return null
  candidate.click()
  return String(candidate.className)
})
await page.waitForTimeout(1500)
const menu = await page.evaluate(() => {
  const text = document.body.innerText
  return {
    hasGroupChat: /Create group chat/i.test(text),
    hasWorkgroupChat: /Create workgroup chat/i.test(text),
    dialogOpen: Boolean(document.querySelector('[class*="bt-newchat"], [role="dialog"]')),
  }
})
console.log('create control:', JSON.stringify({ opened, ...menu }))
check(opened !== null, `the team list exposes its create control (${String(opened)})`)
check(menu.hasGroupChat, 'the original "Create group chat" entry is available')
check(menu.hasWorkgroupChat, 'the fork\'s "Create workgroup chat" sits beside it')
await page.screenshot({ path: join(outDir, 'f08-create-menu.png') })

await browser.close()

const failed = results.filter(([passed]) => !passed)
console.log('')
console.log(`f08 functions: ${String(results.length - failed.length)}/${String(results.length)} checks passed`)
writeFileSync(join(outDir, 'f08-functions.json'), `${JSON.stringify({ surface, menu, results }, undefined, 2)}\n`)
process.exit(failed.length === 0 ? 0 : 1)
