// Inspect the live DS Bot DOM so the F-04 checks key off the classes the UI actually
// renders, instead of classes guessed from source. Read-only: it navigates and prints.
//
// Usage: node app-f04-probe.mjs <dsh-repo> <bench-name> <web-port>

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const [repo, benchName, webPort] = process.argv.slice(2)
const require = createRequire(join(resolve(repo), 'package.json'))
const { chromium } = require(require.resolve('playwright-core', {
  paths: [join(resolve(repo), 'node_modules', '.pnpm', 'node_modules')],
}))

const benchRoot = resolve(repo, 'packages/bundle/ds-bot/.dsh-test-' + benchName)
const login = readFileSync(join(benchRoot, 'web.log'), 'utf8')
  .match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true, locale: 'en-US' })
const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, locale: 'en-US' })
try {
  await page.goto(login)
  await page.waitForTimeout(1500)
  const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue' })
  if (await notice.isVisible().catch(() => false)) { await notice.click(); await page.waitForTimeout(500) }

  const state = JSON.parse(readFileSync(join(benchRoot, 'bot', 'state.json'), 'utf8'))
  const chief = Object.values(state.bots).find(bot => bot.name === 'Chief')

  await page.locator(`[data-bot-id="${chief.id}"]`).first().click()
  await page.waitForTimeout(2000)

  console.log('=== textarea / input attributes on the chat page ===')
  console.log(JSON.stringify(await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('textarea, input[type=text], [contenteditable=true]')) {
      out.push({
        tag: el.tagName,
        className: el.className,
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        contentEditable: el.getAttribute('contenteditable'),
        visible: el.offsetParent !== null,
      })
    }
    return out
  }), null, 1))

  console.log('=== elements whose class starts with bt- and look like a composer ===')
  console.log(JSON.stringify(await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('[class*="composer"], [class*="bt-"]')) {
      const cls = String(el.className)
      if (/composer|input|box/i.test(cls)) out.push({ tag: el.tagName, className: cls, visible: el.offsetParent !== null })
    }
    return out.slice(0, 40)
  }), null, 1))

  console.log('=== top-level bt- containers ===')
  console.log(JSON.stringify(await page.evaluate(() => {
    const seen = new Map()
    for (const el of document.querySelectorAll('[class*="bt-"]')) {
      const top = String(el.className).split(/\s+/).find(c => c.startsWith('bt-'))
      if (top && !seen.has(top)) seen.set(top, el.tagName)
    }
    return [...seen.entries()].slice(0, 60)
  }), null, 1))

  console.log('=== details-panel open control ===')
  await page.locator(`[data-bot-id="${chief.id}"]`).first().click()
  await page.waitForTimeout(800)
  const details = page.getByRole('button', { name: 'View conversation details' }).first()
  console.log('details visible:', await details.isVisible().catch(() => false))
  if (await details.isVisible().catch(() => false)) {
    await details.click()
    await page.waitForTimeout(1200)
    console.log(JSON.stringify(await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('[class*="bt-panel"], [class*="bt-model"]')) {
        out.push({ tag: el.tagName, className: String(el.className), visible: el.offsetParent !== null })
      }
      return out.slice(0, 30)
    }), null, 1))
  }

  console.log('=== entry points offering group creation ===')
  console.log(JSON.stringify(await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('button, [role=menuitem], [role=button]')) {
      const text = (el.textContent ?? '').trim()
      if (/group chat|new…|new\.\.\.|create/i.test(text) && text.length < 40) {
        out.push({ tag: el.tagName, className: String(el.className), text, visible: el.offsetParent !== null })
      }
    }
    return out.slice(0, 30)
  }), null, 1))
} finally {
  await browser.close()
}
