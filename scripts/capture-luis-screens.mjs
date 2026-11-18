import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.PREVIEW_URL
  || 'https://heavy-transport-route-check-80qc52y4h-red-bars-projects.vercel.app/?_vercel_share=PLACEHOLDER'
const OUT = '/opt/cursor/artifacts'
mkdirSync(OUT, { recursive: true })
const gpxPath = resolve('public/samples/luis-munich-cycling.gpx')
const origin = new URL(BASE).origin
const share = new URL(BASE).search

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.locator('button.login-user-tile').first().click()
  await page.waitForTimeout(1200)
}

async function openRouteChecks(page) {
  await page.goto(`${origin}/route-checks${share}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
}

async function runCheck(page, vehicle) {
  await page.locator('input[type="file"]').first().setInputFiles(gpxPath)
  await page.waitForSelector('[data-testid="vehicle-height"]', { timeout: 60_000 })
  await page.locator('[data-testid="vehicle-width"]').fill(String(vehicle.width))
  await page.locator('[data-testid="vehicle-height"]').fill(String(vehicle.height))
  await page.locator('[data-testid="vehicle-length"]').fill(String(vehicle.length))
  await page.locator('[data-testid="vehicle-gross-weight"]').fill(String(vehicle.weight))
  const soon = new Date(Date.now() + 2 * 3600_000)
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  await page.locator('#planned-departure').fill(local)
  const clearance = page.locator('.clearance-tick input[type="checkbox"]').first()
  if (await clearance.isChecked()) await clearance.uncheck()
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

  await login(page)

  // VERIFY path: dims that fit tagged OSM limits → honest unknown-bridge message
  await openRouteChecks(page)
  await runCheck(page, { width: 1.9, height: 1.9, length: 4, weight: 2.5 })
  const verifyText = await page.locator('.verdict-banner').innerText()
  await page.locator('.verdict-banner').first().screenshot({ path: `${OUT}/luis-verify-banner.png` })
  await page.locator('.evidence-section').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  await page.locator('.evidence-section').first().screenshot({ path: `${OUT}/luis-verify-evidence.png` })
  await page.screenshot({ path: `${OUT}/luis-verify-full.png` })
  console.log('VERIFY', verifyText.replace(/\s+/g, ' ').slice(0, 220))

  // HOLD path: heavy haulage dims vs low OSM maxweight/maxheight on the cycling route
  await openRouteChecks(page)
  await runCheck(page, { width: 3.0, height: 4.0, length: 25, weight: 52 })
  const holdText = await page.locator('.verdict-banner').innerText()
  await page.locator('.verdict-banner').first().screenshot({ path: `${OUT}/luis-hold-banner.png` })
  await page.locator('.evidence-section').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  await page.locator('.evidence-section').first().screenshot({ path: `${OUT}/luis-hold-evidence.png` })
  await page.screenshot({ path: `${OUT}/luis-hold-full.png` })
  console.log('HOLD', holdText.replace(/\s+/g, ' ').slice(0, 220))

  await browser.close()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
