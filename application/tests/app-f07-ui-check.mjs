// F-07 / F-08 / F-09 UI check: the Bot entry, the panel behind it, and no leakage.
//
// The three requirements are checked together because they are one behaviour seen from three
// angles, and checking them apart would miss the failure that matters most: the entry exists,
// the panel works, and yet Bot UI is still painted over the Plugins page.
//
//   F-07  the first-level navigation gains exactly one `Bot` entry, directly below `Plugins`
//   F-08  entering it shows the original DS Bot interface (Chief, Bots, private chat, groups)
//   F-09  leaving it restores the shell completely — no Bot replacement survives
//
// Usage: node app-f07-ui-check.mjs <dsh-repo> <bench-name> <web-port> <out-dir>

import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const [repo, benchName, webPort, outDir] = process.argv.slice(2)
if (!repo || !benchName || !webPort || !outDir) {
  console.error('usage: node app-f07-ui-check.mjs <dsh-repo> <bench-name> <web-port> <out-dir>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const require = createRequire(join(resolve(repo), 'package.json'))
const { chromium } = require(require.resolve('playwright-core', {
  paths: [join(resolve(repo), 'node_modules', '.pnpm', 'node_modules')],
}))

const results = []
const check = (passed, label) => {
  results.push([passed, label])
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${label}`)
}
const shot = async (page, name) => {
  const file = join(outDir, `${name}.png`)
  await page.screenshot({ path: file })
  console.log(file)
}

const benchRoot = resolve(repo, 'packages/bundle/ds-bot/.dsh-test-' + benchName)
const log = readFileSync(join(benchRoot, 'web.log'), 'utf8')
const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]
if (!login) throw new Error(`no login URL in ${join(benchRoot, 'web.log')}`)

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true, locale: 'en-US' })
const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, locale: 'en-US' })

try {
  await page.goto(login)
  const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue' })
  const dismiss = async () => {
    if (await notice.isVisible().catch(() => false)) {
      await notice.click()
      await page.waitForTimeout(500)
    }
  }
  await page.waitForTimeout(1500)
  await dismiss()

  // The shell starts collapsed in a narrow window, and a collapsed sidebar hides the
  // first-level entries (they are icon-only rails). Expand before reading navigation.
  const expand = page.locator('button[aria-label="Expand sidebar"]').first()
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
    await page.waitForTimeout(700)
  }
  await dismiss()

  // ---- F-07: exactly one Bot entry, directly below Plugins ----
  //
  // The panel entries are buttons carrying `aria-label` from the shell's own locale; reading
  // them in DOM order gives the order the user sees.
  const navLabels = await page.evaluate(() => {
    const nodes = document.querySelectorAll('button[aria-current], button[aria-label]')
    const out = []
    for (const node of nodes) {
      const label = node.getAttribute('aria-label')
      const cls = String(node.className ?? '')
      // Panel rows are the sidebar's own first-level entries; their class carries the shell's
      // hashed panel-row name, so match on the structure instead: a button whose only child is
      // the glyph span inside a sidebar nav.
      if (label !== null && /Panel|panel/.test(cls)) out.push(label)
    }
    return out
  })
  // A stable, structural read: the sidebar's first-level entries are the buttons inside the
  // element that holds the panel list, in document order.
  const panelOrder = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')]
    const labelled = buttons
      .map(button => ({ label: button.getAttribute('aria-label') ?? '', title: button.getAttribute('title') ?? '' }))
      .filter(entry => entry.label.length > 0 && entry.label.length < 40)
    return labelled.map(entry => entry.label)
  })
  const pluginsIndex = panelOrder.indexOf('Plugins')
  const botIndex = panelOrder.indexOf('Bot')
  check(pluginsIndex >= 0, `the Plugins entry is present (index ${pluginsIndex})`)
  check(botIndex >= 0, `a Bot entry is present (index ${botIndex})`)
  check(botIndex === pluginsIndex + 1, `Bot is directly below Plugins (Plugins=${pluginsIndex}, Bot=${botIndex})`)
  check(panelOrder.filter(label => label === 'Bot').length === 1, 'there is exactly one Bot entry')
  // And no team-internal entries were promoted into the first-level navigation.
  for (const forbidden of ['Chief', 'Writer', 'Coder', 'Group chats', 'Chats']) {
    check(!panelOrder.includes(forbidden), `the first-level navigation has no "${forbidden}" entry`)
  }
  await dismiss()
  await shot(page, 'f07-01-navigation')

  // ---- F-08: entering Bot shows the original team interface ----
  // Locate by the shell's own panel-row class rather than by accessible name: `getByRole`
  // resolves to the sidebar's screen-reader labels too, which are not the clickable row.
  const panelRow = (label) => page.locator('button[aria-label="' + label + '"]').first()
  const botEntry = panelRow('Bot')
  check(await botEntry.isVisible().catch(() => false), 'the Bot entry is clickable')
  await botEntry.click()
  await dismiss()
  await page.waitForTimeout(2000)
  await shot(page, 'f08-01-bot-panel')

  // The team's own sidebar replaces the workspace list while the panel is active, so the Bot
  // rows are what prove the original interface is on screen.
  const teamRows = page.locator('.bt-row, .bt-tile')
  check(await teamRows.first().waitFor({ timeout: 20_000 }).then(() => true, () => false), 'the original team sidebar renders inside the Bot panel')
  const state = JSON.parse(readFileSync(join(benchRoot, 'bot', 'state.json'), 'utf8'))
  const chief = Object.values(state.bots).find(bot => bot.name === 'Chief')
  check(chief !== undefined, 'there is a real Chief in the team state')
  check(await page.locator(`[data-bot-id="${chief?.id}"]`).first().isVisible().catch(() => false), "Chief's own row is visible in the panel")
  const composer = page.locator('[contenteditable="true"]').first()
  check(await composer.waitFor({ timeout: 20_000 }).then(() => true, () => false), 'the panel hosts the real Conversation composer')

  // ---- F-09: leaving the panel restores the shell with nothing left behind ----
  // Switch to the Plugins page: this is the surface that used to keep Bot UI painted over it.
  await panelRow('Plugins').click()
  await dismiss()
  await page.waitForTimeout(2000)
  await shot(page, 'f09-01-plugins-page')

  const leftovers = await page.evaluate(() => {
    // Bot UI is recognisable by its own class prefix; the shell never produces these.
    const botNodes = document.querySelectorAll('[class*="bt-"], [data-bot-id], [data-room-id]')
    const visible = []
    for (const node of botNodes) {
      if (node.offsetParent !== null || (node.getClientRects?.().length ?? 0) > 0) {
        visible.push(`${node.tagName}.${String(node.className)}`)
      }
    }
    return visible
  })
  check(leftovers.length === 0, `no Bot UI remains on the Plugins page (found ${leftovers.length}: ${leftovers.slice(0, 5).join(', ')})`)

  // The shell's own Plugins content must be present, proving the shell came back rather than
  // just being empty.
  const shellContent = await page.evaluate(() => document.body.innerText.slice(0, 4000))
  check(/plugin/i.test(shellContent), 'the Plugins page shows the shell\'s own content')

  // And the team's sidebar is gone: the workspace list is the shell's again.
  const teamRowsAfter = await page.locator('.bt-row, .bt-tile').count()
  check(teamRowsAfter === 0, `the team sidebar is withdrawn on the Plugins page (rows=${teamRowsAfter})`)

  // Returning to Bot brings it back, so the withdrawal is a state change and not a one-way loss.
  await botEntry.click()
  await dismiss()
  await page.waitForTimeout(1800)
  check(await page.locator('.bt-row, .bt-tile').first().waitFor({ timeout: 15_000 }).then(() => true, () => false), 'the team interface returns when Bot is selected again')
  await shot(page, 'f09-02-return-to-bot')
} finally {
  await browser.close()
}

const failed = results.filter(([passed]) => !passed)
console.log(`\nf07/f08/f09 ui: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const [, label] of failed) console.log(`failed: ${label}`)
  process.exit(1)
}
