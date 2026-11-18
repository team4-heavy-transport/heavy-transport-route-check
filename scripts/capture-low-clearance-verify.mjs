import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.PREVIEW_URL
  || 'https://heavy-transport-route-check-aae13bu9k-red-bars-projects.vercel.app/?_vercel_share=PLACEHOLDER'
const OUT = '/opt/cursor/artifacts'
mkdirSync(OUT, { recursive: true })
const gpxPath = resolve('public/samples/munich-low-clearance.gpx')
const origin = new URL(BASE).origin
const share = new URL(BASE).search

async function loginAsAna(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const ana = page.locator('button.login-user-tile').filter({ hasText: /^Ana$/i }).first()
  if (await ana.count()) await ana.click()
  else await page.locator('button.login-user-tile').first().click()
  await page.waitForTimeout(1200)
}

async function runLowClearanceCheck(page, { height, tickClearance }) {
  await page.goto(`${origin}/route-checks${share}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.locator('input[type="file"]').first().setInputFiles(gpxPath)
  await page.waitForSelector('[data-testid="vehicle-height"]', { timeout: 60_000 })
  await page.locator('[data-testid="vehicle-width"]').fill('2.5')
  await page.locator('[data-testid="vehicle-height"]').fill(String(height))
  await page.locator('[data-testid="vehicle-length"]').fill('12')
  await page.locator('[data-testid="vehicle-gross-weight"]').fill('18')
  const soon = new Date(Date.now() + 2 * 3600_000)
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  await page.locator('#planned-departure').fill(local)
  const clearance = page.locator('.clearance-tick input[type="checkbox"]').first()
  if (tickClearance) {
    if (!(await clearance.isChecked())) await clearance.check()
  } else if (await clearance.isChecked()) {
    await clearance.uncheck()
  }
  await page.getByRole('button', { name: /check route/i }).click()
  for (let i = 0; i < 60; i++) {
    if (await page.locator('.verdict-banner').count()) return
    await page.waitForTimeout(2000)
  }
  throw new Error('verdict banner not found')
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } })
  page.setDefaultTimeout(120_000)
  await loginAsAna(page)

  // VERIFY path: height fits OSM maxheight (≤ 3.4 m) — no false HOLD
  await runLowClearanceCheck(page, { height: 3.4, tickClearance: false })
  const verifyText = (await page.locator('.verdict-banner').innerText()).replace(/\s+/g, ' ')
  await page.locator('.verdict-banner').first().screenshot({ path: `${OUT}/low-verify-banner.png` })
  await page.locator('.evidence-section').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  await page.locator('.evidence-section').first().screenshot({ path: `${OUT}/low-verify-evidence.png` })
  await page.screenshot({ path: `${OUT}/low-verify-full.png` })
  console.log('VERIFY', verifyText.slice(0, 240))

  // Export PDF + CSV from VERIFY result (must list OSM clearance evidence)
  const pdfWait = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: /Export PDF/i }).click()
  const pdfDownload = await pdfWait
  const pdfPath = `${OUT}/low-verify-export.pdf`
  await pdfDownload.saveAs(pdfPath)

  const csvWait = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: /Export CSV/i }).click()
  const csvDownload = await csvWait
  const csvPath = `${OUT}/low-verify-export.csv`
  await csvDownload.saveAs(csvPath)
  console.log('EXPORTS', { pdf: pdfPath, csv: csvPath })

  // READY path: Ana ticks clearance on the result (no re-run needed)
  const dispatcher = page.getByPlaceholder(/Name stored/i).first()
  if (await dispatcher.count()) await dispatcher.fill('Ana')
  await page.waitForTimeout(400)
  const tick = page.locator('.clearance-tick input[type="checkbox"]').first()
  if (!(await tick.isChecked())) await tick.check()
  await page.waitForTimeout(1500)
  const readyText = (await page.locator('.verdict-banner').innerText()).replace(/\s+/g, ' ')
  await page.locator('.verdict-banner').first().screenshot({ path: `${OUT}/low-ready-banner.png` })
  await page.locator('.evidence-section').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.locator('.evidence-section').first().screenshot({ path: `${OUT}/low-ready-evidence.png` })
  console.log('READY_OR_VERIFY', readyText.slice(0, 240))

  await browser.close()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
