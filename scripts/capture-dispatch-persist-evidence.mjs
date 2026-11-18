/**
 * Capture before/after evidence for dispatch-decision persistence.
 * Usage: node scripts/capture-dispatch-persist-evidence.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const base = process.env.QA_URL || 'http://127.0.0.1:4173'
const out = '/opt/cursor/artifacts'
mkdirSync(out, { recursive: true })

async function login(page, name = 'Ana') {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  const login = page.getByRole('heading', { name: "Who's checking routes?" })
  if (await login.count()) {
    await page.getByRole('button', { name: `Continue as ${name}` }).click()
    await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  }
  const skip = page.getByRole('button', { name: /skip/i })
  if (await skip.count()) await skip.first().click().catch(() => {})
}

async function fillDeparture(page) {
  const input = page.locator('input[type="datetime-local"]').first()
  if (!(await input.count())) return
  const value = await input.inputValue()
  if (value) return
  const d = new Date(Date.now() + 2 * 3600e3)
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  await input.fill(local)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } })
  const page = await context.newPage()

  await login(page, 'Ana')
  await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /show sample permits/i }).click()
  await page.getByRole('button', { name: /Simulated READY — empty A20 corridor/i }).click()
  await fillDeparture(page)
  await page.getByRole('button', { name: 'Check route' }).click()
  await page.locator('.verdict-banner').waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: /Proceed with departure/i }).first().click()
  await page.getByText(/Decision saved – no external notification sent|Couldn't save to your account/i).waitFor({ timeout: 15000 })
  await page.locator('.app-toast').first().screenshot({ path: `${out}/after-dispatch-toast-saved.png` })
  await page.screenshot({ path: `${out}/after-dispatch-toast-full.png`, fullPage: false })

  await page.evaluate(async () => { await window.__HT_TEST__?.flushStore?.() })
  await page.waitForTimeout(500)

  await page.goto(base + '/activity', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: /Alerts & history/i }).waitFor({ timeout: 20000 })
  await page.locator('[data-testid="history-actions-log"]').first().waitFor({ timeout: 15000 })
  await page.locator('.check-history-log').first().screenshot({ path: `${out}/after-history-before-reload.png` })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: /Alerts & history/i }).waitFor({ timeout: 20000 })
  await page.locator('[data-testid="history-actions-log"]').first().waitFor({ timeout: 15000 })
  await page.locator('.check-history-log').first().screenshot({ path: `${out}/after-history-after-reload.png` })
  await page.screenshot({ path: `${out}/after-history-reload-full.png`, fullPage: false })

  // Fresh context = other session / device for same account.
  const page2 = await browser.newPage()
  await login(page2, 'Ana')
  await page2.goto(base + '/activity', { waitUntil: 'domcontentloaded' })
  await page2.getByRole('heading', { name: /Alerts & history/i }).waitFor({ timeout: 20000 })
  await page2.locator('[data-testid="history-actions-log"]').first().waitFor({ timeout: 20000 })
  await page2.locator('.check-history-log').first().screenshot({ path: `${out}/after-history-fresh-session.png` })
  await page2.screenshot({ path: `${out}/after-history-fresh-session-full.png`, fullPage: false })
  await page2.close()

  const videoPath = await page.video()?.path()
  await context.close()
  await browser.close()
  if (videoPath) {
    const { copyFileSync } = await import('node:fs')
    copyFileSync(videoPath, `${out}/dispatch-persist-demo.webm`)
    console.log('video', `${out}/dispatch-persist-demo.webm`)
  }
  console.log('done')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
