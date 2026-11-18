/**
 * Capture Luis Munich OSM evidence from production.
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'

const prod = 'https://heavy-transport-route-check.vercel.app'
const out = '/opt/cursor/artifacts'
mkdirSync(out, { recursive: true })

async function main() {
  const gpx = readFileSync('public/samples/luis-munich-cycling.gpx', 'utf8')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  await page.goto(prod + '/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Continue as Luis' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  const skip = page.getByRole('button', { name: /skip/i })
  if (await skip.count()) await skip.first().click().catch(() => {})

  await page.goto(prod + '/route-checks', { waitUntil: 'domcontentloaded' })
  // Inject GPX via file chooser / test helper if available; else POST then navigate is hard.
  // Use the sample upload path: evaluate a File into the input.
  await page.setInputFiles('input[type="file"]', {
    name: 'luis-munich-cycling.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(gpx),
  }).catch(async () => {
    // Fallback: click Upload and set files on any file input.
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'luis-munich-cycling.gpx',
      mimeType: 'application/gpx+xml',
      buffer: Buffer.from(gpx),
    })
  })

  await page.waitForTimeout(1500)
  // Vehicle defaults are heavy enough for OSM HOLD.
  const dep = page.locator('input[type="datetime-local"]').first()
  if (await dep.count()) {
    const d = new Date(Date.now() + 2 * 3600e3)
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    await dep.fill(local)
  }
  await page.getByRole('button', { name: 'Check route' }).click()
  await page.locator('.verdict-banner').waitFor({ timeout: 180000 })
  await page.waitForTimeout(1000)

  await page.locator('.status-timeline').first().screenshot({ path: `${out}/prod-luis-status-timeline.png` }).catch(() => {})
  await page.locator('.verdict-banner').first().screenshot({ path: `${out}/prod-luis-verdict-banner.png` })
  const evidence = page.locator('.evidence-section, .evidence-list').first()
  if (await evidence.count()) await evidence.screenshot({ path: `${out}/prod-luis-osm-evidence.png` })
  await page.screenshot({ path: `${out}/prod-luis-osm-full.png`, fullPage: false })

  const text = await page.locator('body').innerText()
  const hasOsm = /OSM clearance|restriction|OpenStreetMap|Weight limit/i.test(text)
  console.log(JSON.stringify({ hasOsm, snippet: text.replace(/\s+/g, ' ').slice(0, 400) }))
  await browser.close()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
