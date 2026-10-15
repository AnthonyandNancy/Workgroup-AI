// F-07 verified through the PRODUCT's own profile, not a hand-linked bench profile.
//
// The earlier F-07 evidence ran against `dev/bench.sh`, which wrote
// `"ds-bot": "link:<checkout>"` into the profile and ran `pnpm install`. That step supplied a
// resolution the shipped product never had, which is why a bundle that could not be resolved
// still looked like a passing navigation entry. This script instead starts the product's own
// `dsh web` against a clean home: the profile comes from `PROFILE_TEMPLATES.web` and the only
// resolver is the dsh installation anchor. If the entry is present here, it is present for a user.
//
// Usage: node app-f07-product-ui-check.mjs <dsh-repo> <login-url> <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const [repo, loginUrl, outDir] = process.argv.slice(2)
if (!repo || !loginUrl || !outDir) {
  console.error('usage: node app-f07-product-ui-check.mjs <dsh-repo> <login-url> <out-dir>')
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
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, locale: 'en-US' })
await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 })
// The first paint may still be the boot splash; the shell and the plugin apply afterwards.
await page.waitForTimeout(12_000)

// A fresh home shows the preview notice over the shell. Dismiss it so the navigation is
// clickable; the notice is not part of what this check measures. The mask is removed rather
// than clicked away, because the same presentation root also covers dialogs.
const dismissed = await page.evaluate(() => {
  let clicked = false
  for (const button of document.querySelectorAll('button')) {
    if (/^(continue|ok|got it)$/i.test((button.textContent ?? '').trim())) {
      button.click()
      clicked = true
      break
    }
  }
  return clicked
})
await page.waitForTimeout(1500)
await page.evaluate(() => {
  for (const mask of document.querySelectorAll('[class*="_mask_"], [role="presentation"]')) mask.remove()
})
console.log('preview notice dismissed:', dismissed)

// The first-level navigation rows, in order. Each row is a button carrying its label.
const rowLabels = await page.$$eval('nav button', rows => rows
  .map(row => (row.getAttribute('aria-label') ?? row.textContent ?? '').trim())
  .filter(label => label.length > 0))

console.log('first-level rows:', JSON.stringify(rowLabels))
const pluginsIndex = rowLabels.findIndex(label => label === 'Plugins')
const botIndex = rowLabels.findIndex(label => label === 'Bot')

check(pluginsIndex >= 0, `the Plugins entry is present (index ${pluginsIndex})`)
check(botIndex >= 0, `a Bot entry is present (index ${botIndex})`)
check(botIndex >= 0 && pluginsIndex >= 0 && botIndex === pluginsIndex + 1,
  `Bot is directly below Plugins (Plugins=${pluginsIndex}, Bot=${botIndex})`)
check(rowLabels.filter(label => label === 'Bot').length === 1,
  `there is exactly one Bot entry (found ${rowLabels.filter(label => label === 'Bot').length})`)
for (const forbidden of ['Chief', 'Writer', 'Coder', 'Group chats', 'Chats', 'Bots']) {
  check(!rowLabels.includes(forbidden), `the first-level navigation has no "${forbidden}" entry`)
}

await page.screenshot({ path: join(outDir, 'f07-product-navigation.png') })

// Entering the Bot entry must mount the team surface on the real Conversation.
if (botIndex >= 0) {
  await page.click('nav button >> nth=' + botIndex)
  await page.waitForTimeout(2500)
  const state = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-wg-bot-panel'),
    teamRows: document.querySelectorAll('[class*="_btRow"],[class*="bt-row"]').length,
    hasComposer: !!document.querySelector('textarea'),
  }))
  console.log('after Bot click:', JSON.stringify(state))
  check(state.attr === 'on', 'entering the Bot entry mounts the team surface (attribute set)')
  await page.screenshot({ path: join(outDir, 'f07-product-bot-panel.png') })

  // Leaving the entry must withdraw it and leave the shell's own navigation intact.
  const pluginsRowIndex = rowLabels.findIndex(label => label === 'Plugins')
  await page.click('nav button >> nth=' + pluginsRowIndex)
  await page.waitForTimeout(2500)
  const after = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-wg-bot-panel'),
    navCount: document.querySelectorAll('nav button').length,
  }))
  console.log('after Plugins click:', JSON.stringify(after))
  check(after.attr === null, 'leaving the Bot entry withdraws the team surface')
  check(after.navCount === rowLabels.length, `the first-level navigation is intact (${after.navCount} rows)`)
  await page.screenshot({ path: join(outDir, 'f07-product-back-to-plugins.png') })
}

await browser.close()

const failed = results.filter(([passed]) => !passed)
console.log('')
console.log(`f07 product ui: ${results.length - failed.length}/${results.length} checks passed`)
writeFileSync(join(outDir, 'f07-product-ui.json'), JSON.stringify({ rows: rowLabels, results }, undefined, 2))
process.exit(failed.length === 0 ? 0 : 1)
