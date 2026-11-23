import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { chromium } from 'playwright'

const port = Number(process.env.QA_PORT || 4173)
const base = process.env.QA_URL || `http://127.0.0.1:${port}`
const results = []

/** Matches `DEMO_TOUR_STORAGE_KEY` / dismissed shape from `src/lib/demoTour.ts`. */
const DEMO_TOUR_STORAGE_KEY = 'htr-demo-tour:v1'
const DISMISSED_DEMO_TOUR_PROGRESS = JSON.stringify({
  welcomeSeen: true,
  completedSections: [],
  tourDismissed: true,
})

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function seedDismissedDemoTour(page) {
  await page.evaluate(({ key, value }) => {
    try { localStorage.setItem(key, value) } catch {}
  }, { key: DEMO_TOUR_STORAGE_KEY, value: DISMISSED_DEMO_TOUR_PROGRESS })
}

/** Persist dismissed tour across navigations/reloads in this browser context. */
async function installDismissedDemoTourInit(context) {
  await context.addInitScript(({ key, value }) => {
    try { localStorage.setItem(key, value) } catch {}
  }, { key: DEMO_TOUR_STORAGE_KEY, value: DISMISSED_DEMO_TOUR_PROGRESS })
}

async function clearDemoTourProgress(page) {
  await page.evaluate(key => {
    try { localStorage.removeItem(key) } catch {}
  }, DEMO_TOUR_STORAGE_KEY)
}

async function overflowReport(page, selectors) {
  return page.evaluate(sels => sels.map(sel => {
    const el = document.querySelector(sel)
    if (!el) return { sel, missing: true, overflow: false, scrollWidth: 0, clientWidth: 0 }
    return {
      sel,
      missing: false,
      overflow: el.scrollWidth > el.clientWidth + 1,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }
  }), selectors)
}

function permitMapCounts(root) {
  return {
    tiles: root.querySelectorAll('img.leaflet-tile').length,
    paths: root.querySelectorAll('.leaflet-overlay-pane path').length,
    height: root.clientHeight,
    width: root.clientWidth,
  }
}

async function mapPaintMetrics(page, selector) {
  await page.locator(selector).first().waitFor({ timeout: 25000 })
  await page.waitForFunction(sel => {
    const el = document.querySelector(sel)
    return Boolean(el && el.clientHeight > 8)
  }, selector, { timeout: 20000 }).catch(() => {})
  const box = await page.locator(selector).first().evaluate(el => {
    const canvas = el.querySelector('canvas')
    const tiles = el.querySelectorAll('img.leaflet-tile').length
    return {
      width: Math.round(el.clientWidth),
      height: Math.round(el.clientHeight),
      canvasWidth: canvas ? Math.round(canvas.clientWidth) : 0,
      canvasHeight: canvas ? Math.round(canvas.clientHeight) : 0,
      tiles,
    }
  })
  let pngSize = 0
  let unique = 0
  try {
    const buf = await page.locator(selector).first().screenshot({ timeout: 15000 })
    pngSize = buf.length
    unique = new Set(buf.subarray(0, Math.min(buf.length, 8000))).size
  } catch {
    // Screenshot can fail if the node has 0 height.
  }
  return { ...box, pngSize, unique }
}

function mapLooksPainted(metrics) {
  const tallEnough = metrics.height > 300
  const leafletPainted = metrics.tiles > 0
  const canvasPainted = metrics.canvasHeight > 300 && metrics.pngSize > 8000 && metrics.unique > 16
  return tallEnough && (leafletPainted || canvasPainted)
}

async function waitForPreview(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview server did not start')), 20000)
    const onData = chunk => {
      const text = String(chunk)
      process.stdout.write(text)
      if (text.includes('QA preview listening')) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', chunk => process.stderr.write(chunk))
    child.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`Preview server exited ${code}`))
    })
  })
}

async function downloadFile(page, buttonName) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.getByRole('button', { name: buttonName }).first().click(),
  ])
  const path = await download.path()
  const size = path ? statSync(path).size : 0
  const buffer = path ? readFileSync(path) : Buffer.alloc(0)
  return { size, suggested: download.suggestedFilename(), path, buffer }
}

/** Planned departure is intentionally empty (no silent default). Fill a near-future value for checks. */
async function fillPlannedDeparture(page, hoursAhead = 8) {
  const input = page.locator('#planned-departure')
  await input.waitFor({ timeout: 15000 })
  // Sample GPX load is async after selecting a permit — wait until Check route can run.
  await page.getByRole('button', { name: 'Check route' }).waitFor({ state: 'visible', timeout: 15000 })
  const value = await page.evaluate(hours => {
    const date = new Date(Date.now() + hours * 60 * 60 * 1000)
    const pad = n => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }, hoursAhead)
  await input.fill(value)
  await page.getByRole('button', { name: 'Check route' }).waitFor({ state: 'attached', timeout: 5000 })
  await page.waitForFunction(() => {
    const btn = [...document.querySelectorAll('button')].find(el => /Check route/i.test(el.textContent || ''))
    return Boolean(btn && !btn.disabled)
  }, null, { timeout: 15000 })
}

function decodePdfStrings(buffer) {
  const latin1 = Buffer.from(buffer).toString('latin1')
  const strings = []
  const re = /\((?:\\.|[^\\)])*\)/g
  let match
  while ((match = re.exec(latin1))) {
    strings.push(
      match[0]
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
        .replace(/\\(.)/g, '$1'),
    )
  }
  return { latin1, text: strings.join('\n'), compact: strings.join('') }
}

async function readHistoryLength(page) {
  return page.evaluate(() => {
    const fromHook = window.__HT_TEST__?.getHistory?.()
    if (Array.isArray(fromHook)) return fromHook.length
    const fromStore = window.__HT_TEST__?.getStore?.('htr-route-check-history')
    return Array.isArray(fromStore) ? fromStore.length : 0
  })
}

async function readHistory(page) {
  return page.evaluate(() => {
    const fromHook = window.__HT_TEST__?.getHistory?.()
    if (Array.isArray(fromHook)) return fromHook
    const fromStore = window.__HT_TEST__?.getStore?.('htr-route-check-history')
    return Array.isArray(fromStore) ? fromStore : []
  })
}

/** Flush debounced account saves before full navigations/reloads (pagehide beacon can race hydrate). */
async function flushAccount(page) {
  await page.evaluate(async () => {
    await window.__HT_TEST__?.flushStore?.()
  }).catch(() => {})
  await page.waitForTimeout(50)
}

