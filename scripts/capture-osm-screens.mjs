import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.PREVIEW_URL
  || 'https://heavy-transport-route-check-8qnnbz0ie-red-bars-projects.vercel.app/?_vercel_share=9dJRX6cHbhJC8iElvsisgG75a9KYW675'
const OUT = '/opt/cursor/artifacts'
mkdirSync(OUT, { recursive: true })
const gpxPath = resolve('public/samples/munich-low-clearance.gpx')
const origin = new URL(BASE).origin
const share = new URL(BASE).search

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
  page.setDefaultTimeout(120_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const tile = page.locator('button.login-user-tile').filter({ hasText: /^Ana$/i }).first()
  if (await tile.count()) await tile.click()
  else await page.locator('button.login-user-tile').first().click()
  await page.waitForTimeout(1200)

  await page.goto(`${origin}/route-checks${share}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.locator('input[type="file"]').first().setInputFiles(gpxPath)
  await page.waitForSelector('[data-testid="vehicle-height"]', { timeout: 30_000 })
  await page.locator('[data-testid="vehicle-width"]').fill('3.5')
  await page.locator('[data-testid="vehicle-height"]').fill('4.5')
  await page.locator('[data-testid="vehicle-length"]').fill('30')
  await page.locator('[data-testid="vehicle-gross-weight"]').fill('80')

  const dep = page.locator('#planned-departure').first()
  const soon = new Date(Date.now() + 2 * 3600_000)
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  await dep.fill(local)

  const clearance = page.locator('.clearance-tick input[type="checkbox"]').first()
  if (await clearance.isChecked()) await clearance.uncheck()

  await page.getByRole('button', { name: /check route/i }).click()
  await page.waitForSelector('.verdict-banner.verdict-red, .verdict-banner', { timeout: 120_000 })
  await page.waitForTimeout(4000)

  await page.locator('.verdict-banner').first().screenshot({ path: `${OUT}/osm-hold-banner.png` })

  // Zoom map onto conflict markers
  await page.locator('.route-map-gl-layers-header').click().catch(() => {})
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /On-site reports/i }).click().catch(() => {})
  await page.waitForTimeout(800)
  // Click first OSM height evidence to fly the map
  const heightCard = page.locator('.evidence-card').filter({ hasText: /Height limit/i }).first()
  if (await heightCard.count()) {
    await heightCard.click()
    await page.waitForTimeout(2000)
  }
  // Extra zoom via map control
  for (let i = 0; i < 3; i++) {
    await page.locator('.route-map-gl button, .maplibregl-ctrl-zoom-in').last().click().catch(() => {})
    await page.waitForTimeout(400)
  }
  await page.locator('.route-map-gl').first().screenshot({ path: `${OUT}/osm-map-markers.png` })

  // Evidence list with OSM items
  const section = page.locator('.evidence-section').first()
  await section.scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  await section.screenshot({ path: `${OUT}/osm-evidence-list.png` })

  await page.screenshot({ path: `${OUT}/osm-result-full.png` })
  console.log('done', {
    banner: await page.locator('.verdict-banner').innerText().then(t => t.slice(0, 120)),
    osmCards: await page.locator('.evidence-card').filter({ hasText: /OpenStreetMap|Height limit|OSM clearance/i }).count(),
  })
  await browser.close()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
