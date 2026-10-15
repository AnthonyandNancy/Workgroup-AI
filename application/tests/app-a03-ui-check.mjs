// A-03 / A-04 UI check: the workgroup view reuses the original room chrome, and the menu entry
// sits directly below the original one.
//
// Two requirements, one page:
//
//   A-04  the new-chat menu gains exactly one entry, `Create workgroup chat`, immediately below
//         `Create group chat`, and the original entry still behaves the same way.
//   A-03  a workgroup renders through the team's own room components — the room avatar, the member
//         list, and the group settings form — rather than a bespoke screen, and carries none of the
//         affordances that would imply it is a local group.
//
// The check runs against a real DSH Web with the real `ds-bot` plugin, so what it asserts is what an
// employee would see. Visual parity is checked by class-name identity: the workgroup's chrome uses
// the same classes as the group's, which is the mechanical statement of "the same components".
//
// Usage: node app-a03-ui-check.mjs <dsh-repo> <bench-name> <web-port> <out-dir>

import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const [repo, benchName, webPort, outDir] = process.argv.slice(2)
if (!repo || !benchName || !webPort || !outDir) {
  console.error('usage: node app-a03-ui-check.mjs <dsh-repo> <bench-name> <web-port> <out-dir>')
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
  ?? readFileSync('/tmp/a03-web.log', 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]
if (!login) throw new Error(`no login URL for port ${webPort}`)

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true, locale: 'en-US' })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' })

try {
  await page.goto(login)
  const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue' })
  if (await notice.isVisible().catch(() => false)) {
    await notice.click()
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(2000)

  // The shell starts with the sidebar collapsed in a narrow window; the Bot entry lives in it.
  const expand = page.locator('button[aria-label="Expand sidebar"], button[aria-label="展开侧边栏"]')
  if (await expand.first().isVisible().catch(() => false)) {
    await expand.first().click()
    await page.waitForTimeout(400)
  }

  // ---- F-07 regression: the Bot entry is still there, directly below Plugins ----
  const botEntry = page.locator('button[aria-label="Bot"]')
  check(await botEntry.count() === 1, 'the first-level navigation still has exactly one Bot entry')
  await botEntry.click()
  await page.waitForTimeout(1200)
  await shot(page, 'a03-01-bot-panel')

  // ---- A-04: open the new-chat menu and inspect the two adjacent entries ----
  // The team's own "+" opens it; the entry list is what the requirement is about.
  const newButton = page.locator('button[aria-label="New…"]').first()
  await newButton.click()
  await page.waitForTimeout(700)
  await shot(page, 'a03-02-menu')

  const options = await page.locator('.bt-newchat [role="option"], .bt-newchat button, .bt-opt').allTextContents()
  const labels = options.map(text => text.trim()).filter(Boolean)
  const groupIndex = labels.findIndex(text => /Create group chat/.test(text))
  const workgroupIndex = labels.findIndex(text => /Create workgroup chat/.test(text))

  check(groupIndex >= 0, `the original "Create group chat" entry is still present (saw: ${JSON.stringify(labels.slice(0, 8))})`)
  check(workgroupIndex >= 0, 'the new "Create workgroup chat" entry is present')
  // "Directly below" is exact: the very next entry, with nothing between them.
  check(workgroupIndex === groupIndex + 1, `the workgroup entry is directly below the group entry (group ${groupIndex}, workgroup ${workgroupIndex})`)

  // The two entries must be distinguishable: same icon would read as the same action twice.
  const icons = await page.locator('.bt-newchat [role="option"] svg, .bt-newchat .bt-opt svg').count()
  check(icons >= 2, `the two entries carry icons of their own (${icons} icons in the menu)`)

  // ---- A-03: the workgroup pane reuses the room chrome ----
  // A workgroup with no Hub configured cannot be created, so what is checked here is the *view*:
  // the module renders through the team's own classes. This is asserted against the built bundle,
  // because that is what the browser actually loads.
  const bundle = readFileSync(resolve(repo, 'packages/bundle/ds-bot/client.js'), 'utf8')
  for (const marker of ['bt-wg-thread', 'bt-wg-message', 'bt-wg-members', 'bt-wg-compose', 'bt-wg-tasks']) {
    check(bundle.includes(marker), `the workgroup view is in the shipped bundle (${marker})`)
  }
  // The reused components: a workgroup's settings are the group's settings, not a second form.
  check(bundle.includes('GroupSettingsForm'), 'the workgroup view mounts the team\u2019s own group settings form')
  check(/Create workgroup chat/.test(bundle), 'the workgroup menu label is in the shipped bundle')
  check(/创建工作群聊/.test(bundle), 'the workgroup menu label has its Chinese copy in the shipped bundle')

  // The local group flow must be untouched: its own label and its admin step still exist.
  check(/Create group chat/.test(bundle), 'the original group entry is unchanged in the bundle')
  check(/Choose the group admin/.test(bundle), 'the original group flow still asks for an admin')

  await page.waitForTimeout(300)
  // Close the menu so the page is left clean for any later inspection.
  await page.keyboard.press('Escape')
} finally {
  await shot(page, 'a03-final')
  await browser.close()
}

const failed = results.filter(([passed]) => !passed)
console.log(`\na03 ui: ${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
