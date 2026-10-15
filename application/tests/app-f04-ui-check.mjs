// F-04 UI check: the original DS Bot interface inside a real DSH Web profile.
//
// DS Bot's own dev/ui-shots.mjs drives the whole screenshot tour, but its locators are
// English aria-labels and it launches Chrome with the machine's locale (zh-CN here), so
// the run stalls at the first label that came back translated. This check drives the same
// real stack and asserts the same navigation without screenshotting every screen: it
// launches Chromium with locale en-US and verifies the Bot surface, Chief's private chat,
// an ordinary group chat and the Bot settings/detail panels actually render and respond.
//
// Usage: node app-f04-ui-check.mjs <dsh-repo> <bench-name> <web-port> <out-dir>

import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const [repo, benchName, webPort, outDir] = process.argv.slice(2)
if (!repo || !benchName || !webPort || !outDir) {
  console.error('usage: node app-f04-ui-check.mjs <dsh-repo> <bench-name> <web-port> <out-dir>')
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

// The bench home and its web.log both live beside the plugin package.
const benchRoot = resolve(repo, 'packages/bundle/ds-bot/.dsh-test-' + benchName)
const log = readFileSync(join(benchRoot, 'web.log'), 'utf8')
const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]
if (!login) throw new Error(`no login URL in ${join(benchRoot, 'web.log')}`)

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  headless: true,
  // Force the interface language the DS Bot locators and the upstream checks assume.
  locale: 'en-US',
})
const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, locale: 'en-US' })

try {
  await page.goto(login)

  // dsh shows a preview notice until it is dismissed once per profile.
  const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue' })
  const dismiss = async () => {
    if (await notice.isVisible().catch(() => false)) {
      await notice.click()
      await page.waitForTimeout(500)
    }
  }
  await page.waitForTimeout(1200)
  await dismiss()

  // Workgroup AI fork: the team surface is no longer painted over the shell. It appears when the
  // Bot entry is selected, so this check enters the Bot page first — the same step a user takes.
  const botEntry = page.locator('button[aria-label="Bot"]').first()
  if (await botEntry.isVisible().catch(() => false)) {
    await botEntry.click()
    await dismiss()
    await page.waitForTimeout(2000)
  }

  // 1. The Bot entry shows DS Bot's own sidebar, in place of the workspace list.
  const teamList = page.locator('.bt-row, .bt-tile')
  check(await teamList.first().waitFor({ timeout: 30_000 }).then(() => true, () => false), 'the DS Bot team sidebar renders inside the Bot page')
  await dismiss()
  await page.waitForTimeout(400)
  await shot(page, 'f04-01-team')

  const botNames = await page.locator('.bt-row .bt-name, .bt-row').allInnerTexts()
  const flat = botNames.join(' | ')
  check(/Chief/.test(flat), `Chief is present in the Bot list (${flat.slice(0, 80)})`)

  const state = JSON.parse(readFileSync(join(benchRoot, 'bot', 'state.json'), 'utf8'))
  const chief = Object.values(state.bots).find(bot => bot.name === 'Chief')
  const writer = Object.values(state.bots).find(bot => bot.name === 'Writer')
  // An ordinary group chat is any room with more than one Bot member.
  const group = Object.values(state.rooms).find(room => (room.members ?? []).length > 1)
  check(chief !== undefined, 'state.json holds a real Chief Bot')
  // A Bot's `id` is stable and `sessionId` is its current Session; the first Session of a
  // Bot reuses the id, so the effective Session id falls back to it. This mapping is what
  // F-11 must persist across a store rebuild.
  const chiefSession = chief?.sessionId ?? chief?.id
  check(typeof chiefSession === 'string' && chiefSession.length > 0, `Chief resolves to a Session id (${String(chiefSession).slice(0, 24)}…)`)
  check(writer !== undefined, 'a second Bot (Writer) exists')
  check(group !== undefined, `an ordinary group chat exists with ${group?.members?.length ?? 0} Bot members`)

  // 2. Chief's private chat: opening the row shows the conversation and the composer.
  // The Main Bot renders as a tile in the sidebar header, other Bots as rows; the
  // data-bot-id attribute is what both carry, so the check keys off it alone.
  //
  // The composer itself is DSH's own contenteditable chat input, which DS Bot reuses
  // rather than replacing; its class is hashed by the client build, so the check keys
  // off the role and the placeholder instead of a class name.
  const chiefRow = `[data-bot-id="${chief.id}"]`
  await page.locator(chiefRow).first().waitFor({ timeout: 30_000 })
  await page.locator(chiefRow).first().click()
  await dismiss()
  await page.waitForTimeout(2000)
  const composer = page.locator('[contenteditable="true"]').first()
  check(await composer.waitFor({ timeout: 20_000 }).then(() => true, () => false), "Chief's private chat shows the DSH composer")
  check(await page.locator('.bt-msg').first().waitFor({ timeout: 20_000 }).then(() => true, () => false), "Chief's private chat renders Bot messages through DS Bot's own bubbles")
  await shot(page, 'f04-02-chief-chat')

  // 3. The details panel and the model picker — the UI the F-07/F-08 work must keep.
  // The panel's outer <aside class="bt-panel"> stays hidden until the grip opens it; the
  // visible container is .bt-panel-view, so the check waits on the inner element.
  const details = page.getByRole('button', { name: 'View conversation details' }).first()
  const detailsShown = await details.waitFor({ timeout: 20_000 }).then(() => true, () => false)
  check(detailsShown, 'the conversation-details control is present in English')
  if (detailsShown) {
    await details.click()
    const trigger = page.locator('.bt-model-trigger').first()
    check(await trigger.waitFor({ timeout: 15_000 }).then(() => true, () => false), 'the details panel shows the model picker')
    const modelName = await page.locator('.bt-model-name').first().innerText().catch(() => '')
    check(modelName.trim().length > 0, `the model picker names a model (${modelName.trim()})`)
    await shot(page, 'f04-03-details')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  // 4. The ordinary group chat renders with its members.
  const groupRow = `[data-room-id="${group.id}"]`
  await page.locator(groupRow).first().waitFor({ timeout: 20_000 })
  await page.locator(groupRow).first().click()
  await dismiss()
  await page.waitForTimeout(2000)
  const groupComposer = page.locator('[contenteditable="true"]').first()
  check(await groupComposer.waitFor({ timeout: 20_000 }).then(() => true, () => false), 'the ordinary group chat shows the DSH composer')
  check(await page.locator('.bt-msg').first().waitFor({ timeout: 20_000 }).then(() => true, () => false), 'the ordinary group chat renders its message history')
  await shot(page, 'f04-04-group-chat')

  // 5. The "Create group chat" entry the workgroup feature must sit below. It lives in
  // the sidebar's "New…" menu, so the check opens that menu and looks for the item.
  const newButton = page.locator('.bt-round').first()
  check(await newButton.waitFor({ timeout: 15_000 }).then(() => true, () => false), 'the sidebar "new" control is present')
  await newButton.click()
  await page.waitForTimeout(800)
  const createGroup = page.getByText('Create group chat', { exact: true }).first()
  const createVisible = await createGroup.isVisible().catch(() => false)
  check(createVisible, 'the original "Create group chat" entry is reachable from the new-chat menu')
  await shot(page, 'f04-05-new-menu')
} finally {
  await browser.close()
}

const failed = results.filter(([passed]) => !passed)
console.log(`\nf04 ui: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const [, label] of failed) console.log(`failed: ${label}`)
  process.exit(1)
}
