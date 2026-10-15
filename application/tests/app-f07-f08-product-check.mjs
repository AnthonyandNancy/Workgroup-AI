// F-07 + F-08 through the PRODUCT's own application: the entry sits directly below Plugins, and
// entering it keeps the original team interface intact.
//
// F-07 requires one Bot entry directly beneath Plugins. F-08 requires that entering it preserves
// the original Chief / member Bots / private chats / group chats surface — so this checks the
// entry's position AND that the team's own regions actually mount, rather than only that a click
// sets an attribute.
//
// Usage: node app-f07-f08-product-check.mjs <dsh-repo> <login-url> <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const [repo, loginUrl, outDir] = process.argv.slice(2)
if (!repo || !loginUrl || !outDir) {
  console.error('usage: node app-f07-f08-product-check.mjs <dsh-repo> <login-url> <out-dir>')
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
page.on('pageerror', error => console.log(`[pageerror] ${String(error.message).split('\n')[0]}`))

await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForTimeout(14_000)

// A fresh home shows the preview notice over the shell; dismiss it so the rows are clickable.
await page.evaluate(() => {
  for (const button of document.querySelectorAll('button')) {
    if (/^(continue|ok|got it)$/i.test((button.textContent ?? '').trim())) { button.click(); return }
  }
})
await page.waitForTimeout(1500)
await page.evaluate(() => {
  for (const node of document.querySelectorAll('[class*="_mask_"], [role="presentation"]')) node.remove()
})

// ---------------------------------------------------------------- F-07

const rowLabels = await page.$$eval('nav button', rows => rows
  .map(row => (row.getAttribute('aria-label') ?? row.textContent ?? '').trim())
  .filter(label => label.length > 0))
console.log('first-level rows:', JSON.stringify(rowLabels))

const pluginsIndex = rowLabels.indexOf('Plugins')
const botIndex = rowLabels.indexOf('Bot')
check(pluginsIndex >= 0, `the Plugins entry is present (index ${String(pluginsIndex)})`)
check(botIndex >= 0, `a Bot entry is present (index ${String(botIndex)})`)
check(botIndex === pluginsIndex + 1, `Bot sits directly below Plugins (Plugins=${String(pluginsIndex)}, Bot=${String(botIndex)})`)
check(rowLabels.filter(label => label === 'Bot').length === 1, 'there is exactly one Bot entry')
for (const forbidden of ['Chief', 'Writer', 'Coder', 'Group chats', 'Chats', 'Bots', 'Workgroups']) {
  check(!rowLabels.includes(forbidden), `the first-level navigation promotes no "${forbidden}" entry`)
}
await page.screenshot({ path: join(outDir, 'f07-entry-below-plugins.png') })

// ---------------------------------------------------------------- F-08

await page.click(`nav button >> nth=${String(botIndex)}`)
await page.waitForTimeout(4000)

const surface = await page.evaluate(() => {
  const text = document.body.innerText
  return {
    panelAttribute: document.documentElement.getAttribute('data-wg-bot-panel'),
    // The team's own regions: Chief card, the Bot list area, and the chat composer. DS Bot's
    // composer is a `contenteditable` textbox, not a `textarea`, and this is the same selector
    // its own module uses to find the shell's input.
    hasChief: /Chief/.test(text),
    hasChiefRole: /Chief of Staff/i.test(text),
    hasComposer: Boolean(document.querySelector('[role=textbox][contenteditable=true]')),
    hasTeamSidebar: document.querySelectorAll('[class*="bt-"],[class*="_bt"]').length,
    mentionsSetup: /set (?:a model|one) up|Sign in to DeepSeek|API key/i.test(text),
  }
})
console.log('team surface:', JSON.stringify(surface))

check(surface.panelAttribute === 'on', 'entering the Bot entry mounts the team surface')
check(surface.hasChief, "the original team shows its Chief")
check(surface.hasChiefRole, "Chief keeps the role label from the original interface")
check(surface.hasComposer, 'the real conversation composer is present inside the Bot entry')
check(surface.hasTeamSidebar > 0, 'the team interface renders its own components, not a plain session')
check(surface.mentionsSetup, 'the Chief offers its own setup actions (model / sign-in)')
await page.screenshot({ path: join(outDir, 'f08-team-surface.png') })

// The entry must open the real Conversation, so the header carries the session controls a plain
// replacement chat would not have.
const realConversation = await page.evaluate(() => ({
  header: Boolean(document.querySelector('header')),
  hasModelPicker: /Standard mode|deepseek/i.test(document.body.innerText),
}))
console.log('conversation binding:', JSON.stringify(realConversation))
check(realConversation.hasModelPicker, 'the entry selected the shell\'s real Conversation (model controls present)')

// ---------------------------------------------------------------- leaving withdraws it

await page.click(`nav button >> nth=${String(pluginsIndex)}`)
await page.waitForTimeout(3000)
const after = await page.evaluate(() => ({
  panelAttribute: document.documentElement.getAttribute('data-wg-bot-panel'),
  navCount: document.querySelectorAll('nav button').length,
  teamNodes: document.querySelectorAll('[class*="bt-"],[class*="_bt"]').length,
}))
console.log('after leaving:', JSON.stringify(after))
check(after.panelAttribute === null, 'leaving the entry withdraws the team surface')
check(after.teamNodes === 0, 'no Bot UI remains on the Plugins page')
check(after.navCount === rowLabels.length, `the first-level navigation is intact (${String(after.navCount)} rows)`)
await page.screenshot({ path: join(outDir, 'f09-back-on-plugins.png') })

await browser.close()

const failed = results.filter(([passed]) => !passed)
console.log('')
console.log(`f07/f08 product: ${String(results.length - failed.length)}/${String(results.length)} checks passed`)
writeFileSync(join(outDir, 'f07-f08-product.json'), `${JSON.stringify({ rows: rowLabels, surface, after, results }, undefined, 2)}\n`)
process.exit(failed.length === 0 ? 0 : 1)