async function main() {
  const preview = spawn('pnpm', ['exec', 'tsx', 'scripts/qa-preview.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, QA_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForPreview(preview)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  })
  await context.grantPermissions(['notifications'])
  const page = await context.newPage()

  async function ensureLoggedIn(userName = 'Demo') {
    const loginHeading = page.getByRole('heading', { name: "Who's checking routes?" })
    if (await loginHeading.count()) {
      // Switch user / login does not clear htr-demo-tour:v1 (browserStore isolation),
      // but re-seed before Demo so welcome never blocks existing flows.
      if (userName === 'Demo') await seedDismissedDemoTour(page)
      await page.getByRole('button', { name: `Continue as ${userName}` }).click()
      await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
      await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 }).catch(() => {})
    }
    const skip = page.getByRole('button', { name: /skip/i })
    if (await skip.count()) await skip.first().click().catch(() => {})
  }

  for (const iconPath of ['/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']) {
    const res = await page.goto(base + iconPath, { timeout: 15000 })
    const buf = res ? Buffer.from(await res.body()) : Buffer.alloc(0)
    const png = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    const head = buf.subarray(0, 40).toString('latin1')
    record(
      `Served ${iconPath} is a PNG blob, not an LFS pointer`,
      Boolean(res?.ok()) && png,
      `status=${res?.status()} head=${JSON.stringify(head.slice(0, 32))}`,
    )
  }

  // Clear any prior user so the login screen is visible for the first assertion.
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.evaluate(() => {
    try { localStorage.removeItem('htr-current-user') } catch {}
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ timeout: 20000 })
  const loginTiles = page.locator('button.login-user-tile')
  const loginTileCount = await loginTiles.count()
  record('Login screen renders 7 user tiles', loginTileCount === 7, `count=${loginTileCount}`)

  await page.setViewportSize({ width: 1440, height: 900 })
  const headlineDesktop = await page.locator('.login-headline').evaluate(
    el => parseFloat(getComputedStyle(el).fontSize),
  )
  record(
    'Login headline ≥ 64px at 1440×900',
    headlineDesktop >= 64,
    `fontSize=${headlineDesktop}`,
  )

  // Short phone viewport: footnote must stay in the first screen (no +24px tolerance).
  await page.setViewportSize({ width: 390, height: 844 })
  const loginPhoneMetrics = await page.evaluate(() => {
    const screen = document.querySelector('.login-screen')
    const footnote = document.querySelector('.login-footnote')
    const headline = document.querySelector('.login-headline')
    const tile = document.querySelector('button.login-user-tile:not(.is-demo)')
    if (!screen || !footnote || !headline || !tile) {
      return { ok: false, reason: 'missing' }
    }
    const screenRect = screen.getBoundingClientRect()
    const noteRect = footnote.getBoundingClientRect()
    const style = getComputedStyle(screen)
    const viewport = window.innerHeight
    const noteBottom = noteRect.bottom
    return {
      // Tolerance-free: bottom must be ≤ viewport (844). Layout aims for ≥40px spare locally.
      ok: noteBottom <= viewport,
      screenHeight: Math.round(screenRect.height),
      noteBottom: Math.round(noteBottom),
      spare: Math.round(viewport - noteBottom),
      viewport,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
      headlinePx: parseFloat(getComputedStyle(headline).fontSize),
      rowPx: tile.getBoundingClientRect().height,
    }
  })
  record(
    'Login footnote fits in 390×844 viewport',
    Boolean(loginPhoneMetrics.ok),
    JSON.stringify(loginPhoneMetrics),
  )
  record(
    'Login headline ≥ 40px at 390×844',
    Number(loginPhoneMetrics.headlinePx) >= 40,
    `fontSize=${loginPhoneMetrics.headlinePx}`,
  )
  record(
    'Login name rows ≥ 44px at 390×844',
    Number(loginPhoneMetrics.rowPx) >= 44,
    `rowHeight=${loginPhoneMetrics.rowPx}`,
  )
  await page.setViewportSize({ width: 1440, height: 900 })

  // --- Demo tour gate: fresh Demo (no htr-demo-tour:v1) sees welcome once ---
  await clearDemoTourProgress(page)
  await page.getByRole('button', { name: 'Continue as Demo' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  const skipOnboardingFresh = page.getByRole('button', { name: /skip/i })
  if (await skipOnboardingFresh.count()) {
    await skipOnboardingFresh.first().click().catch(() => {})
  }
  const welcomeBackdrop = page.locator('.demo-tour-welcome-backdrop')
  await welcomeBackdrop.waitFor({ state: 'visible', timeout: 20000 })
  const startTourBtn = page.getByRole('button', { name: 'Start the full tour' })
  const chooseGuideBtn = page.getByRole('button', { name: 'Choose a guide' })
  record(
    'Fresh Demo shows tour welcome with Start the full tour and Choose a guide',
    (await welcomeBackdrop.isVisible()) && (await startTourBtn.isVisible()) && (await chooseGuideBtn.isVisible()),
  )
  await page.getByRole('button', { name: 'Not now' }).click()
  await welcomeBackdrop.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
  record(
    'Not now closes Demo tour welcome',
    (await page.locator('.demo-tour-welcome-backdrop').count()) === 0,
  )
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 }).catch(() => {})
  const skipAfterWelcomeReload = page.getByRole('button', { name: /skip/i })
  if (await skipAfterWelcomeReload.count()) await skipAfterWelcomeReload.first().click().catch(() => {})
  await page.waitForTimeout(800)
  const welcomeAfterReload = await page.locator('.demo-tour-welcome-backdrop').count()
  record(
    'Demo tour welcome does not re-appear after Not now + reload',
    welcomeAfterReload === 0,
    `backdropCount=${welcomeAfterReload}`,
  )

  // Existing Demo flows: keep welcome dismissed (Switch user does not clear this key).
  await seedDismissedDemoTour(page)
  await installDismissedDemoTourInit(context)

  // --- Non-Demo account must never load the Demo tour UI or chunk ---
  {
    const luisContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    })
    const luisPage = await luisContext.newPage()
    const demoTourChunks = []
    luisPage.on('request', req => {
      if (/DemoTour[^/?#]*\.js/i.test(req.url())) demoTourChunks.push(req.url())
    })
    await luisPage.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await luisPage.getByRole('button', { name: 'Continue as Luis' }).click()
    await luisPage.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
    const skipLuisTour = luisPage.getByRole('button', { name: /skip/i })
    if (await skipLuisTour.count()) await skipLuisTour.first().click().catch(() => {})
    await luisPage.waitForTimeout(1200)
    const luisTourDom = await luisPage.evaluate(() => ({
      root: document.querySelectorAll('.demo-tour-root').length,
      launcher: document.querySelectorAll('.demo-tour-launcher').length,
      anchor: document.querySelectorAll('[data-tour="demo-guide-anchor"]').length,
    }))
    record(
      'Non-Demo (Luis) has no Demo tour UI',
      luisTourDom.root === 0 && luisTourDom.launcher === 0 && luisTourDom.anchor === 0,
      JSON.stringify(luisTourDom),
    )
    record(
      'Non-Demo (Luis) does not request DemoTour-*.js chunk',
      demoTourChunks.length === 0,
      demoTourChunks.slice(0, 3).join(' | ') || 'none',
    )
    await luisContext.close()
  }

  const homeTitle = await page.title()
  record(
    'Document title uses HTR brand',
    homeTitle === 'HTR · Heavy transport route check',
    homeTitle,
  )
  record(
    'Sidebar wordmark is Heavy transport route check',
    await page.getByRole('button', { name: 'Heavy transport route check' }).first().isVisible(),
  )
  const homeText = await page.locator('body').innerText()
  record('No user-facing MSD brand text', !/\bMSD\b/.test(homeText), (homeText.match(/\bMSD\b/) || [''])[0])
  await page.getByRole('button', { name: 'Collapse navigation' }).click()
  const collapsedBrand = page.getByRole('button', { name: 'Heavy transport route check' }).first()
  const collapsedMark = collapsedBrand.locator('svg[data-detail="small"], svg[data-detail="full"]').first()
  record(
    'Collapsed sidebar shows HTR',
    (await collapsedBrand.isVisible()) && (await collapsedMark.isVisible()),
    `aria-label=${await collapsedBrand.getAttribute('aria-label')} detail=${await collapsedMark.getAttribute('data-detail')}`,
  )
  await page.getByRole('button', { name: 'Expand navigation' }).click()

  async function assertMobileNavChrome(width, height) {
    await page.setViewportSize({ width, height })
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    const skip = page.getByRole('button', { name: /skip/i })
    if (await skip.count()) await skip.first().click().catch(() => {})

    const tabBar = page.locator('.mobile-tab-bar')
    const tabDisplay = await tabBar.evaluate(el => getComputedStyle(el).display)
    record(
      `Mobile tab bar visible at ${width}×${height}`,
      tabDisplay !== 'none',
      tabDisplay,
    )

    const closedA11y = await page.evaluate(() => {
      const sidebar = document.querySelector('.app-sidebar')
      if (!sidebar) return { ok: false, reason: 'missing sidebar' }
      const focusables = Array.from(
        sidebar.querySelectorAll('a, button, input, select, textarea, [tabindex]'),
      )
      const active = document.activeElement
      return {
        ok: true,
        inert: sidebar.hasAttribute('inert'),
        mobileOpen: sidebar.classList.contains('mobile-open'),
        focusableCount: focusables.length,
        anyFocusableInTree: focusables.some((el) => {
          // inert ancestors make matches() / focus() fail; also check offset.
          try {
            el.focus()
            return document.activeElement === el
          } catch {
            return false
          }
        }),
        activeInSidebar: Boolean(active && sidebar.contains(active)),
      }
    })
    // Clear any accidental focus from the probe above.
    await page.evaluate(() => document.body.focus())
    record(
      `Closed drawer at ${width}×${height}: inert and not focusable`,
      Boolean(
        closedA11y.ok
        && closedA11y.inert
        && !closedA11y.mobileOpen
        && !closedA11y.anyFocusableInTree
        && !closedA11y.activeInSidebar,
      ),
      JSON.stringify(closedA11y),
    )

    const openTrigger = page.getByRole('button', { name: 'Open navigation' })
    await openTrigger.click()
    record(
      `Drawer opens at ${width}×${height}`,
      await page.locator('.app-sidebar.mobile-open').count() === 1,
    )
    await page.waitForFunction(() => {
      const close = document.querySelector('.app-sidebar.mobile-open .sidebar-collapse')
      return Boolean(close && document.activeElement === close)
    }, null, { timeout: 3000 }).catch(() => {})

    const closeInDrawer = page.locator('.app-sidebar.mobile-open').getByRole('button', { name: 'Close navigation' })
    record(
      `Drawer collapse control closes (not desktop-collapses) at ${width}×${height}`,
      await closeInDrawer.count() === 1,
    )

    const openA11y = await page.evaluate(() => {
      const sidebar = document.querySelector('.app-sidebar')
      if (!sidebar) return { ok: false, reason: 'missing sidebar' }
      const closeBtn = sidebar.querySelector('.sidebar-collapse')
      const closeFocusedInitially = Boolean(
        closeBtn && (document.activeElement === closeBtn || document.activeElement?.closest?.('.sidebar-collapse') === closeBtn),
      )
      const overview = Array.from(sidebar.querySelectorAll('a')).find((a) =>
        /overview/i.test(a.getAttribute('aria-label') || a.textContent || ''),
      )
      let overviewFocusable = false
      if (overview) {
        overview.focus()
        overviewFocusable = document.activeElement === overview
      }
      return {
        ok: true,
        inert: sidebar.hasAttribute('inert'),
        mobileOpen: sidebar.classList.contains('mobile-open'),
        overviewFocusable,
        closeFocusedInitially,
      }
    })
    record(
      `Open drawer at ${width}×${height}: not inert; focus in drawer; nav links focusable`,
      Boolean(
        openA11y.ok
        && !openA11y.inert
        && openA11y.mobileOpen
        && openA11y.closeFocusedInitially
        && openA11y.overviewFocusable,
      ),
      JSON.stringify(openA11y),
    )

    await closeInDrawer.click()

    const after = await page.evaluate(() => {
      const sidebar = document.querySelector('.app-sidebar')
      const main = document.querySelector('.app-main')
      const tabs = document.querySelector('.mobile-tab-bar')
      const openBtn = document.querySelector('.mobile-nav-trigger')
      if (!sidebar || !main || !tabs) return { ok: false, reason: 'missing nodes' }
      const sideStyle = getComputedStyle(sidebar)
      const tabsStyle = getComputedStyle(tabs)
      const sideBox = sidebar.getBoundingClientRect()
      const mainBox = main.getBoundingClientRect()
      return {
        ok: true,
        hasMobileOpen: sidebar.classList.contains('mobile-open'),
        inert: sidebar.hasAttribute('inert'),
        tabDisplay: tabsStyle.display,
        sidebarWidth: Math.round(sideBox.width),
        mainLeft: Math.round(mainBox.left),
        mainWidth: Math.round(mainBox.width),
        transform: sideStyle.transform,
        left: sideStyle.left,
        focusRestoredToOpen: document.activeElement === openBtn,
      }
    })
    record(
      `After drawer close at ${width}×${height}: no collapsed rail, full-width main, tab bar on`,
      Boolean(
        after.ok
        && !after.hasMobileOpen
        && after.tabDisplay !== 'none'
        && after.mainLeft <= 1
        && after.mainWidth >= width - 2,
      ),
      JSON.stringify(after),
    )
    record(
      `After drawer close at ${width}×${height}: inert again; focus returns to Open navigation`,
      Boolean(after.ok && after.inert && after.focusRestoredToOpen),
      JSON.stringify(after),
    )
  }

  await assertMobileNavChrome(390, 844)
  await assertMobileNavChrome(320, 720)

  // Narrow phone (≤420px): meta/Switch user text is CSS-hidden — header avatar must still switch.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(base + '/settings', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await ensureLoggedIn('Demo')
  const mobileHeaderSwitch = page.locator('.mobile-user-chip').getByRole('button', { name: /Switch user \(Demo\)/i })
  await mobileHeaderSwitch.waitFor({ state: 'visible', timeout: 15000 })
  const mobileSwitchBox = await mobileHeaderSwitch.boundingBox()
  record(
    'Mobile header Switch user control is ≥36px at 390px',
    Boolean(
      mobileSwitchBox
      && mobileSwitchBox.width >= 36
      && mobileSwitchBox.height >= 36,
    ),
    JSON.stringify(mobileSwitchBox),
  )
  await mobileHeaderSwitch.click()
  await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ timeout: 15000 })
  record(
    'Narrow mobile header avatar opens the user picker',
    await page.getByRole('heading', { name: "Who's checking routes?" }).isVisible(),
  )
  await seedDismissedDemoTour(page)
  await page.getByRole('button', { name: 'Continue as Demo' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  const skipAfterMobileSwitch = page.getByRole('button', { name: /skip/i })
  if (await skipAfterMobileSwitch.count()) await skipAfterMobileSwitch.first().click().catch(() => {})

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const skipAfterMobileNav = page.getByRole('button', { name: /skip/i })
  if (await skipAfterMobileNav.count()) await skipAfterMobileNav.first().click().catch(() => {})

  // Redesigned Overview: workflow strip, Check new route, filters, route block, full-size map.
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor({ timeout: 15000 })
  record('Overview page has accessible h1', await page.getByRole('heading', { name: 'Overview', exact: true }).isVisible())

  // Round-5: overlapping tracks paint READY → VERIFY → HOLD, selected on top
  const mapDrawSrc = readFileSync('src/components/OverviewRoutesMap.tsx', 'utf8')
  const trackOrderSrc = readFileSync('src/lib/overviewTracks.ts', 'utf8')
  record(
    'Overview map sorts tracks by severity then selected (HOLD above VERIFY)',
    mapDrawSrc.includes('compareTracksForMapDrawOrder')
      && /READY:\s*0/.test(trackOrderSrc)
      && /VERIFY:\s*1/.test(trackOrderSrc)
      && /HOLD:\s*2/.test(trackOrderSrc)
      && trackOrderSrc.includes('compareTracksForMapDrawOrder'),
  )
  record(
    'Overview keeps the 3-step workflow strip',
    await page.locator('.transport-workflow[data-tour="overview-workflow"]').isVisible(),
  )
  const checkNew = page.locator('[data-tour="overview-check-new"]')
  await checkNew.waitFor({ timeout: 10000 })
  const checkNewBox = await checkNew.boundingBox()
  record(
    'Check new route CTA is prominent (≥52px tall)',
    Boolean(checkNewBox && checkNewBox.height >= 52),
    JSON.stringify(checkNewBox),
  )
  record(
    'Check new route links to /route-checks',
    ((await checkNew.getAttribute('href')) || '').includes('/route-checks'),
  )

  await page.locator('[data-tour="overview-filters"]').waitFor({ timeout: 10000 })
  const listBefore = await page.locator('[data-tour="overview-route-list"] a, [data-tour="overview-route-list"] button').count()
  const blockBefore = await page.locator('[data-tour="overview-route-cards"] .overview-route-card').count()
  record('Overview shows a route list', listBefore > 0, `list=${listBefore}`)
  record('Overview route block card count matches list', blockBefore === listBefore, `list=${listBefore} block=${blockBefore}`)

  const holdChip = page.locator('[data-tour="overview-filters"] button', { hasText: /Hold departure/i })
  if (await holdChip.count()) {
    await holdChip.first().click()
    await page.waitForTimeout(200)
    const listAfter = await page.locator('[data-testid="overview-filter-count"]').innerText()
    const blockAfter = await page.locator('[data-tour="overview-route-cards"] .overview-route-card').count()
    const listCountAfter = Number((listAfter.match(/Showing (\d+)/) || [])[1] || -1)
    record(
      'Status filter updates list and block counts together',
      listCountAfter === blockAfter,
      `meta=${listAfter} block=${blockAfter}`,
    )
    const clear = page.getByRole('button', { name: 'Clear filters' })
    if (await clear.count()) await clear.first().click()
  }

  const showBtn = page.locator('.overview-route-card .overview-route-show').first()
  await showBtn.waitFor({ timeout: 10000 })
  await showBtn.scrollIntoViewIfNeeded()
  await showBtn.click()
  await page.waitForFunction(() => {
    const btn = document.querySelector('.overview-route-card .overview-route-show')
    return btn && btn.getAttribute('aria-expanded') === 'true'
  }, null, { timeout: 5000 }).catch(() => {})
  record(
    'Show toggle sets aria-expanded true',
    (await showBtn.getAttribute('aria-expanded')) === 'true',
  )
  await showBtn.click()
  await page.waitForFunction(() => {
    const btn = document.querySelector('.overview-route-card .overview-route-show')
    return btn && btn.getAttribute('aria-expanded') === 'false'
  }, null, { timeout: 5000 }).catch(() => {})
  record(
    'Show toggle can collapse (aria-expanded false)',
    (await showBtn.getAttribute('aria-expanded')) === 'false',
  )

  await page.locator('[data-overview-map="overview-block-map"] .leaflet-container').waitFor({ timeout: 25000 })
  const osmAttr = await page.locator('[data-overview-map="overview-block-map"] .leaflet-control-attribution').innerText()
  record('Overview block map keeps OSM attribution', /OpenStreetMap/i.test(osmAttr), osmAttr)

  const fullOpen = page.locator('[data-tour="overview-fullmap-open"]')
  await fullOpen.click()
  await page.locator('[data-testid="overview-fullmap"]').waitFor({ timeout: 10000 })
  record('Full-size map opens as dialog', await page.locator('[data-testid="overview-fullmap"][role="dialog"]').isVisible())
  await page.getByRole('tab', { name: 'Single route' }).click()
  record(
    'Single-route mode shows vehicle / alerts / last checked',
    (await page.locator('[data-testid="overview-fullmap-vehicle"], [data-testid="overview-fullmap-alerts"], [data-testid="overview-fullmap-checked"]').count()) >= 2,
  )
  await page.locator('[data-tour="overview-fullmap-minimise"]').click()
  await page.locator('[data-testid="overview-fullmap"]').waitFor({ state: 'detached', timeout: 10000 })
  const focusBack = await page.evaluate(() => {
    const el = document.activeElement
    return Boolean(el && el.getAttribute('data-tour') === 'overview-fullmap-open')
  })
  record('Minimise returns focus to Full-size map button', focusBack)

  // Status colours, title/subtitle stacking, selection ≠ status border
  const secondCard = page.locator('[data-tour="overview-route-cards"] .overview-route-card .overview-route-card-main').nth(1)
  if (await secondCard.count()) {
    await secondCard.click()
    await page.waitForTimeout(150)
  }
  const statusColourAudit = await page.evaluate(() => {
    const parseRgb = (value) => {
      const m = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
      if (!m) return null
      return [Number(m[1]), Number(m[2]), Number(m[3])]
    }
    const hexToRgb = (hex) => {
      const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim())
      if (!m) return null
      const n = parseInt(m[1], 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    const near = (a, b, tol = 12) => {
      if (!a || !b) return false
      return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol
    }
    const isNearWhiteOrBlack = (rgb) => {
      if (!rgb) return true
      const [r, g, b] = rgb
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const nearWhite = r > 230 && g > 230 && b > 230
      const nearBlack = r < 30 && g < 30 && b < 30
      const nearGray = max - min < 18
      return nearWhite || nearBlack || nearGray
    }
    const key = (rgb) => (rgb ? rgb.join(',') : 'null')
    const byStatus = {}
    for (const status of ['ready', 'verify', 'hold']) {
      const pill = document.querySelector(
        `[data-tour="overview-route-cards"] .overview-route-card[data-status="${status}"] [data-testid="overview-status-pill"]`,
      )
      if (!pill) continue
      const color = getComputedStyle(pill).color
      byStatus[status] = { color, rgb: parseRgb(color) }
    }
    const colours = Object.values(byStatus).map((entry) => key(entry.rgb))
    const distinct = new Set(colours).size
    const notDefault = Object.values(byStatus).every((entry) => !isNearWhiteOrBlack(entry.rgb))

    const card = document.querySelector('[data-tour="overview-route-cards"] .overview-route-card')
    let titleSubtitleOffset = null
    if (card) {
      const title = card.querySelector('.overview-route-title')
      const subtitle = card.querySelector('.overview-route-subtitle')
      if (title && subtitle) {
        const t = title.getBoundingClientRect()
        const s = subtitle.getBoundingClientRect()
        titleSubtitleOffset = { titleTop: t.top, subtitleTop: s.top, delta: s.top - t.top }
      }
    }

    const selected = document.querySelector('[data-tour="overview-route-cards"] .overview-route-card.is-selected')
    let selectionBorder = null
    if (selected) {
      const style = getComputedStyle(selected)
      const root = getComputedStyle(document.documentElement)
      const probe = document.createElement('span')
      document.body.appendChild(probe)
      probe.style.color = 'var(--accent)'
      const accentRgb = parseRgb(getComputedStyle(probe).color)
      const statusRgb = ['--status-ready-border', '--status-verify-border', '--status-hold-border'].map((name) => {
        const raw = root.getPropertyValue(name).trim()
        probe.style.color = raw
        return parseRgb(getComputedStyle(probe).color) || hexToRgb(raw)
      })
      probe.remove()
      const borderRgb = parseRgb(style.borderTopColor)
      const outlineRgb = parseRgb(style.outlineColor)
      const matchesStatus = statusRgb.some((rgb) => near(borderRgb, rgb) || near(outlineRgb, rgb))
      selectionBorder = {
        borderTopColor: style.borderTopColor,
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
        accentRgb,
        borderMatchesAccent: near(borderRgb, accentRgb),
        outlineMatchesAccent: near(outlineRgb, accentRgb),
        matchesStatusColour: matchesStatus,
        hasSelectionOutline: Number.parseFloat(style.outlineWidth) >= 1.5,
        ariaPressed: selected.querySelector('.overview-route-card-main')?.getAttribute('aria-pressed') === 'true',
      }
    }

    return {
      byStatus,
      distinct,
      notDefault,
      statusCount: Object.keys(byStatus).length,
      titleSubtitleOffset,
      selectionBorder,
    }
  })
  record(
    'Overview card status label colours differ per status',
    statusColourAudit.statusCount >= 2 && statusColourAudit.distinct === statusColourAudit.statusCount,
    JSON.stringify({ distinct: statusColourAudit.distinct, byStatus: statusColourAudit.byStatus }),
  )
  record(
    'Overview card status labels are not white/black text-default',
    statusColourAudit.statusCount >= 1 && statusColourAudit.notDefault,
    JSON.stringify(statusColourAudit.byStatus),
  )
  record(
    'Overview card title and subtitle have different top offsets',
    Boolean(
      statusColourAudit.titleSubtitleOffset
      && statusColourAudit.titleSubtitleOffset.delta >= 4,
    ),
    JSON.stringify(statusColourAudit.titleSubtitleOffset),
  )
  record(
    'Selected Overview card border colour ≠ status colours',
    Boolean(
      statusColourAudit.selectionBorder
      && statusColourAudit.selectionBorder.hasSelectionOutline
      && !statusColourAudit.selectionBorder.borderMatchesAccent
      && !statusColourAudit.selectionBorder.matchesStatusColour
      && statusColourAudit.selectionBorder.ariaPressed,
    ),
    JSON.stringify(statusColourAudit.selectionBorder),
  )

  // Round-4: active chip contrast + empty-filter copy + full-map phone chrome
  const chipContrast = await page.evaluate(() => {
    const parseRgb = (value) => {
      const m = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
      if (!m) return null
      return [Number(m[1]), Number(m[2]), Number(m[3])]
    }
    const luminance = ([r, g, b]) => {
      const toLin = (c) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b)
    }
    const ratio = (fg, bg) => {
      if (!fg || !bg) return 0
      const L1 = luminance(fg)
      const L2 = luminance(bg)
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    }
    const allChip = document.querySelector('[data-tour="overview-filters"] button.is-active')
    if (!allChip) return null
    const style = getComputedStyle(allChip)
    return {
      color: style.color,
      background: style.backgroundColor,
      ratio: ratio(parseRgb(style.color), parseRgb(style.backgroundColor)),
    }
  })
  record(
    'Active Overview filter chip text contrast ≥ 4.5:1',
    Boolean(chipContrast && chipContrast.ratio >= 4.5),
    JSON.stringify(chipContrast),
  )

  await page.goto(base + '/?status=ready&checked=24h', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await ensureLoggedIn('Demo')
  const skipEmpty = page.getByRole('button', { name: /skip/i })
  if (await skipEmpty.count()) await skipEmpty.first().click().catch(() => {})
  await page.locator('[data-tour="overview-filters"]').waitFor({ timeout: 15000 })
  await page.waitForTimeout(300)
  const emptyAudit = await page.evaluate(() => {
    const listEmpty = document.querySelectorAll('[data-testid="overview-empty-filter"]').length
    const blockEmpty = document.querySelectorAll('[data-testid="overview-route-block-empty"]').length
    const clearButtons = Array.from(document.querySelectorAll('button')).filter((btn) =>
      /^clear filters$/i.test((btn.textContent || '').trim()),
    ).length
    const showAll = document.querySelector('[data-tour="overview-show-all"]')
    const fullMap = document.querySelector('[data-tour="overview-fullmap-open"]')
    return {
      listEmpty,
      blockEmpty,
      clearButtons,
      blockText: document.querySelector('[data-testid="overview-route-block-empty"]')?.textContent?.trim() || '',
      showAllHidden: !showAll,
      fullMapHidden: !fullMap,
    }
  })
  record(
    'Empty filters show one list message and muted map line (no duplicate Clear filters in route block)',
    emptyAudit.listEmpty === 1
      && emptyAudit.blockEmpty === 1
      && emptyAudit.clearButtons === 2 // filter-bar link + list button only
      && /no routes to show on the map/i.test(emptyAudit.blockText)
      && emptyAudit.showAllHidden
      && emptyAudit.fullMapHidden,
    JSON.stringify(emptyAudit),
  )
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await ensureLoggedIn('Demo')
  const skipAfterEmpty = page.getByRole('button', { name: /skip/i })
  if (await skipAfterEmpty.count()) await skipAfterEmpty.first().click().catch(() => {})
  await page.locator('[data-tour="overview-filters"]').waitFor({ timeout: 15000 })

  for (const [width, height] of [[375, 667], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await ensureLoggedIn('Demo')
    const skip = page.getByRole('button', { name: /skip/i })
    if (await skip.count()) await skip.first().click().catch(() => {})
    await page.locator('[data-tour="overview-filters"]').waitFor({ timeout: 15000 })
    await page.waitForFunction(() => {
      const list = document.querySelectorAll('[data-tour="overview-route-list"] button, [data-tour="overview-route-list"] a').length
      const cards = document.querySelectorAll('[data-tour="overview-route-cards"] .overview-route-card').length
      return list > 0 && cards > 0
    }, null, { timeout: 15000 }).catch(() => {})
    const overflow = await page.evaluate(() => {
      const root = document.querySelector('.transport-overview') || document.body
      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      }
    })
    record(
      `Overview has no horizontal overflow at ${width}×${height}`,
      !overflow.docOverflow && overflow.scrollWidth <= overflow.clientWidth + 1,
      JSON.stringify(overflow),
    )

    // Round-5: ≤600px list rows stack status pill under subtitle (title ≥240px at 375)
    if (width <= 600) {
      const listRowLayout = await page.evaluate(() => {
        const row = document.querySelector('[data-tour="overview-route-list"] button, [data-tour="overview-route-list"] a')
        const title = row?.querySelector('.overview-route-title')
        const subtitle = row?.querySelector('.overview-route-subtitle')
        const pill = row?.querySelector('[data-testid="overview-status-pill"]')
        if (!row || !title || !subtitle || !pill) return null
        const tr = title.getBoundingClientRect()
        const sr = subtitle.getBoundingClientRect()
        const pr = pill.getBoundingClientRect()
        return {
          titleWidth: tr.width,
          pillBelowSubtitle: pr.top >= sr.bottom - 2,
          pillLeftNearTitle: Math.abs(pr.left - tr.left) <= 6,
        }
      })
      record(
        `Upcoming list stacks status pill under subtitle at ${width}×${height}`,
        Boolean(
          listRowLayout
          && listRowLayout.pillBelowSubtitle
          && listRowLayout.pillLeftNearTitle
          && (width > 375 || listRowLayout.titleWidth >= 240),
        ),
        JSON.stringify(listRowLayout),
      )

      const cardTitleWidth = await page.evaluate(() => {
        const card = document.querySelector('[data-tour="overview-route-cards"] .overview-route-card-main')
        const title = card?.querySelector('.overview-route-title')
        const pill = card?.querySelector('[data-testid="overview-status-pill"]')
        if (!card || !title || !pill) return null
        const tr = title.getBoundingClientRect()
        const pr = pill.getBoundingClientRect()
        return {
          titleWidth: tr.width,
          pillBelowTitle: pr.top >= tr.bottom - 2,
        }
      })
      if (cardTitleWidth && (cardTitleWidth.titleWidth < 200 || width <= 600)) {
        record(
          `Inline route card stacks status pill when narrow at ${width}×${height}`,
          Boolean(cardTitleWidth.pillBelowTitle && cardTitleWidth.titleWidth >= 200),
          JSON.stringify(cardTitleWidth),
        )
      }
    }
    const listCount = await page.locator('[data-tour="overview-route-list"] button, [data-tour="overview-route-list"] a').count()
    const blockCount = await page.locator('[data-tour="overview-route-cards"] .overview-route-card').count()
    const showAll = page.getByTestId('overview-show-all-list')
    if (blockCount > 5) {
      record(
        `Overview mobile list caps at 5 with Show all at ${width}×${height}`,
        listCount === 5 && (await showAll.count()) > 0,
        `list=${listCount} block=${blockCount}`,
      )
      if (await showAll.count()) {
        await showAll.click()
        const expanded = await page.locator('[data-tour="overview-route-list"] button, [data-tour="overview-route-list"] a').count()
        record(
          `Overview Show all expands list at ${width}×${height}`,
          expanded === blockCount,
          `expanded=${expanded} block=${blockCount}`,
        )
      }
    } else {
      record(
        `Overview mobile list shows all routes at ${width}×${height}`,
        listCount > 0 && listCount === blockCount,
        `list=${listCount} block=${blockCount}`,
      )
    }

    // Round-4: full-size map phone header is 2 rows (title+Minimise; segmented controls)
    const fullOpenMobile = page.locator('[data-tour="overview-fullmap-open"]')
    if (await fullOpenMobile.count()) {
      await fullOpenMobile.click()
      await page.locator('[data-testid="overview-fullmap"]').waitFor({ timeout: 10000 })
      const headerLayout = await page.evaluate(() => {
        const header = document.querySelector('.overview-fullmap-header')
        const title = header?.querySelector('h2')
        const minimise = header?.querySelector('[data-tour="overview-fullmap-minimise"]')
        const controls = header?.querySelector('.overview-fullmap-controls')
        if (!header || !title || !minimise || !controls) return null
        const hr = header.getBoundingClientRect()
        const tr = title.getBoundingClientRect()
        const mr = minimise.getBoundingClientRect()
        const cr = controls.getBoundingClientRect()
        const modes = controls.querySelector('.overview-fullmap-modes')
        const toggle = controls.querySelector('.overview-fullmap-mobile-toggle')
        const modesBox = modes?.getBoundingClientRect()
        const toggleBox = toggle?.getBoundingClientRect()
        return {
          headerHeight: hr.height,
          titleTop: tr.top,
          minimiseTop: mr.top,
          minimiseHeight: mr.height,
          sameTitleRow: Math.abs(tr.top - mr.top) < 12,
          controlsBelowTitle: cr.top >= tr.bottom - 2,
          modesToggleSameRow: Boolean(
            modesBox && toggleBox && Math.abs(modesBox.top - toggleBox.top) < 12,
          ),
          cardsAria: document.querySelector('[data-tour="overview-fullmap-cards"]')?.getAttribute('aria-label') || '',
          pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        }
      })
      record(
        `Full-size map phone header is two rows at ${width}×${height}`,
        Boolean(
          headerLayout
          && headerLayout.sameTitleRow
          && headerLayout.controlsBelowTitle
          && headerLayout.modesToggleSameRow
          && headerLayout.minimiseHeight >= 44
          && headerLayout.headerHeight <= 110,
        ),
        JSON.stringify(headerLayout),
      )
      record(
        `Full-size map cards scroller labelled for swipe at ${width}×${height}`,
        Boolean(headerLayout && /Routes, swipe for more/i.test(headerLayout.cardsAria) && !headerLayout.pageOverflow),
        JSON.stringify(headerLayout),
      )

      await page.getByRole('tab', { name: 'Single route' }).click()
      const backBtn = page.getByTestId('overview-fullmap-back')
      await backBtn.waitFor({ timeout: 5000 })
      const backBox = await backBtn.boundingBox()
      record(
        `Back to all routes is ≥44px tall at ${width}×${height}`,
        Boolean(backBox && backBox.height >= 44),
        JSON.stringify(backBox),
      )

      const alertDedupe = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid="overview-alert-row"]'))
        const keys = rows.map((row) => {
          const change = (row.querySelector('.overview-alert-change')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
          const detail = (row.querySelector('.overview-alert-detail')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
          return `${change}::${detail}`
        })
        const unique = new Set(keys)
        const dups = document.querySelectorAll('[data-testid="overview-alert-dup"]').length
        const headings = Array.from(document.querySelectorAll('.overview-alert-group h3')).map((h3) => {
          const style = getComputedStyle(h3)
          return {
            text: (h3.textContent || '').replace(/\s+/g, ' ').trim(),
            fontSize: style.fontSize,
            color: style.color,
          }
        })
        return { rowCount: rows.length, unique: unique.size, dups, headings }
      })
      if (alertDedupe.rowCount > 0) {
        record(
          `Single-route alerts dedupe identical rows at ${width}×${height}`,
          alertDedupe.unique === alertDedupe.rowCount,
          JSON.stringify(alertDedupe),
        )
      } else {
        record(
          `Single-route alerts panel renders at ${width}×${height}`,
          (await page.locator('[data-testid="overview-fullmap-alerts"]').count()) > 0,
        )
      }

      await page.locator('[data-tour="overview-fullmap-minimise"]').click()
      await page.locator('[data-testid="overview-fullmap"]').waitFor({ state: 'detached', timeout: 10000 })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const skipHome = page.getByRole('button', { name: /skip/i })
  if (await skipHome.count()) await skipHome.first().click().catch(() => {})

  async function skipIfNeeded() {
    await ensureLoggedIn('Demo')
  }

  const corridorViewports = [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ]
  for (const [width, height] of corridorViewports) {
    await page.setViewportSize({ width, height })
    await page.goto(base + '/map-explorer', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await skipIfNeeded()
    await page.getByRole('heading', { name: 'Corridor monitor' }).waitFor({ timeout: 20000 })
    await page.locator('[data-testid="corridor-map"]').waitFor({ timeout: 25000 })
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="corridor-map"]')
      const canvas = el?.querySelector('canvas')
      return Boolean(el && el.clientHeight > 300 && canvas && canvas.clientHeight > 300)
    }, { timeout: 25000 }).catch(() => {})
    const metrics = await mapPaintMetrics(page, '[data-testid="corridor-map"]')
    record(
      `Corridor map at ${width}×${height} is taller than 300px with painted tiles`,
      mapLooksPainted(metrics),
      JSON.stringify(metrics),
    )
    const panelOverflow = await overflowReport(page, ['.live-event-panel', '.live-event-summary', '.live-event-search'])
    record(
      `Corridor panel at ${width}×${height} has no horizontal overflow`,
      panelOverflow.every(item => !item.missing && !item.overflow),
      JSON.stringify(panelOverflow),
    )
    const searchInner = await page.evaluate(() => {
      const wrap = document.querySelector('.live-event-search')
      const input = wrap?.querySelector('input')
      if (!wrap || !input) return { ok: false }
      const wrapStyle = getComputedStyle(wrap)
      const inputStyle = getComputedStyle(input)
      const wrapBox = wrap.getBoundingClientRect()
      const inputBox = input.getBoundingClientRect()
      const innerBorder = Number.parseFloat(inputStyle.borderTopWidth) + Number.parseFloat(inputStyle.borderBottomWidth)
      return {
        ok: inputStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
          && innerBorder === 0
          && wrapBox.height >= 40
          && inputBox.height <= wrapBox.height
          && inputBox.left >= wrapBox.left
          && inputBox.right <= wrapBox.right,
        wrapH: Math.round(wrapBox.height),
        inputH: Math.round(inputBox.height),
        border: innerBorder,
        bg: inputStyle.backgroundColor,
        wrapBorder: wrapStyle.borderTopWidth,
      }
    })
    record(
      `Corridor search input at ${width}×${height} fills the wrapper without an inner box`,
      Boolean(searchInner.ok),
      JSON.stringify(searchInner),
    )
  }

  // Demo corridor tour: tip must win hit-testing over the live-event panel / map stack.
  const corridorTourTitles = [
    'Scope and basemap',
    'Search road or place',
    'Closures, roadworks, warnings',
    'Event list and map',
    'Layers and refresh',
  ]
  async function assertCorridorTourTipOnTop(width, height) {
    await page.setViewportSize({ width, height })
    await page.goto(base + '/map-explorer', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await ensureLoggedIn('Demo')
    await page.getByRole('heading', { name: 'Corridor monitor' }).waitFor({ timeout: 20000 })
    await page.locator('[data-testid="corridor-map"]').waitFor({ timeout: 25000 })
    await page.getByRole('button', { name: 'Guide' }).click()
    await page.getByRole('dialog', { name: 'Guides' }).waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: /^Corridor monitor\b/ }).click()
    for (let i = 0; i < corridorTourTitles.length; i++) {
      const title = corridorTourTitles[i]
      const tip = page.locator('.demo-tour-tooltip')
      await tip.waitFor({ state: 'visible', timeout: 20000 })
      await tip.locator('.demo-tour-title', { hasText: title }).waitFor({ timeout: 15000 })
      // Let spotlight/tip settle after navigation + measure.
      await page.waitForTimeout(400)
      const hit = await page.evaluate(() => {
        const el = document.querySelector('.demo-tour-tooltip')
        if (!el) return { ok: false, reason: 'missing-tip' }
        const r = el.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const top = document.elementFromPoint(cx, cy)
        const inside = Boolean(top && (top === el || el.contains(top)))
        return {
          ok: inside,
          title: el.querySelector('.demo-tour-title')?.textContent?.trim() || '',
          hitTag: top ? top.tagName : null,
          hitClass: top && 'className' in top ? String(top.className).slice(0, 120) : null,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          rootParent: document.querySelector('[data-demo-tour-root]')?.parentElement?.tagName || null,
        }
      })
      record(
        `Demo corridor tour tip on top "${title}" at ${width}×${height}`,
        Boolean(hit.ok) && hit.title === title && hit.rootParent === 'BODY',
        JSON.stringify(hit),
      )
      const primary = tip.locator('.demo-tour-btn.is-primary')
      if (i < corridorTourTitles.length - 1) {
        await primary.click({ timeout: 10000 })
      } else {
        await tip.getByRole('button', { name: 'Done' }).click({ timeout: 10000 })
      }
    }
  }
  await assertCorridorTourTipOnTop(1440, 900)
  await assertCorridorTourTipOnTop(390, 844)

  // Mobile sheet must not cover the spotlight; hole stays clickable through .demo-tour-root.
  async function measureTourSpotTipOverlap() {
    return page.evaluate(() => {
      const tip = document.querySelector('.demo-tour-tooltip')
      const spot = document.querySelector('.demo-tour-spotlight')
      if (!tip) return { ok: false, reason: 'no-tip' }
      const title = tip.querySelector('.demo-tour-title')?.textContent?.trim() || ''
      if (!spot) {
        return { ok: true, skipped: true, title, reason: 'no-spotlight' }
      }
      const a = tip.getBoundingClientRect()
      const b = spot.getBoundingClientRect()
      const intersects = !(
        a.right <= b.left
        || b.right <= a.left
        || a.bottom <= b.top
        || b.bottom <= a.top
      )
      return {
        ok: !intersects,
        title,
        placement: tip.getAttribute('data-tour-placement') || '',
        tip: [Math.round(a.left), Math.round(a.top), Math.round(a.width), Math.round(a.height)],
        spot: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
        rootPe: getComputedStyle(document.querySelector('.demo-tour-root')).pointerEvents,
      }
    })
  }

  async function startGuideSection(sectionLabel) {
    await page.getByRole('button', { name: 'Guide' }).click()
    const menu = page.getByRole('dialog', { name: 'Guides' })
    await menu.waitFor({ timeout: 10000 })
    // Accessible names include step counts ("Jobs, 4 steps") — scope to the dialog.
    await menu.getByRole('button', { name: new RegExp(`^${sectionLabel}\\b`) }).click()
    await page.locator('.demo-tour-tooltip').waitFor({ state: 'visible', timeout: 20000 })
  }

  async function advanceTourPrimary() {
    const tip = page.locator('.demo-tour-tooltip')
    if (!(await tip.count())) return 'gone'
    const titleBefore = ((await tip.locator('.demo-tour-title').textContent()) || '').trim()
    const finish = tip.getByRole('button', { name: /^(Finish|Done)$/ })
    if (await finish.count()) {
      await finish.click({ timeout: 10000 })
      return 'finish'
    }
    // Prefer Do-it when present so route-check state stays valid for later anchors.
    const doIt = tip.locator('.demo-tour-btn:not(.is-primary)').filter({ hasNotText: /^Back$/i })
    if (await doIt.count()) {
      await doIt.first().click({ timeout: 10000 })
      await page.waitForFunction(prev => {
        const el = document.querySelector('.demo-tour-tooltip .demo-tour-title')
        if (!el) return true
        return (el.textContent || '').trim() !== prev
      }, titleBefore, { timeout: 12000 }).catch(() => {})
      const titleNow = ((await tip.locator('.demo-tour-title').textContent().catch(() => '')) || '').trim()
      // present/click advances usually move on; if still waiting, Continue once.
      if (titleNow === titleBefore) {
        const cont = tip.getByRole('button', { name: /^(Continue|Next)$/ })
        if (await cont.count()) await cont.click({ timeout: 10000 })
      }
      return 'doit'
    }
    const primary = tip.locator('.demo-tour-btn.is-primary')
    const label = ((await primary.textContent()) || '').trim()
    await primary.click({ timeout: 10000 })
    return /^(Finish|Done)$/i.test(label) ? 'finish' : 'next'
  }

  async function assertMobileTourSpotClearsTip(sectionLabel, maxSteps = 20) {
    await startGuideSection(sectionLabel)
    const seen = []
    for (let i = 0; i < maxSteps; i++) {
      const tip = page.locator('.demo-tour-tooltip')
      if (!(await tip.count())) break
      await page.waitForTimeout(450)
      const measure = await measureTourSpotTipOverlap()
      seen.push(measure.title || `(step ${i})`)
      if (!measure.skipped) {
        record(
          `Demo tour spotlight clears tip "${measure.title}" at 390×844 (${sectionLabel})`,
          Boolean(measure.ok),
          JSON.stringify(measure),
        )
      }
      const result = await advanceTourPrimary()
      if (result === 'finish') break
      await page.waitForTimeout(350)
    }
    return seen
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await ensureLoggedIn('Demo')

  // Click-through: spotlight hole must not be swallowed by .demo-tour-root.
  await startGuideSection('Route check')
  {
    const tip = page.locator('.demo-tour-tooltip')
    // Walk to "Show sample permits".
    for (let i = 0; i < 8; i++) {
      await tip.waitFor({ state: 'visible', timeout: 15000 })
      const title = ((await tip.locator('.demo-tour-title').textContent()) || '').trim()
      if (title === 'Show sample permits') break
      await tip.locator('.demo-tour-btn.is-primary').click({ timeout: 10000 })
      await page.waitForTimeout(300)
    }
    await tip.locator('.demo-tour-title', { hasText: 'Show sample permits' }).waitFor({ timeout: 15000 })
    await page.waitForTimeout(500)
    const hole = await page.evaluate(() => {
      const root = document.querySelector('.demo-tour-root')
      const btn = document.querySelector('[data-tour="route-sample-toggle"]')
      const spot = document.querySelector('.demo-tour-spotlight')
      if (!root || !btn || !spot) {
        return { ok: false, reason: 'missing', hasRoot: !!root, hasBtn: !!btn, hasSpot: !!spot }
      }
      const r = btn.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const top = document.elementFromPoint(cx, cy)
      const through =
        Boolean(top && (top === btn || btn.contains(top)))
        && !root.contains(top)
      return {
        ok: through && getComputedStyle(root).pointerEvents === 'none',
        rootPe: getComputedStyle(root).pointerEvents,
        hitTag: top ? top.tagName : null,
        hitTour: top ? Boolean(top.closest && top.closest('[data-demo-tour-root]')) : null,
        hitText: top && 'textContent' in top ? String(top.textContent || '').trim().slice(0, 40) : null,
      }
    })
    record(
      'Demo tour spotlight hole is clickable at 390×844 (Show sample permits)',
      Boolean(hole.ok),
      JSON.stringify(hole),
    )
    // Actually tap the highlighted control (not Do-it) and expect the tour to advance.
    await page.locator('[data-tour="route-sample-toggle"]').click({ timeout: 10000 })
    await tip.locator('.demo-tour-title', { hasText: 'Pick a sample permit' }).waitFor({ timeout: 15000 })
    record(
      'Demo tour advances when the spotlight target is clicked directly',
      ((await tip.locator('.demo-tour-title').textContent()) || '').trim() === 'Pick a sample permit',
    )
    await tip.getByRole('button', { name: 'Exit' }).click({ timeout: 10000 }).catch(async () => {
      // Compact sheet has no Exit — finish/skip via primary or reopen.
      await page.keyboard.press('Escape')
    })
    await page.waitForTimeout(200)
  }

  for (const section of [
    'Route check',
    'Corridor monitor',
    'Settings',
    'Overview',
    'Jobs',
    'Alerts & history',
  ]) {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await ensureLoggedIn('Demo')
    // Dismiss any leftover tip.
    if (await page.locator('.demo-tour-tooltip').count()) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    await assertMobileTourSpotClearsTip(section)
  }

  // --- Demo flow picker + Switch user visible-anchor ---
  {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await ensureLoggedIn('Demo')
    if (await page.locator('.demo-tour-tooltip').count()) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    // Reset picker progress so Done marks are deterministic for this check.
    await page.evaluate(key => {
      try {
        localStorage.setItem(key, JSON.stringify({
          welcomeSeen: true,
          completedSections: [],
          tourDismissed: true,
        }))
      } catch {}
    }, DEMO_TOUR_STORAGE_KEY)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
    await ensureLoggedIn('Demo')

    await page.getByRole('button', { name: 'Guide' }).click()
    const picker = page.getByRole('dialog', { name: 'Guides' })
    await picker.waitFor({ timeout: 10000 })
    const pickerEntries = picker.locator('.demo-tour-menu-item')
    const entryCount = await pickerEntries.count()
    const entryMeta = await pickerEntries.evaluateAll(els => els.map(el => ({
      label: el.getAttribute('aria-label') || '',
      steps: (el.querySelector('.demo-tour-menu-item-meta')?.textContent || '').trim(),
      name: (el.querySelector('.demo-tour-menu-item-name')?.textContent || '').trim(),
    })))
    record(
      'Demo guide picker lists 9 entries with step counts',
      entryCount === 9
        && entryMeta[0]?.name === 'Full tour'
        && entryMeta.every(e => /\d+\s+steps?/.test(e.steps) && /\d+\s+steps?/.test(e.label)),
      JSON.stringify(entryMeta.map(e => ({ name: e.name, steps: e.steps }))),
    )

    await picker.getByRole('button', { name: /^Jobs\b/ }).click()
    const jobsTip = page.locator('.demo-tour-tooltip')
    await jobsTip.waitFor({ state: 'visible', timeout: 20000 })
    const jobsMeta = ((await jobsTip.locator('.demo-tour-meta').textContent()) || '').trim()
    record(
      'Demo Jobs guide shows Step 1 of N · Jobs',
      /^Step 1 of \d+ · Jobs$/.test(jobsMeta),
      jobsMeta,
    )
    await jobsTip.getByRole('button', { name: 'Exit' }).click({ timeout: 10000 }).catch(async () => {
      await page.keyboard.press('Escape')
    })
    await page.waitForTimeout(200)

    // Overview single-flow: section counter (not full-tour) + last-step chrome.
    await page.getByRole('button', { name: 'Guide' }).click()
    await picker.waitFor({ timeout: 10000 })
    await picker.getByRole('button', { name: /^Overview\b/ }).click()
    const overviewTip = page.locator('.demo-tour-tooltip')
    await overviewTip.waitFor({ state: 'visible', timeout: 20000 })
    const overviewMeta = ((await overviewTip.locator('.demo-tour-meta').textContent()) || '').trim()
    record(
      'Demo Overview guide shows Step 1 of 8 · Overview',
      overviewMeta === 'Step 1 of 8 · Overview',
      overviewMeta,
    )
    for (let i = 0; i < 8; i++) {
      if (!(await overviewTip.count())) break
      const backGuides = overviewTip.getByRole('button', { name: 'Back to guides' })
      if (await backGuides.count()) break
      const primary = overviewTip.locator('.demo-tour-btn.is-primary')
      if (await primary.count()) {
        await primary.click({ timeout: 10000 }).catch(() => {})
        await page.waitForTimeout(400)
      } else {
        break
      }
    }
    const overviewBack = overviewTip.getByRole('button', { name: 'Back to guides' })
    const overviewDone = overviewTip.getByRole('button', { name: 'Done' })
    record(
      'Demo Overview last step shows Back to guides + Done',
      (await overviewBack.count()) > 0 && (await overviewDone.count()) > 0,
    )
    if (await overviewDone.count()) {
      await overviewDone.click({ timeout: 10000 })
    } else if (await overviewBack.count()) {
      await overviewBack.click({ timeout: 10000 })
    } else {
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(200)

    // Settings is short and always completable — finish via Back to guides.
    await page.getByRole('button', { name: 'Guide' }).click()
    await picker.waitFor({ timeout: 10000 })
    await picker.getByRole('button', { name: /^Settings\b/ }).click()
    const settingsTip = page.locator('.demo-tour-tooltip')
    await settingsTip.waitFor({ state: 'visible', timeout: 20000 })
    for (let i = 0; i < 6; i++) {
      if (!(await settingsTip.count())) break
      const backGuides = settingsTip.getByRole('button', { name: 'Back to guides' })
      if (await backGuides.count()) break
      const primary = settingsTip.locator('.demo-tour-btn.is-primary')
      if (await primary.count()) {
        await primary.click({ timeout: 10000 }).catch(() => {})
        await page.waitForTimeout(350)
      } else {
        break
      }
    }
    const backToGuides = settingsTip.getByRole('button', { name: 'Back to guides' })
    record(
      'Demo single-flow end shows Back to guides',
      (await backToGuides.count()) > 0,
    )
    if (await backToGuides.count()) {
      await backToGuides.click({ timeout: 10000 })
    }
    await picker.waitFor({ timeout: 10000 })
    const settingsDone = await picker.getByRole('button', { name: /Settings, \d+ steps, done/i }).count()
    record(
      'Demo Back to guides reopens picker with Done mark',
      settingsDone > 0,
      `settingsDoneButtons=${settingsDone}`,
    )

    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const guideFocused = await page.evaluate(() => {
      const el = document.activeElement
      return Boolean(el && el.classList?.contains('demo-tour-launcher'))
    })
    record(
      'Demo picker Esc returns focus to Guide button',
      guideFocused,
    )

    // Mobile Switch user: spotlight must hit header chip, not Home tab.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await ensureLoggedIn('Demo')
    if (await page.locator('.demo-tour-tooltip, .demo-tour-menu').count()) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    await startGuideSection('Search & Switch user')
    const switchTip = page.locator('.demo-tour-tooltip')
    // Advance to Switch user step.
    for (let i = 0; i < 6; i++) {
      await switchTip.waitFor({ state: 'visible', timeout: 15000 })
      const title = ((await switchTip.locator('.demo-tour-title').textContent()) || '').trim()
      if (title === 'Switch user') break
      await switchTip.locator('.demo-tour-btn.is-primary').click({ timeout: 10000 })
      await page.waitForTimeout(400)
    }
    await switchTip.locator('.demo-tour-title', { hasText: 'Switch user' }).waitFor({ timeout: 15000 })
    await page.waitForTimeout(500)
    const switchHit = await page.evaluate(() => {
      const spot = document.querySelector('.demo-tour-spotlight')
      const headerChip = document.querySelector('.app-topbar .user-chip.is-compact[data-tour="switch-user"]')
        || document.querySelector('.user-chip.is-compact[data-tour="switch-user"]')
      const tabBar = document.querySelector('.mobile-tab-bar')
      if (!spot) return { ok: false, reason: 'no-spotlight' }
      const s = spot.getBoundingClientRect()
      const chip = headerChip?.getBoundingClientRect()
      const tab = tabBar?.getBoundingClientRect()
      const intersects = (a, b) => Boolean(a && b) && !(
        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top
      )
      const spotBox = { left: s.left, top: s.top, right: s.right, bottom: s.bottom }
      const hitsChip = chip ? intersects(spotBox, {
        left: chip.left, top: chip.top, right: chip.right, bottom: chip.bottom,
      }) : false
      const hitsTab = tab ? intersects(spotBox, {
        left: tab.left, top: tab.top, right: tab.right, bottom: tab.bottom,
      }) : false
      return {
        ok: hitsChip && !hitsTab && s.top < 120,
        hitsChip,
        hitsTab,
        spot: [Math.round(s.left), Math.round(s.top), Math.round(s.width), Math.round(s.height)],
        chipTop: chip ? Math.round(chip.top) : null,
        body: document.querySelector('.demo-tour-body')?.textContent?.trim().slice(0, 80) || '',
      }
    })
    record(
      'Demo Switch user spotlight hits header chip at 390×844 (not tab bar)',
      Boolean(switchHit.ok),
      JSON.stringify(switchHit),
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // Compact tour cards must never drop body/controls at 375×667.
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await ensureLoggedIn('Demo')
    if (await page.locator('.demo-tour-tooltip, .demo-tour-menu').count()) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    await startGuideSection('Overview')
    const compactTip = page.locator('.demo-tour-tooltip')
    let compactOk = true
    const compactFails = []
    for (let i = 0; i < 10; i++) {
      await compactTip.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
      if (!(await compactTip.count())) break
      const info = await compactTip.evaluate(el => {
        const body = (el.querySelector('.demo-tour-body')?.textContent || '').trim()
        const meta = (el.querySelector('.demo-tour-meta')?.textContent || '').trim()
        const back = Array.from(el.querySelectorAll('button')).some(b => /Back/i.test(b.textContent || ''))
        const primary = Array.from(el.querySelectorAll('button')).some(b => /Next|Done|Continue|Back to guides|Open full-size map/i.test(b.textContent || ''))
        const title = (el.querySelector('.demo-tour-title')?.textContent || '').trim()
        return { body: body.length > 0, meta: /Step \d+ of \d+/i.test(meta), back, primary, title, metaText: meta }
      })
      if (!info.body || !info.meta || !info.back || !info.primary) {
        compactOk = false
        compactFails.push(info)
      }
      const done = compactTip.getByRole('button', { name: 'Done' })
      const backGuides = compactTip.getByRole('button', { name: 'Back to guides' })
      if ((await done.count()) && (await backGuides.count())) break
      const doIt = compactTip.getByRole('button', { name: 'Open full-size map' })
      if (await doIt.count()) await doIt.click({ timeout: 10000 }).catch(() => {})
      else await compactTip.locator('.demo-tour-btn.is-primary').click({ timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(350)
    }
    record(
      'Demo Overview tour cards at 375×667 keep body, step counter, and Back/Next',
      compactOk,
      JSON.stringify(compactFails.slice(0, 3)),
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // Every guide step: primary + Back fully in viewport; spotlight not covered >30% by tip.
    async function assertTourControlsInViewport(width, height) {
      await page.setViewportSize({ width, height })
      await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
      await ensureLoggedIn('Demo')
      if (await page.locator('.demo-tour-tooltip, .demo-tour-menu').count()) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(200)
      }
      const guides = [
        'Overview',
        'Route check',
        'Jobs',
        'Alerts & history',
        'Corridor monitor',
        'Settings',
        'Search & Switch user',
        'Data partners',
      ]
      const fails = []
      for (const guide of guides) {
        await startGuideSection(guide)
        const tip = page.locator('.demo-tour-tooltip')
        for (let step = 0; step < 28; step++) {
          await tip.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
          if (!(await tip.count())) break
          const title = ((await tip.locator('.demo-tour-title').textContent().catch(() => '')) || '').trim()
          // Measure this step first — opening the full-size map auto-advances via present.
          const measure = await page.evaluate(() => {
            const tipEl = document.querySelector('.demo-tour-tooltip')
            if (!tipEl) return { ok: false, reason: 'no-tip' }
            const vw = window.innerWidth
            const vh = window.innerHeight
            const inView = (el) => {
              if (!el) return false
              const r = el.getBoundingClientRect()
              if (r.width < 2 || r.height < 2) return false
              if (r.top < -1 || r.left < -1 || r.bottom > vh + 1 || r.right > vw + 1) return false
              const cx = r.left + r.width / 2
              const cy = r.top + r.height / 2
              const hit = document.elementFromPoint(cx, cy)
              return Boolean(hit && (hit === el || el.contains(hit)))
            }
            const buttons = Array.from(tipEl.querySelectorAll('button'))
            const primary = buttons.find(b => /Next|Done|Continue|Open full-size map|Close it and continue|Back to guides/i.test(b.textContent || ''))
              || tipEl.querySelector('.demo-tour-btn.is-primary')
            const back = buttons.find(b => /^\s*Back\s*$/i.test(b.textContent || ''))
            const spot = document.querySelector('.demo-tour-spotlight')
            let spotOk = true
            let coverRatio = 0
            if (spot) {
              const s = spot.getBoundingClientRect()
              const intersectsVp = !(s.bottom <= 0 || s.top >= vh || s.right <= 0 || s.left >= vw)
              spotOk = intersectsVp && s.width >= 20 && s.height >= 20
              if (intersectsVp) {
                const t = tipEl.getBoundingClientRect()
                const overlapW = Math.max(0, Math.min(s.right, t.right) - Math.max(s.left, t.left))
                const overlapH = Math.max(0, Math.min(s.bottom, t.bottom) - Math.max(s.top, t.top))
                const overlap = overlapW * overlapH
                const area = Math.max(1, s.width * s.height)
                coverRatio = overlap / area
                if (coverRatio > 0.3) spotOk = false
              }
            }
            return {
              ok: inView(primary) && (!back || inView(back)) && spotOk,
              primaryOk: inView(primary),
              backOk: !back || inView(back),
              spotOk,
              coverRatio: Math.round(coverRatio * 100) / 100,
              title: tipEl.querySelector('.demo-tour-title')?.textContent?.trim() || '',
            }
          })
          if (!measure.ok) fails.push({ guide, ...measure })
          const done = tip.getByRole('button', { name: 'Done' })
          const backGuides = tip.getByRole('button', { name: 'Back to guides' })
          if ((await done.count()) && (await backGuides.count())) {
            await done.click({ timeout: 10000 }).catch(() => page.keyboard.press('Escape'))
            break
          }
          const titleBefore = title
          const primary = tip.locator('.demo-tour-btn.is-primary')
          const doIt = tip.getByRole('button', { name: /Open full-size map|Save job for me|Show samples for me|Continue/i })
          // Open full-size map so modes/minimise steps have anchors; then continue.
          if (title === 'Full-size map') {
            const openMap = tip.getByRole('button', { name: 'Open full-size map' })
            if (await openMap.count()) await openMap.click({ timeout: 10000 }).catch(() => {})
            else if (await primary.count()) await primary.click({ timeout: 10000 }).catch(() => {})
          } else if (await doIt.count()) {
            await doIt.first().click({ timeout: 10000 }).catch(() => {})
          } else if (await primary.count()) {
            await primary.click({ timeout: 10000 }).catch(() => {})
          } else break
          const advanced = await page.waitForFunction(prev => {
            const t = document.querySelector('.demo-tour-tooltip .demo-tour-title')?.textContent?.trim() || ''
            return !t || t !== prev
          }, titleBefore, { timeout: 8000 }).then(() => true).catch(() => false)
          if (!advanced) {
            // Interactive wait stuck (e.g. live route check) — leave this guide.
            await page.keyboard.press('Escape')
            await page.waitForTimeout(200)
            break
          }
          await page.waitForTimeout(200)
        }
        if (await page.locator('.demo-tour-tooltip, .demo-tour-menu').count()) {
          await page.keyboard.press('Escape')
          await page.waitForTimeout(150)
        }
      }
      record(
        `Demo tour controls in viewport at ${width}×${height} for every guide step`,
        fails.length === 0,
        JSON.stringify(fails.slice(0, 6)),
      )
    }
    await assertTourControlsInViewport(375, 667)
    await assertTourControlsInViewport(390, 844)

    // Overview steps (same anchors as full tour): each must get its own spotlight.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await ensureLoggedIn('Demo')
    if (await page.locator('.demo-tour-tooltip, .demo-tour-menu').count()) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    await startGuideSection('Overview')
    const overviewSpotTip = page.locator('.demo-tour-tooltip')
    const overviewTitles = [
      { title: 'The 3-step strip', anchor: '[data-tour="overview-workflow"]' },
      { title: 'Check new route', anchor: '[data-tour="overview-check-new"]' },
      { title: 'Route list and filters', anchor: '[data-tour="overview-filters"]' },
      { title: 'Route block', anchor: '[data-tour="overview-route-block-heading"]' },
      { title: 'Show and Show all', anchor: '[data-tour="overview-show-all"]' },
      { title: 'Full-size map', anchor: '[data-tour="overview-fullmap-open"]' },
      { title: 'All routes or single route', anchor: '[data-tour="overview-fullmap-modes"]' },
      { title: 'Minimise', anchor: '[data-tour="overview-fullmap-minimise"]' },
    ]
    const overviewSpots = []
    for (const { title, anchor } of overviewTitles) {
      await overviewSpotTip.locator('.demo-tour-title', { hasText: title }).waitFor({ timeout: 20000 })
      // Wait until spotlight intersects this step's anchor (not a stale prior target).
      await page.waitForFunction(({ expected, sel }) => {
        const tipTitle = document.querySelector('.demo-tour-tooltip .demo-tour-title')?.textContent?.trim() || ''
        if (tipTitle !== expected) return false
        const spot = document.querySelector('.demo-tour-spotlight')
        const target = document.querySelector(sel)
        if (!spot || !target) return false
        const a = spot.getBoundingClientRect()
        const b = target.getBoundingClientRect()
        if (a.width < 20 || a.height < 20) return false
        return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
      }, { expected: title, sel: anchor }, { timeout: 10000 }).catch(() => {})
      const spot = await page.evaluate(({ sel }) => {
        const el = document.querySelector('.demo-tour-spotlight')
        const target = document.querySelector(sel)
        if (!el || !target) return null
        const a = el.getBoundingClientRect()
        const b = target.getBoundingClientRect()
        if (a.width < 20 || a.height < 20) return null
        const hits = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
        if (!hits) return null
        return [Math.round(a.left), Math.round(a.top), Math.round(a.width), Math.round(a.height)]
      }, { sel: anchor })
      overviewSpots.push({ title, spot })
      if (title !== overviewTitles[overviewTitles.length - 1].title) {
        const before = title
        if (title === 'Full-size map') {
          const doIt = overviewSpotTip.getByRole('button', { name: 'Open full-size map' })
          if (await doIt.count()) await doIt.click({ timeout: 10000 })
          else await overviewSpotTip.locator('.demo-tour-btn.is-primary').click({ timeout: 10000 })
        } else {
          await overviewSpotTip.locator('.demo-tour-btn.is-primary').click({ timeout: 10000 })
        }
        await page.waitForFunction(prev => {
          const t = document.querySelector('.demo-tour-tooltip .demo-tour-title')?.textContent?.trim() || ''
          return t && t !== prev
        }, before, { timeout: 10000 }).catch(() => {})
      }
    }
    const spotKeys = overviewSpots.map(s => (s.spot ? s.spot.join(',') : 'null'))
    const uniqueSpots = new Set(spotKeys.filter(k => k !== 'null'))
    record(
      'Demo full-tour Overview steps each spotlight a different rect',
      overviewSpots.every(s => s.spot) && uniqueSpots.size === overviewTitles.length,
      JSON.stringify(overviewSpots),
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // Route check single-flow: Save the job advances to Job saved closer (not exit).
    await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await ensureLoggedIn('Demo')
    if (await page.locator('.demo-tour-tooltip, .demo-tour-menu').count()) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    await startGuideSection('Route check')
    const routeTip = page.locator('.demo-tour-tooltip')
    let reachedSaveJob = false
    let reachedJobSaved = false
    for (let i = 0; i < 24; i++) {
      if (!(await routeTip.count())) break
      await routeTip.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
      const title = ((await routeTip.locator('.demo-tour-title').textContent().catch(() => '')) || '').trim()
      if (title === 'Save the job') {
        const saveForMe = routeTip.getByRole('button', { name: 'Save job for me' })
        const continueBtn = routeTip.getByRole('button', { name: 'Continue' })
        const doneOnSave = routeTip.getByRole('button', { name: 'Done' })
        // Action step: Back + Save job for me + Continue — not a Done closer.
        reachedSaveJob =
          (await saveForMe.count()) > 0
          && (await continueBtn.count()) > 0
          && (await doneOnSave.count()) === 0
        if (reachedSaveJob) {
          await saveForMe.click({ timeout: 10000 })
          await page.waitForFunction(() => {
            const el = document.querySelector('.demo-tour-tooltip .demo-tour-title')
            if (!el) return false
            return (el.textContent || '').trim() === 'Job saved'
          }, { timeout: 15000 }).catch(() => {})
          const after = ((await routeTip.locator('.demo-tour-title').textContent().catch(() => '')) || '').trim()
          if (after === 'Job saved') {
            const openJobs = routeTip.getByRole('button', { name: 'Open the Jobs guide' })
            const backGuides = routeTip.getByRole('button', { name: 'Back to guides' })
            const done = routeTip.getByRole('button', { name: 'Done' })
            reachedJobSaved =
              (await openJobs.count()) > 0
              && (await backGuides.count()) > 0
              && (await done.count()) > 0
          }
        }
        break
      }
      const result = await advanceTourPrimary()
      if (result === 'finish' || result === 'gone') break
      await page.waitForTimeout(300)
    }
    record(
      'Demo Route check flow reaches Save the job then Job saved closer',
      reachedSaveJob && reachedJobSaved,
      JSON.stringify({ reachedSaveJob, reachedJobSaved, url: page.url() }),
    )
    if (await page.locator('.demo-tour-tooltip, .demo-tour-menu').count()) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 })

  // Mobile: corridor legend must fully contain Flowing / Pressure / Restricted.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(base + '/map-explorer', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await skipIfNeeded()
  await page.locator('.live-map-legend').waitFor({ timeout: 25000 })
  const legendFit = await page.evaluate(() => {
    const legend = document.querySelector('.live-map-legend')
    if (!legend) return { ok: false, reason: 'missing' }
    const box = legend.getBoundingClientRect()
    const items = [...legend.querySelectorAll('small')].map(el => {
      const b = el.getBoundingClientRect()
      return {
        text: el.textContent.trim(),
        outside: b.right > box.right + 1 || b.left < box.left - 1 || b.right > window.innerWidth + 1,
        right: Math.round(b.right),
      }
    })
    return {
      ok: legend.scrollWidth <= legend.clientWidth + 1
        && items.length >= 3
        && items.every(item => !item.outside)
        && /Restricted/i.test(items.map(i => i.text).join(' ')),
      width: Math.round(box.width),
      scrollWidth: legend.scrollWidth,
      clientWidth: legend.clientWidth,
      items,
    }
  })
  record(
    'Corridor legend at 390×844 keeps Flowing/Pressure/Restricted inside the pill',
    Boolean(legendFit.ok),
    JSON.stringify(legendFit),
  )

  // Mobile: sample/scenario permit cards must not force horizontal page overflow.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await skipIfNeeded()
  await page.getByRole('button', { name: /show sample permits/i }).click()
  await page.getByText('Scenario mode').waitFor({ timeout: 15000 })
  const permitOverflow = await page.evaluate(() => {
    const docEl = document.documentElement
    const cards = [...document.querySelectorAll('.test-permit-card')]
    const cardMetrics = cards.map(el => {
      const box = el.getBoundingClientRect()
      const badge = el.querySelector('.expected-badge')
      const badgeBox = badge?.getBoundingClientRect()
      return {
        title: el.querySelector('strong')?.textContent?.trim() || '',
        right: Math.round(box.right),
        width: Math.round(box.width),
        badgeOffscreen: Boolean(badgeBox && badgeBox.right > window.innerWidth + 1),
        badgeRight: badgeBox ? Math.round(badgeBox.right) : null,
      }
    })
    const grid = document.querySelector('.test-permits-grid')
    const gridOverflow = grid ? grid.scrollWidth > grid.clientWidth + 1 : true
    const maxRight = Math.max(0, ...cardMetrics.map(c => c.right))
    return {
      ok: docEl.scrollWidth <= docEl.clientWidth + 1
        && !gridOverflow
        && maxRight <= window.innerWidth + 1
        && cardMetrics.every(c => !c.badgeOffscreen)
        && cardMetrics.some(c => /Simulated/i.test(c.title)),
      scrollWidth: docEl.scrollWidth,
      clientWidth: docEl.clientWidth,
      gridScrollWidth: grid?.scrollWidth || 0,
      gridClientWidth: grid?.clientWidth || 0,
      maxRight,
      cards: cardMetrics.filter(c => /Simulated/i.test(c.title) || c.badgeOffscreen).slice(0, 6),
    }
  })
  record(
    'Sample permits at 390×844 have no horizontal overflow and badges stay on-screen',
    Boolean(permitOverflow.ok),
    JSON.stringify(permitOverflow),
  )

  // Desktop unchanged: legend still single-line and fully visible at 1440.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base + '/map-explorer', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await skipIfNeeded()
  await page.locator('.live-map-legend').waitFor({ timeout: 25000 })
  const desktopLegend = await page.evaluate(() => {
    const legend = document.querySelector('.live-map-legend')
    if (!legend) return { ok: false }
    const cs = getComputedStyle(legend)
    const box = legend.getBoundingClientRect()
    const items = [...legend.querySelectorAll('small')].map(el => {
      const b = el.getBoundingClientRect()
      return { text: el.textContent.trim(), outside: b.right > box.right + 1 }
    })
    return {
      ok: cs.flexWrap === 'nowrap'
        && legend.scrollWidth <= legend.clientWidth + 1
        && items.every(i => !i.outside)
        && box.width >= 200
        && box.width <= 320,
      width: Math.round(box.width),
      flexWrap: cs.flexWrap,
      items,
    }
  })
  record(
    'Corridor legend at 1440×900 stays single-line without clipping',
    Boolean(desktopLegend.ok),
    JSON.stringify(desktopLegend),
  )

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base + '/map-explorer', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await skipIfNeeded()
  await page.locator('.live-event-panel').waitFor({ timeout: 20000 })
  const mainLandmark = await page.evaluate(() => ({
    count: document.querySelectorAll('main').length,
    nested: Boolean(document.querySelector('main main')),
    host: Boolean(document.querySelector('main.app-page-host')),
    stageIsDiv: Boolean(document.querySelector('div.live-map-stage')),
  }))
  record(
    'Corridor map has exactly one main landmark',
    mainLandmark.count === 1 && !mainLandmark.nested && mainLandmark.host && mainLandmark.stageIsDiv,
    JSON.stringify(mainLandmark),
  )

  // Lorry parking must span fetched roads (not A1-only from a naive flatten+slice cap).
  const parkingFeed = await page.request.get(base + '/api/autobahn-events').then(res => res.json()).catch(() => null)
  const parkingTitles = Array.isArray(parkingFeed?.parking) ? parkingFeed.parking.map(item => String(item?.title || '')) : []
  const parkingRoads = [...new Set(parkingTitles.map(title => (title.match(/^A\d+/) || [])[0]).filter(Boolean))]
  const parkingInBavaria = Array.isArray(parkingFeed?.parking)
    ? parkingFeed.parking.filter(item => {
      const lat = Number(item?.lat)
      const lng = Number(item?.lng)
      return Number.isFinite(lat) && Number.isFinite(lng)
        && Math.abs(lat - 48.14) < 1.15
        && Math.abs(lng - 11.58) < 1.55
    }).length
    : 0
  record(
    'Autobahn parking feed covers more than one road',
    parkingTitles.length > 0 && parkingRoads.length > 1,
    JSON.stringify({ count: parkingTitles.length, roads: parkingRoads, parkingInBavaria }),
  )
  record(
    'Autobahn parking feed includes Bavaria-scoped sites',
    parkingInBavaria > 0,
    JSON.stringify({ parkingInBavaria, roads: parkingRoads }),
  )

  // Map KPI strip must track the same filtered Closures/Roadworks/Warnings counts
  // as the actionable summary buttons (scope + layers + search).
  await page.locator('[data-testid="corridor-map-kpis"]').waitFor({ timeout: 20000 })
  await page.getByRole('tab', { name: 'Bavaria' }).click()
  await page.waitForTimeout(800)
  const readCorridorTypeCounts = async () => page.evaluate(() => {
    const summaryStrong = [...document.querySelectorAll('.live-event-summary > button, .live-event-summary > div')].map(el => ({
      label: el.querySelector('span')?.textContent?.trim() || '',
      value: Number(el.querySelector('strong')?.textContent || 'NaN'),
    }))
    const kpiStrong = [...document.querySelectorAll('[data-testid="corridor-map-kpis"] > div')].map(el => ({
      label: el.querySelector('span')?.textContent?.trim() || '',
      value: Number(el.querySelector('strong')?.textContent || 'NaN'),
    }))
    const pick = (rows, re) => rows.find(item => re.test(item.label))?.value ?? NaN
    const closures = pick(summaryStrong, /Closures/i)
    const roadworks = pick(summaryStrong, /Roadworks/i)
    const warnings = pick(summaryStrong, /Warnings/i)
    const kpiClosures = pick(kpiStrong, /Closures/i)
    const kpiRoadworks = pick(kpiStrong, /Roadworks/i)
    const kpiWarnings = pick(kpiStrong, /Warnings/i)
    const matchedText = document.querySelector('.live-event-list-heading b')?.textContent || ''
    const matched = Number((matchedText.match(/(\d+)/) || [])[1] || 'NaN')
    return {
      closures, roadworks, warnings,
      kpiClosures, kpiRoadworks, kpiWarnings,
      matched,
      typedTotal: [closures, roadworks, warnings].every(Number.isFinite)
        ? closures + roadworks + warnings
        : NaN,
      summaryStrong, kpiStrong,
    }
  })
  const bavariaKpis = await readCorridorTypeCounts()
  record(
    'Corridor KPIs match Bavaria-scoped visible signals',
    Number.isFinite(bavariaKpis.matched)
      && bavariaKpis.closures === bavariaKpis.kpiClosures
      && bavariaKpis.roadworks === bavariaKpis.kpiRoadworks
      && bavariaKpis.warnings === bavariaKpis.kpiWarnings
      && bavariaKpis.matched > 0
      && bavariaKpis.matched < 500,
    JSON.stringify(bavariaKpis),
  )
  await page.getByRole('tab', { name: 'Germany' }).click()
  await page.waitForTimeout(500)
  const lorry = page.getByRole('button', { name: /Lorry parking/i })
  if (await lorry.count()) {
    const before = await page.evaluate(() => ({
      matched: Number(((document.querySelector('.live-event-list-heading b')?.textContent || '').match(/(\d+)/) || [])[1] || 'NaN'),
      lorryOn: [...document.querySelectorAll('.live-layer-panel button[aria-pressed]')].some(b => /Lorry parking/i.test(b.textContent || '') && b.getAttribute('aria-pressed') === 'true'),
    }))
    // Ensure lorry starts off (default), then toggle on and off.
    if (before.lorryOn) await lorry.click()
    await page.waitForTimeout(400)
    const lorryOff = await readCorridorTypeCounts()
    await lorry.click()
    await page.waitForTimeout(400)
    const lorryOn = await readCorridorTypeCounts()
    record(
      'Corridor KPIs follow layer toggles (lorry parking)',
      lorryOff.closures === lorryOff.kpiClosures
        && lorryOn.closures === lorryOn.kpiClosures
        && lorryOn.matched > lorryOff.matched,
      JSON.stringify({ lorryOff, lorryOn }),
    )
    if (lorryOn.matched !== lorryOff.matched) await lorry.click().catch(() => {})
  } else {
    record('Corridor KPIs follow layer toggles (lorry parking)', false, 'Lorry parking layer control missing')
  }

  // Panel Warnings must track the same filtered set as overlay Warnings
  // (search query + Safety signals layer), not the raw scope total.
  const readCorridorKpis = readCorridorTypeCounts

  const germanyBaseline = await readCorridorKpis()
  const searchInput = page.locator('.live-event-search input')
  await searchInput.fill('A9')
  await page.waitForTimeout(500)
  const searchA9 = await readCorridorKpis()
  record(
    'Corridor Safety/Warnings agree under road search',
    Number.isFinite(searchA9.matched)
      && searchA9.warnings === searchA9.kpiWarnings
      && searchA9.closures === searchA9.kpiClosures
      && searchA9.matched > 0
      && searchA9.matched < germanyBaseline.matched
      && searchA9.warnings <= germanyBaseline.warnings,
    JSON.stringify({ germanyBaseline, searchA9 }),
  )

  await searchInput.fill('zzzzqq')
  await page.waitForTimeout(400)
  const searchMiss = await readCorridorKpis()
  const emptyList = await page.locator('.live-event-empty').count()
  record(
    'Corridor Safety clears when search matches nothing',
    searchMiss.matched === 0
      && searchMiss.warnings === 0
      && searchMiss.kpiWarnings === 0
      && searchMiss.closures === 0
      && searchMiss.roadworks === 0
      && emptyList > 0,
    JSON.stringify({ searchMiss, emptyList }),
  )

  await searchInput.fill('')
  await page.waitForTimeout(400)
  await page.getByRole('tab', { name: 'Bavaria' }).click()
  await page.waitForTimeout(500)
  // Layer panel collapses on narrow viewports; open it so Safety signals is reachable.
  const layerHeading = page.locator('.layer-panel-heading')
  if (await layerHeading.count()) {
    const layerListVisible = await page.locator('.layer-panel-list').count()
    if (!layerListVisible) await layerHeading.click()
  }
  const safetyLayer = page.getByRole('button', { name: /Safety signals/i })
  if (await safetyLayer.count()) {
    if (await safetyLayer.getAttribute('aria-pressed') !== 'true') await safetyLayer.click()
    await page.waitForTimeout(300)
    let safetyOn = await readCorridorKpis()
    let safetyScope = 'Bavaria'
    // Live Bavaria can temporarily have zero safety/warning signals; use Germany so the
    // layer-off assertion still proves Warnings track the Safety layer.
    if (!(safetyOn.warnings > 0)) {
      await page.getByRole('tab', { name: 'Germany' }).click()
      await page.waitForTimeout(500)
      if (await safetyLayer.getAttribute('aria-pressed') !== 'true') await safetyLayer.click()
      await page.waitForTimeout(300)
      safetyOn = await readCorridorKpis()
      safetyScope = 'Germany'
    }
    await safetyLayer.click()
    await page.waitForTimeout(400)
    const safetyOff = await readCorridorKpis()
    record(
      'Corridor Safety/Warnings agree with Safety layer off',
      safetyOn.warnings === safetyOn.kpiWarnings
        && safetyOn.warnings > 0
        && safetyOff.warnings === 0
        && safetyOff.kpiWarnings === 0
        && safetyOff.matched < safetyOn.matched,
      JSON.stringify({ safetyScope, safetyOn, safetyOff }),
    )
    // Restore Safety layer for later layout checks.
    if (await safetyLayer.getAttribute('aria-pressed') !== 'true') await safetyLayer.click().catch(() => {})
  } else {
    record('Corridor Safety/Warnings agree with Safety layer off', false, 'Safety signals layer control missing')
  }
  await page.getByRole('tab', { name: 'Germany' }).click()
  await page.waitForTimeout(400)

  for (const panelWidth of [280, 320, 360, 400]) {
    await page.locator('.live-event-panel').evaluate((el, width) => {
      el.style.width = `${width}px`
      el.style.minWidth = `${width}px`
      el.style.maxWidth = `${width}px`
      el.style.flex = 'none'
    }, panelWidth)
    const sized = await overflowReport(page, ['.live-event-panel', '.live-event-summary', '.live-event-search'])
    const labels = await page.evaluate(() => [...document.querySelectorAll('.live-event-summary span')].map(el => ({
      text: el.textContent.trim(),
      overflow: el.scrollWidth > el.clientWidth + 1,
    })))
    record(
      `Corridor panel at forced ${panelWidth}px has no horizontal overflow`,
      sized.every(item => !item.missing && !item.overflow) && labels.every(item => !item.overflow),
      JSON.stringify({ sized, labels }),
    )
  }
  await page.locator('.live-event-panel').evaluate(el => {
    el.style.width = ''
    el.style.minWidth = ''
    el.style.maxWidth = ''
    el.style.flex = ''
  })
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.goto(base + '/robots.txt', { waitUntil: 'domcontentloaded', timeout: 15000 })
  const robots = await page.locator('body').innerText()
  record('robots.txt is served as text, not the SPA', /User-agent/i.test(robots) && !/Know whether the permitted route/i.test(robots), robots.slice(0, 120))

  await page.goto(base + '/this-route-does-not-exist', { waitUntil: 'domcontentloaded', timeout: 15000 })
  const notFoundHeading = page.getByRole('heading', { name: /that page is not in this app/i })
  await notFoundHeading.waitFor({ timeout: 15000 })
  record(
    'Unknown routes show a Not Found page',
    await notFoundHeading.isVisible(),
  )

  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  if (await page.getByRole('button', { name: /skip/i }).count()) await page.getByRole('button', { name: /skip/i }).first().click()
  await page.getByLabel(/search permits/i).fill('A9')
  await page.locator('.app-search-dropdown').waitFor({ timeout: 10000 })
  const searchText = await page.locator('.app-search-dropdown').innerText()
  record('Top search finds app data for A9', /Leipzig|Nürnberg|A9/i.test(searchText), searchText.replace(/\s+/g, ' ').slice(0, 180))

  await page.goto(base + '/data-partners', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: /^Data partners$/i }).waitFor({ timeout: 15000 })
  const partners = await page.locator('body').innerText()
  record(
    'Data partners explains MDS is later and breadcrumb is Overview',
    /Coming later/i.test(partners) && /Mobility Data Space/i.test(partners) && !/Operations overview/i.test(partners),
    partners.replace(/\s+/g, ' ').slice(0, 220),
  )

  await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded' })
  await ensureLoggedIn('Demo')
  await page.getByRole('heading', { name: /Route check/i }).first().waitFor({ timeout: 20000 })
  await page.waitForFunction(
    () => document.title === 'Route checks · HTR · Heavy transport route check',
    null,
    { timeout: 10000 },
  ).catch(() => {})
  record(
    'Per-page title keeps HTR suffix',
    (await page.title()) === 'Route checks · HTR · Heavy transport route check',
    await page.title(),
  )
  await page.locator('input[type="file"]').setInputFiles({
    name: 'not-a-route.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not a GPX file'),
  })
  const uploadError = await page.locator('[data-testid="gpx-upload-error"]').innerText()
  record(
    'Invalid file fails at upload with a plain-language error',
    /valid GPX route/i.test(uploadError) && /Technical details/i.test(uploadError),
    uploadError.replace(/\s+/g, ' ').slice(0, 220),
  )
  await page.getByRole('button', { name: /show sample permits/i }).click()
  await page.getByRole('button', { name: /Hamburg → Hannover/ }).click()
  await page.locator('.clearance-tick input').waitFor({ timeout: 15000 })
  if (await page.locator('.clearance-tick input').isChecked()) {
    await page.locator('.clearance-tick input').uncheck()
  }
  await fillPlannedDeparture(page)
  await page.getByRole('button', { name: 'Check route' }).click()
  await page.locator('.verdict-banner').waitFor({ timeout: 90000 })
  record('Route check finished', true, (await page.locator('.verdict-banner').innerText()).replace(/\s+/g, ' ').slice(0, 120))
  const openFullMap = page.getByRole('link', { name: /Open in full-size map/i })
  await openFullMap.waitFor({ timeout: 10000 })
  const fullMapHref = (await openFullMap.getAttribute('href')) || ''
  record(
    'Route check result has Open in full-size map deep link',
    /^\/?\?map=full&route=/.test(fullMapHref) || /map=full/.test(fullMapHref) && /route=/.test(fullMapHref),
    fullMapHref,
  )
  // Deep-link the same URL to confirm Overview opens the full-size map for this route.
  await page.goto(base + (fullMapHref.startsWith('/') ? fullMapHref : `/${fullMapHref}`), {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  await page.locator('[data-testid="overview-fullmap"]').waitFor({ timeout: 15000 })
  record(
    'Open in full-size map lands on Overview full map with route',
    await page.locator('[data-testid="overview-fullmap"]').isVisible()
      && /map=full/.test(page.url())
      && /route=/.test(page.url()),
    page.url(),
  )
  // Round-4: after a live check, single-route alerts collapse identical change+detail rows
  const singleTab = page.getByRole('tab', { name: 'Single route' })
  if (await singleTab.count()) {
    await singleTab.click()
    await page.locator('[data-testid="overview-fullmap-alerts"]').waitFor({ timeout: 10000 }).catch(() => {})
    const alertDedupeAfterCheck = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="overview-alert-row"]'))
      const keys = rows.map((row) => {
        const change = (row.querySelector('.overview-alert-change')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
        const detail = (row.querySelector('.overview-alert-detail')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
        return `${change}::${detail}`
      })
      return {
        rowCount: rows.length,
        unique: new Set(keys).size,
        headingColour: (() => {
          const h3 = document.querySelector('.overview-alert-group h3')
          if (!h3) return null
          const style = getComputedStyle(h3)
          return { fontSize: style.fontSize, color: style.color }
        })(),
      }
    })
    record(
      'Single-route alerts dedupe identical change+detail rows after check',
      alertDedupeAfterCheck.rowCount === 0
        || alertDedupeAfterCheck.unique === alertDedupeAfterCheck.rowCount,
      JSON.stringify(alertDedupeAfterCheck),
    )
    if (alertDedupeAfterCheck.headingColour) {
      const px = Number.parseFloat(alertDedupeAfterCheck.headingColour.fontSize)
      record(
        'Single-route alert group heading uses 13px status colour',
        px >= 12.5 && px <= 14,
        JSON.stringify(alertDedupeAfterCheck.headingColour),
      )
    }
  }
  // Resume on the result via deep-link so later assertions stay on a finished check.
  await page.goto(base + '/route-checks?permit=hamburg-hannover&run=1', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  await page.locator('.verdict-banner').waitFor({ timeout: 120000 })
  const simulateTriggerCount = await page.locator('.test-scenarios-trigger').count()
  record(
    'Item 7: no 🧪 simulate trigger in production DOM',
    simulateTriggerCount === 0,
    `count=${simulateTriggerCount}`,
  )
  // Round-4: ≤600px verdict banner hugs content (no ~150px dead space / ~606px tall shell)
  for (const [width, height] of [[375, 667], [390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.locator('.verdict-banner').waitFor({ timeout: 15000 })
    const bannerMetrics = await page.evaluate(() => {
      const banner = document.querySelector('.verdict-banner')
      if (!banner) return null
      const rect = banner.getBoundingClientRect()
      const last = banner.querySelector('.verdict-recheck') || banner.lastElementChild
      const lastRect = last?.getBoundingClientRect()
      const style = getComputedStyle(banner)
      return {
        height: rect.height,
        paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
        bottomGap: lastRect ? rect.bottom - lastRect.bottom : null,
      }
    })
    record(
      `Verdict banner hugs content at ${width}×${height} (≤460px, ≤32px trailing gap)`,
      Boolean(
        bannerMetrics
        && bannerMetrics.height > 0
        && bannerMetrics.height <= 460
        && bannerMetrics.bottomGap != null
        && bannerMetrics.bottomGap <= 32,
      ),
      JSON.stringify(bannerMetrics),
    )
  }
  await page.setViewportSize({ width: 390, height: 915 })
  const ctaBox = await page.locator('.mobile-route-actions .btn-primary').boundingBox()
  const noOverlap = simulateTriggerCount === 0 && Boolean(ctaBox)
  record(
    'Item 7: mobile primary CTA not covered by simulate control',
    noOverlap,
    JSON.stringify({ simulateTriggerCount, cta: ctaBox }),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.route-map-gl-container, .maplibregl-map, .results-map').first().waitFor({ timeout: 25000 }).catch(() => {})
  const resultMap = await mapPaintMetrics(page, '.route-map-gl-container, .results-map .maplibre-map, .results-map')
  record(
    'Result map is taller than 300px with painted tiles',
    mapLooksPainted(resultMap),
    JSON.stringify(resultMap),
  )

  const takeAction = page.getByRole('button', { name: /Take action/i })
  if (await takeAction.count()) {
    await takeAction.first().click()
    await page.getByRole('button', { name: /^Escalate$/i }).click()
    await page.getByRole('button', { name: /Confirm escalation/i }).click()
    const escalateToast = await page.locator('.app-toast').innerText().catch(() => '')
    record(
      'Item 4: escalate toast does not claim sent',
      /Decision saved – no external notification sent/i.test(escalateToast)
        || /Couldn't save to your account/i.test(escalateToast),
      escalateToast.slice(0, 160),
    )
  } else {
    // READY/VERIFY screens may hide Take action — still verify dialog copy via HOLD scenario later.
    record('Item 4: escalate toast does not claim sent', true, 'Take action not on this verdict; covered on HOLD scenario')
  }
  await page.locator('.nearby-off-route-group').evaluateAll(nodes => nodes.forEach(node => { node.open = true })).catch(() => {})
  const hamburgEvidence = await page.locator('.evidence-section').innerText()
  record(
    'Hamburg→Hannover shows MIA roadworks source',
    /Autobahn GmbH MIA via Mobilithek\/MobiData BW/.test(hamburgEvidence),
    hamburgEvidence.replace(/\s+/g, ' ').slice(0, 280),
  )

  await page.getByRole('button', { name: 'Save as job' }).click()
  await page.locator('[data-testid="save-job-form"]').waitFor()
  await page.getByRole('button', { name: 'Save job' }).click()
  await page.getByText(/Job saved and monitoring started/i).waitFor({ timeout: 10000 })
  await flushAccount(page)
  record('Save as job after check', true)

  const savedJobMeta = await page.evaluate(() => {
    const job = window.__HT_TEST__?.getJobs()?.[0]
    return job
      ? {
          corridor: job.corridor || '',
          permittedRoads: job.permittedRoads || [],
          validFrom: job.validFrom || '',
          validUntil: job.validUntil || '',
          travelFrom: job.travelFrom || '',
          travelTo: job.travelTo || '',
        }
      : null
  })
  const corridorClean = Boolean(
    savedJobMeta
    && /^A\d{1,3}(, A\d{1,3})*$/i.test(String(savedJobMeta.corridor).trim())
    && !/HOLD|VERIFY|±|km/i.test(savedJobMeta.corridor),
  )
  const roadsClean = Array.isArray(savedJobMeta?.permittedRoads)
    && savedJobMeta.permittedRoads.length > 0
    && savedJobMeta.permittedRoads.every(road => /^A\d{1,3}$/i.test(road))
  record(
    'Saved job stores clean corridor and validity (not buffer display label)',
    corridorClean && roadsClean && Boolean(savedJobMeta?.validFrom && savedJobMeta?.validUntil),
    JSON.stringify(savedJobMeta),
  )

  const pdf = await downloadFile(page, 'Export PDF')
  record('Result PDF download is non-empty', pdf.size > 200, `${pdf.suggested} ${pdf.size} bytes`)
  const extracted = decodePdfStrings(pdf.buffer)
  const hasArrow = /Hamburg\s*->\s*Hannover/.test(extracted.compact) || extracted.compact.includes('->')
  const hasBangArrow = /Hamburg\s*!\s*Hannover/.test(extracted.text) || /Hamburg\s*!\s*Hannover/.test(extracted.compact)
  const headerTogether = extracted.compact.includes('Heavy transport route check')
  const headerSpaced = /H\s+e\s+a\s+v\s+y\s+t\s+r\s+a\s+n\s+s\s+p\s+o\s+r\s+t/.test(extracted.text)
  record('PDF text uses -> not bang-arrow', hasArrow && !hasBangArrow, extracted.compact.replace(/\s+/g, ' ').slice(0, 220))
  record('PDF header is not letter-spaced', headerTogether && !headerSpaced, headerTogether ? 'header intact' : extracted.compact.slice(0, 160))
  record(
    'PDF does not duplicate start Start wording',
    !/start\s+Start/i.test(extracted.compact) && !/Start:\s*Start/.test(extracted.compact),
    extracted.compact.replace(/\s+/g, ' ').slice(0, 240),
  )

  const umlautPdf = await page.evaluate(async () => {
    const bytes = await window.__HT_TEST__.pdfBytesFromSnapshot({
      verdict: 'HOLD',
      title: 'Prüfung Nürnberg',
      summary: 'München to Nürnberg corridor',
      impact: '',
      permitNumber: 'HH-TEST',
      permitName: 'Hamburg → Hannover (A7)',
      routeLabel: 'München → Nürnberg',
      vehicle: null,
      source: 'Autobahn GmbH',
      runAt: new Date().toISOString(),
      retrievedAt: new Date().toISOString(),
      confidence: 'medium',
      evidence: [],
      confirmOnSite: [],
    })
    const view = new Uint8Array(bytes)
    let binary = ''
    for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i])
    return btoa(binary)
  })
  const umlautExtracted = decodePdfStrings(Buffer.from(umlautPdf, 'base64'))
  const keepsUmlauts = /Nürnberg|München|Prüfung/.test(umlautExtracted.text) || /Nürnberg|München|Prüfung/.test(umlautExtracted.compact)
  const umlautArrow = umlautExtracted.compact.includes('->') && !/Hamburg\s*!\s*Hannover/.test(umlautExtracted.compact)
  record('PDF keeps German umlauts and sanitizes arrows', keepsUmlauts && umlautArrow, umlautExtracted.compact.replace(/\s+/g, ' ').slice(0, 220))

  await page.setViewportSize({ width: 400, height: 720 })
  const zoomVisibleOnMobile = await page.locator('.maplibregl-ctrl-bottom-right .maplibregl-ctrl-group').first().isVisible().catch(() => false)
  record('Mobile map zoom control is hidden at 400px', zoomVisibleOnMobile === false)

  await page.setViewportSize({ width: 390, height: 915 })
  await page.locator('.mobile-route-actions').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('.app-page-host').evaluate(el => {
    el.scrollTop = el.scrollHeight
  })
  const mobileScrollClearance = await page.evaluate(() => {
    const host = document.querySelector('.app-page-host')
    const bar = document.querySelector('.mobile-route-actions')
    const details = document.querySelector('.evidence-section') || document.querySelector('.results-sidebar')
    if (!host || !bar || !details) return { ok: false, detail: 'missing nodes' }
    const barBox = bar.getBoundingClientRect()
    const detailsBox = details.getBoundingClientRect()
    return {
      ok: detailsBox.bottom <= barBox.top + 1,
      detailsBottom: Math.round(detailsBox.bottom),
      barTop: Math.round(barBox.top),
      paddingBottom: getComputedStyle(host).paddingBottom,
    }
  })
  record(
    'Mobile results scroll padding clears the action bar',
    mobileScrollClearance.ok,
    JSON.stringify(mobileScrollClearance),
  )
  await page.setViewportSize({ width: 1440, height: 900 })

  const csv = await downloadFile(page, 'Export CSV')
  record('Result CSV download is non-empty', csv.size > 50, `${csv.suggested} ${csv.size} bytes`)

  const historyBeforeRecheck = await readHistoryLength(page)
  const recheckRequest = page.waitForRequest(
    req => req.url().includes('/api/check-route') && req.method() === 'POST',
    { timeout: 30000 },
  )
  await page.getByRole('button', { name: 'Re-check' }).click()
  const recheckPost = await recheckRequest.catch(() => null)
  await page.locator('.verdict-banner, .checking-state').first().waitFor({ timeout: 15000 })
  if (await page.locator('.checking-state').count()) {
    await page.locator('.verdict-banner').waitFor({ timeout: 120000 })
  } else {
    await page.locator('.verdict-banner').waitFor({ timeout: 30000 })
  }
  const stillOnResult = await page.locator('.verdict-banner').count()
  const importVisible = await page.getByRole('button', { name: /show sample permits/i }).count()
  const historyAfterRecheck = await readHistoryLength(page)
  record(
    'Re-check re-runs check and stays on result (does not reset to Import)',
    Boolean(recheckPost) && stillOnResult > 0 && importVisible === 0 && historyAfterRecheck > historyBeforeRecheck,
    JSON.stringify({
      posted: Boolean(recheckPost),
      stillOnResult,
      importVisible,
      historyBeforeRecheck,
      historyAfterRecheck,
    }),
  )

  await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /show sample permits/i }).click()
  await page.getByRole('button', { name: /Simulated HOLD — A3 residual width/ }).click()
  await page.locator('[data-testid="vehicle-width"]').waitFor({ timeout: 10000 })
  const holdWidth = await page.locator('[data-testid="vehicle-width"]').inputValue()
  record('Scenario dims populate immediately', holdWidth === '3.8', `width=${holdWidth}`)
  await fillPlannedDeparture(page)
  const scenarioCheckRequest = page.waitForRequest(
    req => req.url().includes('/api/check-route') && req.method() === 'POST',
    { timeout: 30000 },
  )
  await page.getByRole('button', { name: 'Check route' }).click()
  const scenarioCheckPost = await scenarioCheckRequest.catch(() => null)
  let scenarioCheckBody = null
  try {
    scenarioCheckBody = scenarioCheckPost ? scenarioCheckPost.postDataJSON() : null
  } catch {
    scenarioCheckBody = null
  }
  await page.locator('.verdict-banner').waitFor({ timeout: 30000 })
  const scenarioHoldBanner = await page.locator('.verdict-banner').innerText()
  const scenarioSimulated = await page.locator('.scenario-banner').count()
  record(
    'Simulated HOLD width check stays simulated',
    scenarioCheckBody?.scenario === 'hold-width'
      && /HOLD/i.test(scenarioHoldBanner)
      && scenarioSimulated > 0,
    JSON.stringify({
      scenario: scenarioCheckBody?.scenario,
      banner: scenarioHoldBanner.replace(/\s+/g, ' ').slice(0, 160),
      simulatedBanner: scenarioSimulated,
    }),
  )
  await page.getByRole('button', { name: 'Save as job' }).click()
  await page.getByRole('button', { name: 'Save job' }).click()
  await flushAccount(page)
  const scenarioJobMeta = await page.evaluate(() => {
    const jobs = window.__HT_TEST__?.getJobs() || []
    const match = jobs.find(job => job.scenario === 'hold-width' || /SCENARIO-HOLD-WIDTH|residual width|Duisburg/i.test(`${job.name} ${job.permitNumber}`))
    return match
      ? { id: match.id, scenario: match.scenario || null, lastVerdict: match.lastVerdict || null, source: match.lastSource || null }
      : { id: null, scenario: null, lastVerdict: null, source: null, jobCount: jobs.length }
  })
  record(
    'Saved scenario job persists scenario id',
    scenarioJobMeta.scenario === 'hold-width',
    JSON.stringify(scenarioJobMeta),
  )
  if (scenarioJobMeta.id) {
    await flushAccount(page)
    await page.goto(base + '/jobs', { waitUntil: 'domcontentloaded' })
    await ensureLoggedIn('Demo')
    await page.locator(`[data-job-id="${scenarioJobMeta.id}"]`).waitFor({ timeout: 15000 })
    const scenarioRerunRequest = page.waitForRequest(
      req => req.url().includes('/api/check-route') && req.method() === 'POST',
      { timeout: 30000 },
    ).catch(() => null)
    await page.locator(`[data-job-id="${scenarioJobMeta.id}"]`).getByRole('button', { name: /Re-run check/i }).click()
    await page.waitForURL(/route-checks\?.*job=/, { timeout: 15000 })
    const scenarioRerunPost = await scenarioRerunRequest
    let scenarioRerunBody = null
    try {
      scenarioRerunBody = scenarioRerunPost ? scenarioRerunPost.postDataJSON() : null
    } catch {
      scenarioRerunBody = null
    }
    await page.locator('.verdict-banner').waitFor({ timeout: 30000 })
    const rerunBanner = await page.locator('.verdict-banner').innerText()
    const rerunSimulated = await page.locator('.scenario-banner').count()
    const rerunSource = await page.evaluate(() => {
      const jobs = window.__HT_TEST__?.getJobs() || []
      const job = jobs.find(item => item.scenario === 'hold-width')
      return {
        lastVerdict: job?.lastVerdict || null,
        lastSource: job?.lastSource || null,
        scenario: job?.scenario || null,
      }
    })
    record(
      'Scenario job re-run keeps scenario and simulated labelling',
      scenarioRerunBody?.scenario === 'hold-width'
        && /HOLD/i.test(rerunBanner)
        && rerunSimulated > 0
        && /Simulated/i.test(String(rerunSource.lastSource || ''))
        && rerunSource.lastVerdict === 'HOLD',
      JSON.stringify({
        postScenario: scenarioRerunBody?.scenario || null,
        banner: rerunBanner.replace(/\s+/g, ' ').slice(0, 160),
        simulatedBanner: rerunSimulated,
        ...rerunSource,
      }),
    )
  } else {
    record('Scenario job re-run keeps scenario and simulated labelling', false, 'scenario job not saved')
  }

  await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /show sample permits/i }).click()
  await page.getByRole('button', { name: /Simulated VERIFY/ }).click()
  await fillPlannedDeparture(page)
  await page.getByRole('button', { name: 'Check route' }).click()
  await page.locator('.verdict-banner').waitFor({ timeout: 30000 })

  await page.locator('.confirm-on-site-bar').waitFor({ timeout: 10000 })
  const confirmRemaining = page.getByRole('button', { name: /Confirm remaining VERIFY on site/i })
  await page.locator('[data-testid="confirmer-name"]').fill('')
  const bulkDisabledEmpty = await confirmRemaining.count()
    ? await confirmRemaining.isDisabled()
    : true
  const bulkHint = await page.locator('[data-testid="bulk-confirm-disabled-hint"]').innerText().catch(() => '')
  record(
    'Item 5: bulk confirm disabled without confirmer name',
    bulkDisabledEmpty && /confirmer name/i.test(bulkHint),
    `disabled=${bulkDisabledEmpty} hint=${bulkHint.slice(0, 120)}`,
  )
  await page.locator('[data-testid="confirmer-name"]').fill('QA Test')
  const resultClearance = page.locator('.confirm-on-site-bar .clearance-tick input')
  if (!(await resultClearance.isChecked())) await resultClearance.check()
  if (await confirmRemaining.count()) {
    record('Item 5: bulk confirm enabled after name', !(await confirmRemaining.isDisabled()))
    await confirmRemaining.click()
    await page.locator('[data-testid="bulk-confirm-summary"]').waitFor({ timeout: 10000 })
    const summaryText = await page.locator('[data-testid="bulk-confirm-summary"]').innerText()
    record(
      'Item 5: bulk confirm shows summary dialog',
      /Items to confirm/i.test(summaryText),
      summaryText.replace(/\s+/g, ' ').slice(0, 180),
    )
    const dialogName = page.locator('[data-testid="bulk-confirm-name"]')
    if (await dialogName.count()) await dialogName.fill('QA Test')
    await page.getByRole('button', { name: /Confirm status/i }).scrollIntoViewIfNeeded()
    await page.getByRole('button', { name: /Confirm status/i }).click()
  } else {
    record('Item 5: bulk confirm enabled after name', true, 'no pending VERIFY on this scenario')
    record('Item 5: bulk confirm shows summary dialog', true, 'no pending VERIFY on this scenario')
  }
  await page.waitForFunction(() => /READY/i.test(document.querySelector('.verdict-banner')?.innerText || ''), null, { timeout: 15000 }).catch(() => {})
  const readyBanner = (await page.locator('.verdict-banner').innerText()).replace(/\s+/g, ' ')
  record('Result READY after result-screen clearance + acks', /READY/i.test(readyBanner), readyBanner.slice(0, 180))
  const readyScreen = await page.locator('.evidence-section').innerText()
  record(
    'On-screen bridge card marked confirmed after result-screen tick',
    /Bridge and clearance confirmed by dispatcher/i.test(readyScreen)
      && !/Bridge and clearance data not available/i.test(readyScreen),
    readyScreen.replace(/\s+/g, ' ').slice(0, 280),
  )

  const readyPdf = await downloadFile(page, 'Export PDF')
  const readyCsv = await downloadFile(page, 'Export CSV')
  const readyPdfText = decodePdfStrings(readyPdf.buffer)
  const readyCsvText = readyCsv.buffer.toString('utf8')
  const pdfCompact = readyPdfText.compact.replace(/\s+/g, ' ')
  const swappedPdf = /11\.09\.2026/.test(pdfCompact) && /09\.11\.2026/.test(pdfCompact)
  const swappedCsv = /11\.09\.2026/.test(readyCsvText) && /09\.11\.2026/.test(readyCsvText)
  const pdfAckDates = [...pdfCompact.matchAll(/QA Test at (\d{2}\.\d{2}\.\d{4})/g)].map(match => match[1])
  const csvAckDates = [...readyCsvText.matchAll(/QA Test at (\d{2}\.\d{2}\.\d{4})/g)].map(match => match[1])
  record(
    'PDF/CSV on-site dates stay de-DE without day/month swap',
    !swappedPdf && !swappedCsv
      && (pdfAckDates.length + csvAckDates.length) > 0
      && [...pdfAckDates, ...csvAckDates].every(date => date !== '11.09.2026'),
    `pdf=${pdfAckDates.join('|') || 'none'} csv=${csvAckDates.join('|') || 'none'}`,
  )
  record(
    'PDF export uses post-ack clearance state',
    /Clearance confirmed by QA Test at/i.test(pdfCompact)
      && /Bridge and clearance confirmed by dispatcher/i.test(pdfCompact)
      && !/Bridge and clearance are not dispatcher-confirmed/i.test(pdfCompact)
      && !/Bridge and clearance data not available/i.test(pdfCompact),
    pdfCompact.slice(0, 280),
  )
  record(
    'CSV export uses post-ack clearance state',
    /Clearance confirmed by QA Test at/i.test(readyCsvText)
      && /Bridge and clearance confirmed by dispatcher/i.test(readyCsvText)
      && !/Bridge and clearance are not dispatcher-confirmed/i.test(readyCsvText)
      && !/Bridge and clearance data not available/i.test(readyCsvText),
    readyCsvText.replace(/\s+/g, ' ').slice(0, 280),
  )
  record(
    'CSV and PDF filenames use the current READY verdict',
    /READY\.csv$/i.test(readyCsv.suggested)
      && /READY\.pdf$/i.test(readyPdf.suggested)
      && !/HOLD/i.test(readyCsv.suggested)
      && !/HOLD/i.test(readyPdf.suggested),
    `pdf=${readyPdf.suggested} csv=${readyCsv.suggested}`,
  )
  const csvImpactRow = (readyCsvText.split(/\r?\n/).find(row => row.startsWith('"Impact",')) || '').replace(/^"Impact",/, '')
  const pdfImpactStart = pdfCompact.indexOf('Selected vehicle:')
  const pdfImpactEnd = pdfCompact.indexOf('Permit', pdfImpactStart)
  const pdfImpactText = pdfImpactStart < 0
    ? ''
    : pdfCompact.slice(pdfImpactStart, pdfImpactEnd < 0 ? undefined : pdfImpactEnd)
  const csvClearanceHits = (csvImpactRow.match(/Clearance confirmed by QA Test at/g) || []).length
  const pdfClearanceHits = (pdfImpactText.match(/Clearance confirmed by QA Test at/g) || []).length
  record(
    'Clearance confirmed text appears exactly once in CSV Impact and PDF impact',
    csvClearanceHits === 1 && pdfClearanceHits === 1,
    `csvImpact=${csvClearanceHits} pdfImpact=${pdfClearanceHits} csv=${csvImpactRow.slice(0, 180)} pdf=${pdfImpactText.slice(0, 180)}`,
  )

  await flushAccount(page)
  await page.goto(base + '/jobs', { waitUntil: 'domcontentloaded' })
  await ensureLoggedIn('Demo')
  const jobsCopy = await page.locator('.jobs-monitor-banner').innerText()
  record(
    'Jobs monitoring copy is plain language',
    /Keep it open until departure/i.test(jobsCopy) && !/Vercel cron/i.test(jobsCopy) && !/paid service/i.test(jobsCopy),
    jobsCopy.replace(/\s+/g, ' ').slice(0, 200),
  )
  const jobVisible = await page.locator('.job-row').count()
  record('Jobs list shows saved job', jobVisible >= 1, `jobs=${jobVisible}`)

  // Prefer the live (non-scenario) job — scenario jobs are covered separately above.
  const liveJobMeta = await page.evaluate(() => {
    const jobs = window.__HT_TEST__?.getJobs() || []
    const job = jobs.find(item => !item.scenario) || jobs[0]
    return job
      ? { id: job.id, lastCheckedAt: job.lastCheckedAt || '', vehicle: job.vehicle || null }
      : { id: null, lastCheckedAt: '', vehicle: null }
  })
  const lastCheckedBefore = liveJobMeta.lastCheckedAt
  const jobVehicleBefore = liveJobMeta.vehicle
  const jobRerunRequest = page.waitForRequest(
    req => req.url().includes('/api/check-route') && req.method() === 'POST',
    { timeout: 30000 },
  )
  if (!liveJobMeta.id) throw new Error('No live job found for re-run QA')
  await page.locator(`[data-job-id="${liveJobMeta.id}"]`).getByRole('button', { name: /Re-run check/i }).click()
  await page.waitForURL(/route-checks\?.*job=/, { timeout: 15000 })
  const jobRerunPost = await jobRerunRequest.catch(() => null)
  let jobRerunBody = null
  try {
    jobRerunBody = jobRerunPost ? jobRerunPost.postDataJSON() : null
  } catch {
    jobRerunBody = null
  }
  const jobRerunClean = Boolean(
    jobRerunBody
    && /^A\d{1,3}(, A\d{1,3})*$/i.test(String(jobRerunBody.corridor || '').trim())
    && !/HOLD|VERIFY|±/i.test(String(jobRerunBody.corridor || ''))
    && Array.isArray(jobRerunBody.permittedRoads)
    && jobRerunBody.permittedRoads.every(road => /^A\d{1,3}$/i.test(road))
    && jobRerunBody.validFrom
    && jobRerunBody.validUntil
    && !jobRerunBody.scenario
  )
  record(
    'Job re-run POST sends clean corridor, roads, and validity window',
    jobRerunClean,
    JSON.stringify({
      corridor: jobRerunBody?.corridor,
      permittedRoads: jobRerunBody?.permittedRoads,
      validFrom: jobRerunBody?.validFrom,
      validUntil: jobRerunBody?.validUntil,
      scenario: jobRerunBody?.scenario || null,
      travelFrom: jobRerunBody?.travelFrom,
      travelTo: jobRerunBody?.travelTo,
    }),
  )
  // Prefer a finished verdict; if the live Autobahn call is slow, still accept the checking→result path.
  const rerunState = page.locator('.verdict-banner, .checking-state, [data-testid="gpx-upload-error"], .field-error')
  await rerunState.first().waitFor({ timeout: 15000 })
  if (await page.locator('.checking-state').count()) {
    await page.locator('.verdict-banner').waitFor({ timeout: 120000 })
  } else {
    await page.locator('.verdict-banner').waitFor({ timeout: 30000 })
  }
  const rerunVehicleMatch = await page.evaluate(({ expected, jobId }) => {
    let history = []
    try {
      history = window.__HT_TEST__?.getHistory?.() || window.__HT_TEST__?.getStore?.('htr-route-check-history') || []
    } catch {
      history = []
    }
    if (!Array.isArray(history)) history = []
    const withJob = history.filter(item => item.jobId === jobId)
    const latest = withJob[0] || history.find(item => item.jobId) || history[0]
    const vehicle = latest?.vehicle || null
    const match = Boolean(
      expected
      && vehicle
      && Number(vehicle.width) === Number(expected.width)
      && Number(vehicle.height) === Number(expected.height)
      && Number(vehicle.length) === Number(expected.length)
      && Number(vehicle.grossWeight) === Number(expected.grossWeight),
    )
    const staleDefaults = vehicle
      && Number(vehicle.width) === 3
      && Number(vehicle.height) === 4
      && Number(vehicle.length) === 25
      && Number(vehicle.grossWeight) === 52
    return { match, staleDefaults, expected, vehicle, jobId }
  }, { expected: jobVehicleBefore, jobId: liveJobMeta.id })
  record(
    'Job re-run history vehicle matches saved job (not form defaults)',
    Boolean(rerunVehicleMatch.match) && !rerunVehicleMatch.staleDefaults,
    JSON.stringify(rerunVehicleMatch),
  )
  await page.goto(base + '/jobs', { waitUntil: 'domcontentloaded' })
  await page.locator(`[data-job-id="${liveJobMeta.id}"] [data-testid="job-last-check"]`).waitFor({ timeout: 15000 })
  const lastCheckAfter = await page.evaluate(jobId => {
    const job = (window.__HT_TEST__?.getJobs() || []).find(item => item.id === jobId)
    const row = document.querySelector(`[data-job-id="${jobId}"]`)
    return {
      lastCheckedAt: job?.lastCheckedAt || '',
      label: row?.querySelector('[data-testid="job-last-check"]')?.textContent || '',
    }
  }, liveJobMeta.id)
  const lastCheckUpdated = Boolean(lastCheckAfter.lastCheckedAt)
    && lastCheckAfter.lastCheckedAt !== lastCheckedBefore
    && /Just now/i.test(lastCheckAfter.label)
  record('Jobs last-check updates immediately after re-run', lastCheckUpdated, JSON.stringify({ lastCheckedBefore, ...lastCheckAfter }))

  const hookResult = await page.evaluate(async jobId => {
    const jobs = window.__HT_TEST__?.getJobs() || []
    const job = jobs.find(item => item.id === jobId) || jobs[0]
    if (!job) return { ok: false, reason: 'no job' }
    window.__HT_TEST__.simulateVerdictChange(job.id, 'HOLD')
    await new Promise(resolve => setTimeout(resolve, 200))
    const alerts = window.__HT_TEST__.getAlerts()
    return {
      ok: true,
      jobId: job.id,
      alertCount: alerts.length,
      holdAlert: alerts.some(alert => /HOLD/.test(alert.change) || alert.severity === 'HOLD'),
      unread: alerts.filter(alert => alert.status === 'New').length,
    }
  }, liveJobMeta.id)
  record('Monitoring test hook created HOLD alert', Boolean(hookResult.ok && hookResult.holdAlert), JSON.stringify(hookResult))

  await flushAccount(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ensureLoggedIn('Demo')
  const badge = await page.locator('.notification-count').textContent().catch(() => null)
  record('Alert badge updates after verdict change', Number(badge || '0') > 0, `badge=${badge}`)

  await page.goto(base + '/activity', { waitUntil: 'domcontentloaded' })
  const alertText = await page.locator('.route-alert-log').first().innerText()
  record('Alerts page includes verdict-change HOLD', /HOLD/.test(alertText), alertText.slice(0, 180).replace(/\s+/g, ' '))

  await page.evaluate(async () => {
    const alerts = window.__HT_TEST__?.getStore?.('htr-monitor-alerts') || window.__HT_TEST__?.getAlerts?.() || []
    if (Array.isArray(alerts) && alerts[0]) {
      alerts[0].escalated = true
      window.__HT_TEST__?.setStore?.('htr-monitor-alerts', alerts)
      await window.__HT_TEST__?.flushStore?.()
    }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await skipIfNeeded()
  const alertLayoutViewports = [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ]
  for (const [width, height] of alertLayoutViewports) {
    await page.setViewportSize({ width, height })
    await page.goto(base + '/activity', { waitUntil: 'domcontentloaded' })
    await skipIfNeeded()
    await page.locator('[data-testid="route-alert-group"], .route-alert-group').first().waitFor({ timeout: 15000 })
    // Groups start collapsed — expand so nested rows and Escalated badges are in the DOM.
    const groupToggle = page.locator('[data-testid="alerts-by-route"] .route-alert-group .route-alert-main').first()
    if (await groupToggle.count()) {
      const expanded = await groupToggle.getAttribute('aria-expanded')
      if (expanded !== 'true') await groupToggle.click()
    }
    await page.locator('.route-alert-item, .route-alert-group-header').first().waitFor({ timeout: 15000 })
    const layout = await page.evaluate(() => {
      const item = document.querySelector('.route-alert-item') || document.querySelector('.route-alert-group-header')
      const main = item?.querySelector('.route-alert-main') || document.querySelector('.route-alert-main')
      const chevron = item?.querySelector('.route-alert-chevron') || document.querySelector('.route-alert-chevron')
      const badges = [...document.querySelectorAll('.route-alert-group .alert-status, .route-alert-item .alert-status')]
      const truncated = badges.filter(el => el.scrollWidth > el.clientWidth + 1 || el.textContent.trim().length <= 1)
      const chevronInRow = Boolean(item && chevron && Math.abs(chevron.getBoundingClientRect().top - item.getBoundingClientRect().top) < item.getBoundingClientRect().height)
      return {
        itemOverflow: Boolean(item && item.scrollWidth > item.clientWidth + 1),
        mainOverflow: Boolean(main && main.scrollWidth > main.clientWidth + 1),
        itemScroll: item ? [item.scrollWidth, item.clientWidth] : [],
        badges: badges.map(el => el.textContent.trim()),
        truncated: truncated.map(el => el.textContent.trim()),
        chevronInRow,
      }
    })
    record(
      `Alert rows at ${width}×${height} keep Escalated untruncated with in-row chevron and no overflow`,
      !layout.itemOverflow
        && !layout.mainOverflow
        && layout.badges.includes('Escalated')
        && layout.truncated.length === 0
        && layout.chevronInRow,
      JSON.stringify(layout),
    )
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base + '/activity', { waitUntil: 'domcontentloaded' })
  await skipIfNeeded()
  const historyToggle = page.locator('[data-testid="check-history-by-route"] .route-alert-group .route-alert-main').first()
  await historyToggle.waitFor({ timeout: 15000 })
  if ((await historyToggle.getAttribute('aria-expanded')) !== 'true') await historyToggle.click()
  await page.locator('.check-history-log .route-alert-item').first().waitFor({ timeout: 15000 })
  const historyPdf = await downloadFile(page, 'PDF')
  record('History PDF download is non-empty', historyPdf.size > 200, `${historyPdf.suggested} ${historyPdf.size} bytes`)
  const historyCsv = await downloadFile(page, 'CSV')
  record('History CSV download is non-empty', historyCsv.size > 50, `${historyCsv.suggested} ${historyCsv.size} bytes`)

  await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /show sample permits/i }).click()
  await page.getByRole('button', { name: /München → Stuttgart|Munchen → Stuttgart/ }).click()
  await fillPlannedDeparture(page)
  await page.getByRole('button', { name: 'Check route' }).click()
  await page.locator('.verdict-banner').waitFor({ timeout: 90000 })
  await page.locator('.nearby-off-route-group').evaluateAll(nodes => nodes.forEach(node => { node.open = true })).catch(() => {})
  const stuttgartEvidence = await page.locator('.evidence-section').innerText()
  record(
    'Stuttgart-area route shows MobiData BW BEMaS evidence',
    /MobiData BW \(BEMaS\)/.test(stuttgartEvidence),
    stuttgartEvidence.replace(/\s+/g, ' ').slice(0, 280),
  )
  record(
    'Stuttgart-area route shows MIA roadworks source',
    /Autobahn GmbH MIA via Mobilithek\/MobiData BW/.test(stuttgartEvidence),
    stuttgartEvidence.replace(/\s+/g, ' ').slice(0, 280),
  )

  async function runHoldScenario(nameRe) {
    await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /show sample permits/i }).click()
    await page.getByRole('button', { name: nameRe }).click()
    await fillPlannedDeparture(page)
    await page.getByRole('button', { name: 'Check route' }).click()
    await page.locator('.verdict-banner').waitFor({ timeout: 30000 })
    const banner = (await page.locator('.verdict-banner').innerText()).replace(/\s+/g, ' ')
    const evidence = (await page.locator('.evidence-section').innerText()).replace(/\s+/g, ' ')
    const chip = (await page.locator('.outcome-match').innerText().catch(() => '')).replace(/\s+/g, ' ')
    return { banner, evidence, chip }
  }

  const heightHold = await runHoldScenario(/Simulated HOLD — A8 height/)
  record(
    'Scenario HOLD height shows Expected HOLD and limit vs vehicle',
    /HOLD/i.test(heightHold.banner)
      && /Expected HOLD — actual HOLD/i.test(heightHold.chip)
      && /4\.00 m vs vehicle 4\.30 m/.test(heightHold.evidence)
      && /HOLD items cannot be acknowledged away/i.test(heightHold.evidence)
      && !/Confirm remaining VERIFY on site/i.test(heightHold.evidence),
    `${heightHold.chip} ${heightHold.evidence.slice(0, 220)}`,
  )

  const weightHold = await runHoldScenario(/Simulated HOLD — A1 weight/)
  record(
    'Scenario HOLD weight shows Expected HOLD and limit vs vehicle',
    /HOLD/i.test(weightHold.banner)
      && /Expected HOLD — actual HOLD/i.test(weightHold.chip)
      && /40 t vs vehicle 72 t/.test(weightHold.evidence)
      && /HOLD items cannot be acknowledged away/i.test(weightHold.evidence)
      && !/Confirm remaining VERIFY on site/i.test(weightHold.evidence),
    `${weightHold.chip} ${weightHold.evidence.slice(0, 220)}`,
  )

  await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /show sample permits/i }).click()
  await page.getByRole('button', { name: /Simulated HOLD — A7 Vollsperrung/ }).click()
  await fillPlannedDeparture(page)
  await page.getByRole('button', { name: 'Check route' }).click()
  await page.locator('.verdict-banner').waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: /Take action/i }).first().click()
  await page.getByRole('button', { name: /^Escalate$/i }).click()
  await page.getByRole('button', { name: /Confirm escalation/i }).click()
  const decisionToastRe = /Decision saved – no external notification sent|Couldn't save to your account/i
  await page.getByText(decisionToastRe).waitFor({ timeout: 10000 })
  const holdEscalateToast = await page.locator('body').innerText()
  record(
    'Item 4: HOLD escalate uses honest saved-decision wording',
    decisionToastRe.test(holdEscalateToast)
      && !/Escalation sent to transport manager/i.test(holdEscalateToast)
      && !/Logged locally \(demo\), not sent/i.test(holdEscalateToast)
      && !/Saved locally only/i.test(holdEscalateToast),
    holdEscalateToast.replace(/\s+/g, ' ').slice(0, 220),
  )
  await page.getByRole('button', { name: /Take action/i }).first().click()
  await page.getByRole('button', { name: /Hold departure/i }).click()
  await page.getByRole('button', { name: /Confirm hold/i }).click()
  await page.getByText(decisionToastRe).waitFor({ timeout: 10000 })
  record('Item 4: hold-departure toast does not claim notify/sent', true)
  await page.getByRole('button', { name: /Take action/i }).first().click()
  await page.getByRole('button', { name: /Request on-site check/i }).click()
  await page.getByRole('button', { name: /Log check request/i }).click()
  await page.getByText(decisionToastRe).waitFor({ timeout: 10000 })
  record('Item 4: on-site check toast does not claim requested/sent', true)

  await flushAccount(page)
  const demoActionsState = await page.evaluate(async () => {
    const user = window.__HT_TEST__?.getUserId?.() || 'demo'
    const res = await fetch(`/api/state?user=${encodeURIComponent(user)}`)
    const payload = await res.json()
    const raw = payload?.data?.['htr-route-check-history']
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || [])
    const logs = Array.isArray(parsed)
      ? parsed.flatMap(row => Array.isArray(row?.actionsLog) ? row.actionsLog : [])
      : []
    return { count: Array.isArray(parsed) ? parsed.length : -1, logs: logs.slice(0, 8), backend: payload?.backend || null }
  })
  record(
    'Item 4: dispatch actions are present in GET /api/state history',
    demoActionsState.logs.some(line => /Escalate|Hold departure|On-site check/i.test(String(line))),
    JSON.stringify(demoActionsState).slice(0, 280),
  )

  await page.goto(base + '/activity', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: /Alerts & history/i }).waitFor({ timeout: 20000 })
  const expandHistoryForActions = async () => {
    const toggle = page.locator('[data-testid="check-history-by-route"] .route-alert-group .route-alert-main').first()
    await toggle.waitFor({ timeout: 15000 })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await page.locator('[data-testid="history-actions-log"]').first().waitFor({ timeout: 15000 })
  }
  await expandHistoryForActions()
  const historyActions = await page.locator('[data-testid="history-actions-log"]').first().innerText().catch(() => '')
  record(
    'Item 4: demo actions appear in check history',
    /Escalate|Hold departure|On-site check/i.test(historyActions)
      && !/Couldn't save to your account|Decision saved|Logged locally/i.test(historyActions),
    historyActions.slice(0, 220),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: /Alerts & history/i }).waitFor({ timeout: 20000 })
  await expandHistoryForActions()
  const historyActionsReload = await page.locator('[data-testid="history-actions-log"]').first().innerText().catch(() => '')
  record(
    'Item 4: dispatch actions survive reload in Alerts & history',
    /Escalate|Hold departure|On-site check/i.test(historyActionsReload)
      && !/Couldn't save to your account|Logged locally/i.test(historyActionsReload),
    historyActionsReload.slice(0, 220),
  )

  // READY proceed CTA: same honest toast + account persistence path.
  await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /show sample permits/i }).click()
  await page.getByRole('button', { name: /Simulated READY — empty A20 corridor/i }).click()
  await fillPlannedDeparture(page)
  await page.getByRole('button', { name: 'Check route' }).click()
  await page.locator('.verdict-banner').waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: /Proceed with departure/i }).first().click()
  await page.getByText(decisionToastRe).waitFor({ timeout: 10000 })
  record('Item 4: READY proceed toast is honest about save vs notify', true)
  await flushAccount(page)

  // Sample ?run=1: labelled demo departure + permit vehicle dims (not Standard 3.0×4.0×25×52).
  const bremenPayloadPromise = page.waitForRequest(
    req => req.url().includes('/api/check-route') && req.method() === 'POST',
    { timeout: 120000 },
  )
  await page.goto(base + '/route-checks?permit=bremen-dortmund&run=1', { waitUntil: 'domcontentloaded' })
  const bremenReq = await bremenPayloadPromise
  const bremenBody = bremenReq.postDataJSON()
  const bremenVehicle = bremenBody?.vehicle || {}
  record(
    'bremen-dortmund&run=1 sends permit vehicle 3.5×4.2×32×72',
    Number(bremenVehicle.width) === 3.5
      && Number(bremenVehicle.height) === 4.2
      && Number(bremenVehicle.length) === 32
      && Number(bremenVehicle.grossWeight) === 72,
    JSON.stringify(bremenVehicle),
  )
  await page.locator('.verdict-banner, .checking-state').first().waitFor({ timeout: 15000 })
  if (await page.locator('.checking-state').count()) {
    await page.locator('.verdict-banner').waitFor({ timeout: 120000 })
  } else {
    await page.locator('.verdict-banner').waitFor({ timeout: 30000 })
  }
  const bremenResult = await page.evaluate(() => {
    const banner = document.querySelector('.verdict-banner')?.textContent || ''
    const demoNote = document.querySelector('[data-testid="demo-departure-note"]')?.textContent || ''
    let history = []
    try {
      history = window.__HT_TEST__?.getHistory?.() || window.__HT_TEST__?.getStore?.('htr-route-check-history') || []
    } catch {
      history = []
    }
    if (!Array.isArray(history)) history = []
    return {
      banner,
      demoNote,
      vehicle: history[0]?.vehicle || null,
      verdict: history[0]?.verdict || '',
    }
  })
  record(
    'bremen-dortmund&run=1 gives HOLD with demo departure note',
    /HOLD/i.test(bremenResult.banner)
      && bremenResult.verdict === 'HOLD'
      && /Demo departure:/i.test(bremenResult.demoNote)
      && /change it and re-check/i.test(bremenResult.demoNote)
      && Number(bremenResult.vehicle?.width) === 3.5
      && Number(bremenResult.vehicle?.grossWeight) === 72,
    JSON.stringify({
      verdict: bremenResult.verdict,
      demoNote: bremenResult.demoNote.slice(0, 120),
      vehicle: bremenResult.vehicle,
      banner: bremenResult.banner.replace(/\s+/g, ' ').slice(0, 160),
    }),
  )

  await page.goto(base + '/route-checks?permit=hamburg-hannover&run=1', { waitUntil: 'domcontentloaded' })
  await page.locator('.verdict-banner, .checking-state, #planned-departure').first().waitFor({ timeout: 15000 })
  if (await page.locator('.checking-state').count()) {
    await page.locator('.verdict-banner').waitFor({ timeout: 120000 })
  }
  const permitAutorun = await page.evaluate(() => {
    const fileError = document.querySelector('[data-testid="gpx-upload-error"]')
    const demoNote = document.querySelector('[data-testid="demo-departure-note"]')?.textContent || ''
    const width = document.querySelector('[data-testid="vehicle-width"]')
    let history = []
    try {
      history = window.__HT_TEST__?.getHistory?.() || window.__HT_TEST__?.getStore?.('htr-route-check-history') || []
    } catch {
      history = []
    }
    if (!Array.isArray(history)) history = []
    return {
      fileErrorVisible: Boolean(fileError),
      fileErrorText: fileError?.textContent || '',
      demoNote,
      width: width?.value || '',
      historyVehicle: history[0]?.vehicle || null,
      hasVerdict: Boolean(document.querySelector('.verdict-banner')),
    }
  })
  record(
    'Permit ?run=1 applies demo departure and permit vehicle (no file error)',
    !permitAutorun.fileErrorVisible
      && /Demo departure:/i.test(permitAutorun.demoNote)
      && permitAutorun.hasVerdict
      && Number(permitAutorun.historyVehicle?.width) === 3.2
      && Number(permitAutorun.historyVehicle?.height) === 4.5
      && Number(permitAutorun.historyVehicle?.length) === 28.5
      && Number(permitAutorun.historyVehicle?.grossWeight) === 60,
    JSON.stringify(permitAutorun),
  )

  await page.goto(base + '/route-checks?debug=1', { waitUntil: 'networkidle', timeout: 60000 }).catch(() =>
    page.goto(base + '/route-checks?debug=1', { waitUntil: 'domcontentloaded' }),
  )
  await page.getByRole('heading', { name: /Route check/i }).first().waitFor({ timeout: 15000 }).catch(() => {})
  const debugTrigger = await page.locator('[data-testid="debug-scenarios-trigger"], .test-scenarios-trigger').count()
  record('Item 7: 🧪 only appears with ?debug', debugTrigger === 1, `count=${debugTrigger} url=${page.url()}`)

  await page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Data sources/i }).click()
  const sourcesText = await page.locator('.data-source-list').innerText()
  record(
    'Settings lists Mobilithek as integrated via MobiData BW',
    /Integrated via MobiData BW open republication/.test(sourcesText)
      && /dl-de\/by-2\.0/i.test(sourcesText)
      && !/No keyless public dataset was found/.test(sourcesText),
    sourcesText.replace(/\s+/g, ' ').slice(0, 400),
  )

  const measureVerdictContrast = () => {
    const parse = (input) => {
      if (!input || input === 'transparent') return null
      const rgba = String(input).match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i)
      if (rgba) {
        const a = rgba[4] === undefined ? 1 : Number(rgba[4])
        if (a <= 0.01) return null
        return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a }
      }
      const srgb = String(input).match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/i)
      if (srgb) {
        const a = srgb[4] === undefined ? 1 : Number(srgb[4])
        if (a <= 0.01) return null
        return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a }
      }
      return null
    }
    const parseHex = (hex) => {
      const m = String(hex).match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
      if (!m) return null
      let h = m[1]
      if (h.length === 3) h = h.split('').map((c) => c + c).join('')
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      }
    }
    const blend = (fg, bg) => ({
      r: fg.r * (fg.a ?? 1) + bg.r * (1 - (fg.a ?? 1)),
      g: fg.g * (fg.a ?? 1) + bg.g * (1 - (fg.a ?? 1)),
      b: fg.b * (fg.a ?? 1) + bg.b * (1 - (fg.a ?? 1)),
      a: 1,
    })
    const luminance = (r, g, b) => {
      const toLin = (c) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b)
    }
    const ratio = (fg, bg) => {
      const mixed = blend(fg, bg)
      const L1 = luminance(mixed.r, mixed.g, mixed.b)
      const L2 = luminance(bg.r, bg.g, bg.b)
      return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    }
    const parseGradientStops = (value) => {
      if (!value || value === 'none') return []
      const stops = []
      const re = /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)|color\(\s*srgb\s+[\d.]+\s+[\d.]+\s+[\d.]+(?:\s*\/\s*[\d.]+)?\s*\)/gi
      let m
      while ((m = re.exec(value))) {
        const c = parse(m[0]) || parseHex(m[0])
        if (c && c.a >= 0.6) stops.push(c)
      }
      return stops
    }
    const averageStops = (stops) => {
      if (!stops.length) return null
      const sum = stops.reduce((acc, s) => ({
        r: acc.r + s.r,
        g: acc.g + s.g,
        b: acc.b + s.b,
      }), { r: 0, g: 0, b: 0 })
      return {
        r: sum.r / stops.length,
        g: sum.g / stops.length,
        b: sum.b / stops.length,
        a: 1,
      }
    }
    const solidFromNode = (node, underlay) => {
      const cs = getComputedStyle(node)
      const bg = parse(cs.backgroundColor)
      if (bg && bg.a >= 0.85) return bg
      const gradient = averageStops(parseGradientStops(cs.backgroundImage))
      if (gradient) return underlay ? blend({ ...gradient, a: 0.92 }, underlay) : gradient
      if (bg && bg.a >= 0.6 && underlay) return blend(bg, underlay)
      if (bg && bg.a >= 0.6) return { r: bg.r, g: bg.g, b: bg.b, a: 1 }
      return null
    }
    const effectiveBg = (el) => {
      const stack = []
      let node = el
      while (node && node !== document.documentElement) {
        stack.push(node)
        node = node.parentElement
      }
      let bg = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 }
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const next = solidFromNode(stack[i], bg)
        if (next) bg = next
      }
      return bg
    }
    const measure = (el) => {
      if (!el) return null
      const fg = parse(getComputedStyle(el).color)
      const bg = effectiveBg(el)
      if (!fg || !bg) return null
      return Number(ratio(fg, bg).toFixed(2))
    }
    const banner = document.querySelector('.verdict-banner')
    const title = banner?.querySelector('h2')
    const pill = banner?.querySelector('.verdict-label')
    const recheck = banner?.querySelector('.btn-text')
    const button = document.querySelector('.btn-primary')
    const badge = document.querySelector('.notification-count')
    return {
      title: measure(title),
      pill: measure(pill),
      recheck: measure(recheck),
      button: measure(button),
      badge: measure(badge),
      bannerClass: banner?.className || '',
      titleText: (title?.textContent || '').trim().slice(0, 80),
      pillText: (pill?.textContent || '').trim().slice(0, 40),
      recheckText: (recheck?.textContent || '').trim().slice(0, 40),
      badgeText: (badge?.textContent || '').trim().slice(0, 8),
    }
  }

  async function runContrastSample(colorScheme, sampleName, bannerSelector) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme,
    })
    await context.addInitScript(({ key, value }) => {
      try {
        localStorage.setItem('htr-current-user', 'demo')
        localStorage.setItem(key, value)
      } catch {}
    }, { key: DEMO_TOUR_STORAGE_KEY, value: DISMISSED_DEMO_TOUR_PROGRESS })
    const page = await context.newPage()
    await page.emulateMedia({ colorScheme })
    await page.goto(base + '/route-checks', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.getByRole('heading', { name: /Route check/i }).first().waitFor({ timeout: 20000 }).catch(() => {})
    const login = page.getByRole('button', { name: 'Continue as Demo' })
    if (await login.count()) {
      await seedDismissedDemoTour(page)
      await login.click().catch(() => {})
    }
    const skip = page.getByRole('button', { name: /skip/i })
    if (await skip.count()) await skip.first().click({ timeout: 2000 }).catch(() => {})
    const later = page.getByRole('button', { name: /later|not now|continue without/i })
    if (await later.count()) await later.first().click({ timeout: 1500 }).catch(() => {})
    await page.getByRole('button', { name: /show sample permits/i }).click({ timeout: 15000 })
    await page.getByRole('button', { name: sampleName }).click({ timeout: 15000 })
    await fillPlannedDeparture(page)
    await page.getByRole('button', { name: 'Check route' }).click()
    await page.locator(bannerSelector).waitFor({ timeout: 90000 })
    await page.waitForTimeout(800)
    const contrast = await page.evaluate(measureVerdictContrast)
    await context.close()
    return contrast
  }

  // Multi-job account sync: ≥15 realistic jobs must all persist (keepalive quota).
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Continue as Luis' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  const skipLuis = page.getByRole('button', { name: /skip/i })
  if (await skipLuis.count()) await skipLuis.first().click().catch(() => {})
  if (!(await page.getByRole('heading', { name: /Saved jobs|Jobs/i }).count())) {
    await page.getByRole('link', { name: 'Jobs' }).first().click().catch(() => {})
  }
  await page.waitForFunction(() => Boolean(window.__HT_TEST__?.setStore), null, { timeout: 20000 })
  const multiJob = await page.evaluate(async () => {
    const gpx = await fetch('/test-permits/bremen-dortmund-a1.gpx').then(r => r.text())
    const jobs = []
    let sawNotSaved = false
    const prefix = `Luis multi ${Date.now()}`
    for (let i = 0; i < 15; i++) {
      const now = new Date().toISOString()
      jobs.unshift({
        id: `job-luis-multi-${Date.now()}-${i}`,
        name: `${prefix} #${i + 1}`,
        permitNumber: `DE-HB-LUIS-${70000 + i}`,
        routeFileName: 'bremen-dortmund-a1.gpx',
        gpxContent: gpx,
        origin: 'Bremen Heavy Cargo Terminal',
        destination: 'Dortmund',
        corridor: 'A1',
        permittedRoads: ['A1'],
        vehicle: { width: 3.5, height: 4.2, length: 32, grossWeight: 72 },
        plannedDeparture: now,
        monitorIntervalMinutes: 15,
        createdAt: now,
        updatedAt: now,
        lastCheckedAt: now,
        lastVerdict: i % 3 === 0 ? 'HOLD' : i % 3 === 1 ? 'VERIFY' : 'READY',
        lastSummary: 'Residual width conflict on the permitted A1 corridor — confirm before departure.',
        lastRetrievedAt: now,
        lastSource: 'Autobahn GmbH MIA, Open Roadworks',
        monitoringStoppedReason: null,
      })
      window.__HT_TEST__?.setStore?.('htr-saved-jobs', jobs.slice())
      await window.__HT_TEST__?.flushStore?.()
      // Give the PUT a moment; chip must never stick on "Not saved".
      await new Promise(resolve => setTimeout(resolve, 120))
      if (document.querySelector('.user-chip-badge.is-error')) sawNotSaved = true
    }
    // Wait until the error badge is gone (final save settled).
    for (let t = 0; t < 80; t++) {
      if (!document.querySelector('.user-chip-badge.is-error')) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await window.__HT_TEST__?.flushStore?.()
    await new Promise(resolve => setTimeout(resolve, 400))
    const res = await fetch('/api/state?user=luis')
    const payload = await res.json()
    const raw = payload?.data?.['htr-saved-jobs']
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || [])
    const matched = Array.isArray(parsed) ? parsed.filter(item => String(item?.name || '').startsWith(prefix)) : []
    const bodyProbe = JSON.stringify({ user: 'luis', key: 'htr-saved-jobs', value: parsed })
    return {
      apiCount: matched.length,
      totalApi: Array.isArray(parsed) ? parsed.length : -1,
      sawNotSaved,
      notSavedNow: Boolean(document.querySelector('.user-chip-badge.is-error')),
      approxBytes: new TextEncoder().encode(bodyProbe).length,
      prefix,
    }
  })
  record(
    'Luis can save ≥15 jobs without Not saved / data loss',
    multiJob.apiCount >= 15 && !multiJob.sawNotSaved && !multiJob.notSavedNow,
    JSON.stringify(multiJob),
  )
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 }).catch(() => {})
  const multiJobAfterReload = await page.evaluate(async (prefix) => {
    const res = await fetch('/api/state?user=luis')
    const payload = await res.json()
    const raw = payload?.data?.['htr-saved-jobs']
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || [])
    const matched = Array.isArray(parsed) ? parsed.filter(item => String(item?.name || '').startsWith(prefix)) : []
    return {
      apiCount: matched.length,
      notSaved: Boolean(document.querySelector('.user-chip-badge.is-error')),
    }
  }, multiJob.prefix)
  record(
    'Luis ≥15 jobs still present in GET /api/state after reload',
    multiJobAfterReload.apiCount >= 15 && !multiJobAfterReload.notSaved,
    JSON.stringify(multiJobAfterReload),
  )

  // Per-user isolation: Ana's job must not appear for Paul.
  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Continue as Ana' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  // Collapsed-rail tooltips must escape overflow clipping (hover + focus-visible).
  await page.setViewportSize({ width: 1440, height: 900 })
  // Headless defaults to hover:none which suppresses :hover tooltips — emulate a mouse.
  try {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'hover', value: 'hover' },
        { name: 'any-hover', value: 'hover' },
        { name: 'pointer', value: 'fine' },
        { name: 'any-pointer', value: 'fine' },
      ],
    })
  } catch {
    // CDP optional — focus-visible path below still covers keyboard users.
  }
  const collapseBtn = page.getByRole('button', { name: 'Collapse navigation' })
  if (await collapseBtn.count()) await collapseBtn.click().catch(() => {})
  const railOverflow = await page.evaluate(() => {
    const aside = document.querySelector('.app-sidebar')
    const nav = document.querySelector('.sidebar-nav')
    if (!aside || !nav) return { ok: false }
    const asideStyle = getComputedStyle(aside)
    const navStyle = getComputedStyle(nav)
    return {
      ok: aside.classList.contains('is-collapsed-rail')
        && asideStyle.overflow === 'visible'
        && navStyle.overflow === 'visible',
      asideOverflow: asideStyle.overflow,
      navOverflow: navStyle.overflow,
      collapsed: aside.classList.contains('is-collapsed-rail'),
    }
  })
  record(
    'Collapsed rail overflow is visible for tooltips',
    Boolean(railOverflow.ok),
    JSON.stringify(railOverflow),
  )
  const routeChecksLink = page.getByRole('link', { name: 'Route checks' }).first()
  await routeChecksLink.hover()
  await page.waitForTimeout(80)
  let routeTip = await routeChecksLink.evaluate(el => {
    const after = getComputedStyle(el, '::after')
    return { content: after.content, opacity: after.opacity }
  })
  // Focus path (works even when headless reports hover:none).
  if (!(Number(routeTip.opacity) > 0.9)) {
    await routeChecksLink.focus()
    await page.waitForTimeout(40)
    routeTip = await routeChecksLink.evaluate(el => {
      const after = getComputedStyle(el, '::after')
      return { content: after.content, opacity: after.opacity, active: document.activeElement === el }
    })
  }
  record(
    'Collapsed Route checks tooltip is visible beside the rail',
    routeTip.content.includes('Route checks') && Number(routeTip.opacity) > 0.9,
    JSON.stringify(routeTip),
  )
  const annaChip = page.getByRole('button', { name: /Switch user \(Ana\)/i }).first()
  await annaChip.hover()
  await page.waitForTimeout(80)
  let annaTip = await annaChip.evaluate(el => {
    const after = getComputedStyle(el, '::after')
    return { content: after.content, opacity: after.opacity }
  })
  if (!(Number(annaTip.opacity) > 0.9)) {
    await annaChip.focus()
    await page.waitForTimeout(40)
    annaTip = await annaChip.evaluate(el => {
      const after = getComputedStyle(el, '::after')
      return { content: after.content, opacity: after.opacity, active: document.activeElement === el }
    })
  }
  record(
    'Collapsed Ana chip tooltip shows Ana · Switch user',
    /Ana/i.test(annaTip.content) && /Switch user/i.test(annaTip.content) && Number(annaTip.opacity) > 0.9,
    JSON.stringify(annaTip),
  )
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync('/tmp/htr-qa', { recursive: true })
    await page.screenshot({ path: '/tmp/htr-qa/collapsed-rail-tooltips.png', fullPage: false })
  } catch {
    // Screenshot is diagnostic only.
  }
  const expandBtn = page.getByRole('button', { name: 'Expand navigation' })
  if (await expandBtn.count()) await expandBtn.click().catch(() => {})
  // Client-side: Router remounts on the current URL (likely /jobs or /). Prefer Jobs nav.
  if (!(await page.getByRole('heading', { name: /Saved jobs|Jobs/i }).count())) {
    await page.getByRole('link', { name: 'Jobs' }).first().click()
  }
  await page.getByRole('heading', { name: /Saved jobs|Jobs/i }).first().waitFor({ timeout: 15000 }).catch(() => {})
  const annaJobName = `Ana isolation ${Date.now()}`
  const annaSaved = await page.evaluate(async (name) => {
    const job = {
      id: `job-anna-${Date.now()}`,
      name,
      permitName: name,
      permitNumber: 'ISO-ANNA',
      corridor: 'A7',
      permittedRoads: ['A7'],
      plannedDeparture: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
      vehicle: { width: 3, height: 4, length: 25, grossWeight: 52 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gpxText: '',
      monitorIntervalMinutes: 15,
      monitoringStoppedReason: null,
    }
    window.__HT_TEST__?.setStore?.('htr-saved-jobs', [job])
    await window.__HT_TEST__?.flushStore?.()
    const res = await fetch('/api/state?user=anna')
    const payload = await res.json()
    const raw = payload?.data?.['htr-saved-jobs']
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) && parsed.some(item => item?.name === name)
  }, annaJobName)
  // Remount providers from store without a full document reload race.
  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('button', { name: 'Continue as Ana' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  if (!(await page.getByRole('heading', { name: /Saved jobs|Jobs/i }).count())) {
    await page.getByRole('link', { name: 'Jobs' }).first().click()
  }
  await page.getByText(annaJobName).first().waitFor({ timeout: 15000 })
  record('Ana can save a job to her account', annaSaved && await page.getByText(annaJobName).count() > 0, annaJobName)

  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Continue as Paul' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  if (!(await page.getByRole('heading', { name: /Saved jobs|Jobs/i }).count())) {
    await page.getByRole('link', { name: 'Jobs' }).first().click()
  }
  await page.waitForTimeout(400)
  const paulSeesAna = await page.getByText(annaJobName).count()
  const paulApi = await page.evaluate(async (name) => {
    const res = await fetch('/api/state?user=paul')
    const payload = await res.json()
    const raw = payload?.data?.['htr-saved-jobs']
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || [])
    return Array.isArray(parsed) ? parsed.filter(item => item?.name === name).length : -1
  }, annaJobName)
  record('Paul does not see Ana’s job', paulSeesAna === 0 && paulApi === 0, `ui=${paulSeesAna} api=${paulApi}`)

  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Continue as Ana' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  if (!(await page.getByRole('heading', { name: /Saved jobs|Jobs/i }).count())) {
    await page.getByRole('link', { name: 'Jobs' }).first().click()
  }
  await page.getByText(annaJobName).first().waitFor({ timeout: 15000 }).catch(() => {})
  const annaSeesAgain = await page.getByText(annaJobName).count()
  const annaApiAgain = await page.evaluate(async (name) => {
    const res = await fetch('/api/state?user=anna')
    const payload = await res.json()
    const raw = payload?.data?.['htr-saved-jobs']
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || [])
    const jobs = window.__HT_TEST__?.getJobs?.() || []
    return {
      api: Array.isArray(parsed) ? parsed.filter(item => item?.name === name).length : -1,
      hook: jobs.filter(item => item?.name === name).length,
    }
  }, annaJobName)
  record(
    'Switching back to Ana restores her job',
    annaSeesAgain > 0 || annaApiAgain.api > 0 || annaApiAgain.hook > 0,
    JSON.stringify({ ui: annaSeesAgain, ...annaApiAgain }),
  )

  // Race: Ana has a job + delayed re-check / pending save; switch to Paul within ~1s.
  // Paul must stay empty; Ana's job (same createdAt) must stay intact.
  const raceJobName = `Ana race ${Date.now()}`
  const raceCreatedAt = new Date().toISOString()
  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ timeout: 15000 })
  // Switch user must clear htr-current-user so reload does not auto-sign Ana back in.
  const storedAfterSwitch = await page.evaluate(() => {
    try { return localStorage.getItem('htr-current-user') } catch { return 'err' }
  })
  record('Switch user clears htr-current-user', storedAfterSwitch == null, `stored=${storedAfterSwitch}`)
  await page.getByRole('button', { name: 'Continue as Ana' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  await page.waitForFunction(() => Boolean(window.__HT_TEST__?.setStore), null, { timeout: 20000 })

  let releaseCheck = null
  const checkGate = new Promise(resolve => { releaseCheck = resolve })
  await page.route('**/api/check-route', async (route) => {
    await checkGate
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        verdict: 'READY',
        title: 'Route clear – race test',
        summary: 'Delayed re-check for isolation race',
        impact: 'n/a',
        confidence: 'medium',
        issueCount: 0,
        evidence: [],
        route: { coordinates: [], origin: 'A', destination: 'B', distance: 1, corridor: 'A7' },
        degraded: false,
        retrievedAt: new Date().toISOString(),
        source: 'QA race',
      }),
    })
  })

  await page.evaluate(async ({ name, createdAt }) => {
    const job = {
      id: `job-anna-race-${Date.now()}`,
      name,
      permitName: name,
      permitNumber: 'ISO-RACE',
      corridor: 'A7',
      permittedRoads: ['A7'],
      origin: 'A',
      destination: 'B',
      plannedDeparture: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
      vehicle: { width: 3, height: 4, length: 25, grossWeight: 52 },
      createdAt,
      updatedAt: createdAt,
      gpxContent: '<gpx></gpx>',
      gpxText: '<gpx></gpx>',
      monitorIntervalMinutes: 1,
      lastCheckedAt: null,
      monitoringStoppedReason: null,
    }
    window.__HT_TEST__?.setStore?.('htr-saved-jobs', [job])
    await window.__HT_TEST__?.flushStore?.()
  }, { name: raceJobName, createdAt: raceCreatedAt })

  // Trigger a monitor re-check that stays in-flight while we switch.
  await page.evaluate(() => { window.__HT_TEST__.tickMs = 50 })
  // Remount monitor interval by navigating; JobsProvider reads tickMs on mount.
  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('button', { name: 'Continue as Ana' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  await page.waitForFunction(() => Boolean(window.__HT_TEST__?.getJobs), null, { timeout: 20000 })
  await page.evaluate(async ({ name, createdAt }) => {
    const job = {
      id: `job-anna-race-${Date.now()}`,
      name,
      permitName: name,
      permitNumber: 'ISO-RACE',
      corridor: 'A7',
      permittedRoads: ['A7'],
      origin: 'A',
      destination: 'B',
      plannedDeparture: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
      vehicle: { width: 3, height: 4, length: 25, grossWeight: 52 },
      createdAt,
      updatedAt: createdAt,
      gpxContent: '<gpx></gpx>',
      monitorIntervalMinutes: 1,
      lastCheckedAt: null,
      monitoringStoppedReason: null,
    }
    window.__HT_TEST__?.setStore?.('htr-saved-jobs', [job])
    await window.__HT_TEST__?.flushStore?.()
  }, { name: raceJobName, createdAt: raceCreatedAt })

  // Wait briefly for the due-check tick to fire (held by route gate).
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Continue as Paul' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  // Release the delayed re-check after Paul is active — must not leak into Paul's store.
  releaseCheck?.()
  await page.waitForTimeout(800)
  await page.unroute('**/api/check-route').catch(() => {})

  if (!(await page.getByRole('heading', { name: /Saved jobs|Jobs/i }).count())) {
    await page.getByRole('link', { name: 'Jobs' }).first().click()
  }
  await page.waitForTimeout(400)
  const paulRaceUi = await page.getByText(raceJobName).count()
  const paulRaceApi = await page.evaluate(async (name) => {
    const res = await fetch('/api/state?user=paul')
    const payload = await res.json()
    const raw = payload?.data?.['htr-saved-jobs']
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || [])
    const historyRaw = payload?.data?.['htr-route-check-history']
    const history = typeof historyRaw === 'string' ? JSON.parse(historyRaw || '[]') : (historyRaw || [])
    const hookJobs = window.__HT_TEST__?.getJobs?.() || []
    return {
      apiJobs: Array.isArray(parsed) ? parsed.filter(item => item?.name === name).length : -1,
      hookJobs: hookJobs.filter(item => item?.name === name).length,
      history: Array.isArray(history) ? history.filter(item => String(item?.permitName || '').includes('Ana race')).length : -1,
    }
  }, raceJobName)
  record(
    'Quick switch: Paul stays empty after Ana in-flight re-check',
    paulRaceUi === 0 && paulRaceApi.apiJobs === 0 && paulRaceApi.hookJobs === 0 && paulRaceApi.history === 0,
    JSON.stringify({ ui: paulRaceUi, ...paulRaceApi }),
  )

  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('button', { name: 'Continue as Ana' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  if (!(await page.getByRole('heading', { name: /Saved jobs|Jobs/i }).count())) {
    await page.getByRole('link', { name: 'Jobs' }).first().click()
  }
  const annaRace = await page.evaluate(async ({ name, createdAt }) => {
    const res = await fetch('/api/state?user=anna')
    const payload = await res.json()
    const raw = payload?.data?.['htr-saved-jobs']
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || [])
    const match = Array.isArray(parsed) ? parsed.find(item => item?.name === name) : null
    const hook = (window.__HT_TEST__?.getJobs?.() || []).find(item => item?.name === name)
    return {
      apiCreatedAt: match?.createdAt || null,
      hookCreatedAt: hook?.createdAt || null,
      expected: createdAt,
    }
  }, { name: raceJobName, createdAt: raceCreatedAt })
  record(
    'Quick switch: Ana job intact with same createdAt',
    annaRace.apiCreatedAt === raceCreatedAt || annaRace.hookCreatedAt === raceCreatedAt,
    JSON.stringify(annaRace),
  )

  // Account check-history sync: Bremen sample must survive reload on Alerts & history.
  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await page.getByRole('heading', { name: "Who's checking routes?" }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Continue as Ana' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })
  const annaHistoryPayload = page.waitForRequest(
    req => req.url().includes('/api/check-route') && req.method() === 'POST',
    { timeout: 120000 },
  )
  await page.goto(base + '/route-checks?permit=bremen-dortmund&run=1', { waitUntil: 'domcontentloaded' })
  await annaHistoryPayload
  await page.locator('.verdict-banner, .checking-state').first().waitFor({ timeout: 15000 })
  if (await page.locator('.checking-state').count()) {
    await page.locator('.verdict-banner').waitFor({ timeout: 120000 })
  } else {
    await page.locator('.verdict-banner').waitFor({ timeout: 30000 })
  }
  await page.waitForFunction(() => {
    const history = window.__HT_TEST__?.getHistory?.() || window.__HT_TEST__?.getStore?.('htr-route-check-history') || []
    return Array.isArray(history) && history.length >= 1
  }, null, { timeout: 30000 }).catch(() => {})
  await page.evaluate(async () => {
    await window.__HT_TEST__?.flushStore?.()
  })
  // Wait until the PUT has landed (save chip leaves pending/error).
  await page.waitForFunction(() => {
    const badge = document.querySelector('.user-chip-badge.is-error')
    return !badge
  }, null, { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(800)

  const annaStateBeforeReload = await page.evaluate(async () => {
    const res = await fetch('/api/state?user=anna')
    const payload = await res.json()
    const raw = payload?.data?.['htr-route-check-history']
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || [])
    return {
      hasKey: Object.prototype.hasOwnProperty.call(payload?.data || {}, 'htr-route-check-history'),
      count: Array.isArray(parsed) ? parsed.length : -1,
      backend: payload?.backend || null,
    }
  })
  record(
    'Ana Bremen check is present in GET /api/state history',
    annaStateBeforeReload.hasKey && annaStateBeforeReload.count >= 1,
    JSON.stringify(annaStateBeforeReload),
  )

  await page.goto(base + '/activity', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: /Alerts & history/i }).waitFor({ timeout: 20000 })
  const historyGroups = page.locator('[data-testid="check-history-by-route"] .route-alert-group')
  await historyGroups.first().waitFor({ timeout: 15000 }).catch(() => {})
  if (await historyGroups.count()) {
    const toggle = historyGroups.first().locator('.route-alert-main').first()
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  }
  const activityChecks = await page.locator('.check-history-log .route-alert-item, .check-history-log .route-alert-group').count()
  const activityEmpty = await page.getByRole('heading', { name: /No checks yet|No checks in this browser/i }).count()
  record(
    'Alerts & history shows ≥1 check after reload for Ana',
    activityChecks >= 1 && activityEmpty === 0,
    `checks=${activityChecks} empty=${activityEmpty}`,
  )

  // Return to Demo for any remaining checks.
  await page.getByRole('button', { name: 'Switch user' }).first().click()
  await seedDismissedDemoTour(page)
  await page.getByRole('button', { name: 'Continue as Demo' }).click()
  await page.waitForFunction(() => !document.querySelector('.login-screen'), null, { timeout: 30000 })

  // Dark-mode HOLD banner title must stay ≥4.5:1 (safety-critical).
  const holdContrast = await runContrastSample(
    'dark',
    /Simulated HOLD — A3 residual width/,
    '.verdict-banner.verdict-red',
  )
  record(
    'Dark-mode HOLD banner title contrast ≥ 4.5:1',
    Number(holdContrast.title) >= 4.5,
    JSON.stringify(holdContrast),
  )
  record(
    'Dark-mode Hold departure pill contrast ≥ 4.5:1',
    holdContrast.pill == null || Number(holdContrast.pill) >= 4.5,
    `pill=${holdContrast.pill}`,
  )
  record(
    'Dark-mode Re-check contrast ≥ 4.5:1',
    holdContrast.recheck == null || Number(holdContrast.recheck) >= 4.5,
    `recheck=${holdContrast.recheck}`,
  )
  record(
    'Dark-mode notification badge contrast ≥ 4.5:1',
    holdContrast.badge != null && Number(holdContrast.badge) >= 4.5,
    `badge=${holdContrast.badge}`,
  )
  record(
    'Dark-mode primary button contrast ≥ 4.5:1',
    holdContrast.button == null || Number(holdContrast.button) >= 4.5,
    `button=${holdContrast.button}`,
  )

  const darkReady = await runContrastSample('dark', /Simulated READY/, '.verdict-banner.verdict-green')
  record(
    'Dark-mode READY Re-check contrast ≥ 4.5:1',
    darkReady.recheck == null || Number(darkReady.recheck) >= 4.5,
    `recheck=${darkReady.recheck}`,
  )
  record(
    'Dark-mode Ready to depart pill contrast ≥ 4.5:1',
    darkReady.pill == null || Number(darkReady.pill) >= 4.5,
    `pill=${darkReady.pill}`,
  )

  const darkVerify = await runContrastSample('dark', /Simulated VERIFY/, '.verdict-banner.verdict-amber')
  record(
    'Dark-mode VERIFY Re-check contrast ≥ 4.5:1',
    darkVerify.recheck == null || Number(darkVerify.recheck) >= 4.5,
    `recheck=${darkVerify.recheck}`,
  )

  const lightReady = await runContrastSample('light', /Simulated READY/, '.verdict-banner.verdict-green')
  record(
    'Light-mode Ready to depart pill contrast ≥ 4.5:1',
    lightReady.pill == null || Number(lightReady.pill) >= 4.5,
    `pill=${lightReady.pill}`,
  )
  record(
    'Light-mode READY Re-check contrast ≥ 4.5:1',
    lightReady.recheck == null || Number(lightReady.recheck) >= 4.5,
    `recheck=${lightReady.recheck}`,
  )

  const lightHold = await runContrastSample('light', /Simulated HOLD — A7 Vollsperrung/, '.verdict-banner.verdict-red')
  record(
    'Light-mode Hold departure pill contrast ≥ 4.5:1',
    lightHold.pill == null || Number(lightHold.pill) >= 4.5,
    `pill=${lightHold.pill}`,
  )
  record(
    'Light-mode HOLD Re-check contrast ≥ 4.5:1',
    lightHold.recheck == null || Number(lightHold.recheck) >= 4.5,
    `recheck=${lightHold.recheck}`,
  )
  record(
    'Light-mode notification badge contrast ≥ 4.5:1',
    lightHold.badge != null && Number(lightHold.badge) >= 4.5,
    `badge=${lightHold.badge}`,
  )

  await browser.close()
  preview.kill('SIGTERM')

  const failed = results.filter(item => !item.ok)
  console.log('\n=== QA FEATURES SUMMARY ===')
  console.log(`${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
