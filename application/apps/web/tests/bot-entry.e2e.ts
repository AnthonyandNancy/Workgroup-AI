/** Workgroup AI Bot first-level navigation in the shipped Web composition. */

import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/bot-entry/navigation.expected.md', import.meta.url))

it('keeps shell navigation and Bot-owned conversations distinct', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [], bundles: ['@deepseek-ai/dsh-bot'] },
  })
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    const page = await context.newPage()
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-entry-navigation'))
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const navigation = page.getByRole('navigation', { name: 'Global panels' })
      await navigation.waitFor()
      const labels = await navigation.getByRole('button').evaluateAll(buttons =>
        buttons.map(button => button.getAttribute('aria-label')))
      const pluginsIndex = labels.indexOf('Plugins')
      expect(pluginsIndex).toBeGreaterThanOrEqual(0)
      expect(labels[pluginsIndex + 1]).toBe('Bot')
      expect(labels.filter(label => label === 'Bot')).toHaveLength(1)

      const bot = navigation.getByRole('button', { name: 'Bot', exact: true })
      expect(await bot.getAttribute('aria-current')).toBeNull()
      await page.getByRole('button', { name: 'New session', exact: true })
        .filter({ hasText: 'New Session' }).click()
      await expect.poll(() => page.locator('html').getAttribute('data-wg-bot-panel')).toBeNull()
      expect(await bot.getAttribute('aria-current')).toBeNull()

      await bot.click()
      await expect.poll(() => bot.getAttribute('aria-current')).toBe('page')
      const botList = page.getByRole('region', { name: 'Bot list' })
      await botList.waitFor()
      await botList.getByRole('button').first().click()
      await expect.poll(() => bot.getAttribute('aria-current')).toBe('page')

      const snapshot = await captureStableAria(page, 'nav[aria-label="Global panels"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(EXPECTED, snapshot, webSnapshotMode())

      await navigation.getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.locator('[data-plugin-panel]').waitFor()
      expect(await bot.getAttribute('aria-current')).toBeNull()
      await expect.poll(() => page.locator('html').getAttribute('data-wg-bot-panel')).toBeNull()
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await context.close()
    }

    const agentContext = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    await agentContext.addInitScript(() => { localStorage.setItem('ds-bot:surface', 'agent') })
    const agentPage = await agentContext.newPage()
    const agentTripwire = watchConsole(agentPage)
    onTestFailed(() => saveFailureShot(agentPage, 'web-e2e-bot-entry-agent-mode'))
    try {
      await agentPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const bot = agentPage.getByRole('navigation', { name: 'Global panels' })
        .getByRole('button', { name: 'Bot', exact: true })
      await bot.click()
      await agentPage.getByRole('region', { name: 'Bot list' }).waitFor()
      await expect.poll(() => bot.getAttribute('aria-current')).toBe('page')
      expect(agentTripwire.pageErrors).toEqual([])
      expect(agentTripwire.warnings).toEqual([])
    } finally {
      await agentContext.close()
    }
  } finally {
    await browser.close()
    await scaffold.close()
  }
})
