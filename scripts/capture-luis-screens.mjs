import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.PREVIEW_URL
  || 'https://heavy-transport-route-check-ayjbgmsnr-red-bars-projects.vercel.app/?_vercel_share=JyM1iFbEk2Xmf5ILQpwrR2OAKorTq95I'
const OUT = '/opt/cursor/artifacts'
mkdirSync(OUT, { recursive: true })
const gpxPath = resolve('public/samples/luis-munich-cycling.gpx')
const origin = new URL(BASE).origin
const share = new URL(BASE).search

async function loginAndOpen(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.locator('button.login-user-tile').first().click()
  await page.waitForTimeout(1200)
  await page.goto(`${origin}/route-checks${share}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
}

async function uploadAndFill(page, { width, height, length, weight }) {
  await page.locator('input[type="file"]').first().setInputFiles(gpxPath)
  await page.waitForSelector('[data-testid="vehicle-height"]', { timeout: 60_000 })
  await page.locator('[data-testid="vehicle-width"]').fill(String(width))
  await page.locator('[data-testid="vehicle-height"]').fill(String(height))
  await page.locator('[data-testid="vehicle-length"]').fill(String(length))
  await page.locator('[data-testid="vehicle-gross-weight"]').fill(String(weight))
  const soon = new Date(Date.now() + 2 * 3600_000)
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  await page.locator('#planned-departure').fill(local)
  const clearance = page.locator('.clearance-tick input[type="checkbox"]').first()
  if (await clearance.isChecked()) await clearance.uncheck()
}

async function waitResult(page) {
  await page.getByRole('button', { name: /check route/i }).click()
  for (let i = 0; i < 90; i++) {
    if (await page.locator('.verdict-banner').count()) break
    await page.waitForTimeout(2000)
  }
  await page.waitForTimeout(2000)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } })
  page.setDefaultTimeout(180_000)

  // 1) Heavy vehicle → HOLD (tagged restrictions compared)
  await loginAndOpen(page)
  await uploadAndFill(page, { width: 3.0, height: 4.0, length: 25, weight: 52 })
  await waitResult(page)
  const holdText = await page.locator('.verdict-banner').innerText()
  await page.locator('.verdict-banner').first().screenshot({ path: `${OUT}/luis-hold-banner.png` })
  await page.locator('.evidence-section').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.locator('.evidence-section').first().screenshot({ path: `${OUT}/luis-hold-evidence.png` })
  await page.screenshot({ path: `${OUT}/luis-hold-full.png` })
  console.log('HOLD', holdText.slice(0, 160))

  // 2) Fitting vehicle → VERIFY with honest N/M unknown-bridge message
  await page.goto(`${origin}/route-checks${share}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  // Reset flow if still on result
  const newCheck = page.getByRole('button', { name: /new check|start over|import|check another/i }).first()
  if (await newCheck.count()) await newCheck.click().catch(() => {})
  await page.waitForTimeout(800)
  // If still on result, hard navigate and clear via reload after storage? Just reload route-checks.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await uploadAndFill(page, { width: 1.9, height: 1.9, length: 4, weight: 2.5 })
  await waitResult(page)
  const verifyText = await page.locator('.verdict-banner').innerText()
  await page.locator('.verdict-banner').first().screenshot({ path: `${OUT}/luis-verify-banner.png` })
  await page.locator('.evidence-section').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.locator('.evidence-section').first().screenshot({ path: `${OUT}/luis-verify-evidence.png` })
  await page.screenshot({ path: `${OUT}/luis-verify-full.png` })
  console.log('VERIFY', verifyText.slice(0, 200))

  await browser.close()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
