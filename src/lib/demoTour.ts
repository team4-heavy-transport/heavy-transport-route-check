import { APP_USERS } from './users'
import { DEMO_TOUR_USER_ID } from './demoTourGate'

export { DEMO_TOUR_USER_ID, isDemoTourUser } from './demoTourGate'

/** localStorage key — Demo-scoped; never written to /api/state. */
export const DEMO_TOUR_STORAGE_KEY = 'htr-demo-tour:v1'

export const TOUR_SECTION_ORDER = [
  'overview',
  'route-check',
  'jobs',
  'alerts',
  'corridor',
  'settings',
  'chrome',
  'data-partners',
] as const

export type TourSectionId = (typeof TOUR_SECTION_ORDER)[number]

export type TourSectionMeta = {
  id: TourSectionId
  label: string
  route: string
}

export const TOUR_SECTIONS: readonly TourSectionMeta[] = [
  { id: 'overview', label: 'Overview', route: '/' },
  { id: 'route-check', label: 'Route check', route: '/route-checks' },
  { id: 'jobs', label: 'Jobs', route: '/jobs' },
  { id: 'alerts', label: 'Alerts & history', route: '/activity' },
  { id: 'corridor', label: 'Corridor monitor', route: '/map-explorer' },
  { id: 'settings', label: 'Settings', route: '/settings' },
  { id: 'chrome', label: 'Search & Switch user', route: '/' },
  { id: 'data-partners', label: 'Data partners', route: '/data-partners' },
]

/**
 * How the coachmark advances.
 * - next: Back/Next only
 * - click: waits until the user clicks the anchor (or Do it for me)
 * - present: advances when a selector appears (e.g. result banner)
 * - route: advances when pathname matches
 */
export type TourAdvance =
  | { type: 'next' }
  | { type: 'click' }
  | { type: 'present'; selector: string }
  | { type: 'route'; path: string }

export type TourStepDef = {
  id: string
  section: TourSectionId
  title: string
  body: string
  /** Prefer [data-tour="…"]; falls back to a centred card if missing. */
  anchor?: string
  /** Navigate here before showing the step (if not already there). */
  route?: string
  /** Skip when the anchor never appears (timeout). */
  optional?: boolean
  advance?: TourAdvance
  /** Label for a button that performs the interactive action for the user. */
  doItLabel?: string
  /** Selector to click for "Do it for me" (defaults to anchor). */
  doItSelector?: string
}

/** Full tour step list — chained in this order. */
export const TOUR_STEPS: readonly TourStepDef[] = [
  // ── Overview ──────────────────────────────────────────────────────────
  {
    id: 'overview-hero',
    section: 'overview',
    title: 'Your dispatch home',
    body: 'Overview shows whether permitted routes look usable before departure. Start a check or open the live corridor monitor from here.',
    anchor: '[data-tour="overview-hero"]',
    route: '/',
  },
  {
    id: 'overview-import',
    section: 'overview',
    title: 'Import a permitted route',
    body: 'Use Import permitted route to upload a VEMAGS GPX (or pick a sample) and run a live check.',
    anchor: '[data-tour="overview-cta-import"]',
    route: '/',
  },
  {
    id: 'overview-mode',
    section: 'overview',
    title: 'Demo vs sample permit',
    body: 'Demo dashboard is a fixed preview (never saved). Try a sample permit runs a real check on a sample GPX and saves it to your history.',
    anchor: '[data-tour="overview-mode-panel"]',
    route: '/',
  },
  {
    id: 'overview-next',
    section: 'overview',
    title: 'Next transport',
    body: 'The featured card shows the next demo departure with a READY, VERIFY, or HOLD pill — the same verdict language used after a live check.',
    anchor: '[data-tour="overview-next-transport"]',
    route: '/',
    optional: true,
  },
  {
    id: 'overview-upcoming',
    section: 'overview',
    title: 'Upcoming permitted routes',
    body: 'Upcoming routes list the demo set with verdict pills. Open one when you want to review that corridor on the map.',
    anchor: '[data-tour="overview-upcoming-routes"]',
    route: '/',
    optional: true,
  },
  {
    id: 'overview-feeds',
    section: 'overview',
    title: 'What a live check uses',
    body: 'Live checks compare your GPX and vehicle sizes to Autobahn GmbH and MIA DATEX feeds — roadworks, closures, and warnings on the permitted line.',
    anchor: '[data-tour="overview-workflow"]',
    route: '/',
    optional: true,
  },

  // ── Route check (end to end) ──────────────────────────────────────────
  {
    id: 'route-nav',
    section: 'route-check',
    title: 'Open Route checks',
    body: 'This is where you import a permit GPX, confirm vehicle sizes, and get a READY / VERIFY / HOLD verdict.',
    anchor: '[data-tour="nav-route-checks"]',
    route: '/route-checks',
  },
  {
    id: 'route-import',
    section: 'route-check',
    title: 'Import the permitted route',
    body: 'Upload your VEMAGS GPX, or use a sample permit. Samples are the fastest way to see a full check.',
    anchor: '[data-tour="route-step-import"]',
    route: '/route-checks',
  },
  {
    id: 'route-show-samples',
    section: 'route-check',
    title: 'Show sample permits',
    body: 'Open the sample list. Live samples hit real feeds; Scenario mode simulates READY, VERIFY, and HOLD without live data.',
    anchor: '[data-tour="route-sample-toggle"]',
    route: '/route-checks',
    advance: { type: 'click' },
    doItLabel: 'Show samples for me',
  },
  {
    id: 'route-pick-sample',
    section: 'route-check',
    title: 'Pick a sample permit',
    body: 'Choose Hamburg → Hannover (A7). It expects VERIFY and prefills vehicle sizes from the permit.',
    anchor: '[data-tour="route-permit-hamburg-hannover"]',
    route: '/route-checks',
    advance: { type: 'present', selector: '[data-tour="route-step-vehicle"]' },
    doItLabel: 'Pick Hamburg → Hannover',
    doItSelector: '[data-tour="route-permit-hamburg-hannover"]',
  },
  {
    id: 'route-vehicle',
    section: 'route-check',
    title: 'Check the dimensions',
    body: 'Width, height, length, and weight came from the sample permit. Adjust only if the approved vehicle differs, then set departure time.',
    anchor: '[data-tour="route-step-vehicle"]',
    route: '/route-checks',
  },
  {
    id: 'route-run',
    section: 'route-check',
    title: 'Run the check',
    body: 'Check route compares the GPX and vehicle to live Autobahn conditions. Wait for the verdict banner.',
    anchor: '[data-tour="route-check-submit"]',
    route: '/route-checks',
    advance: { type: 'present', selector: '[data-tour="route-verdict-banner"]' },
    doItLabel: 'Run check for me',
  },
  {
    id: 'route-verdict',
    section: 'route-check',
    title: 'Read the verdict',
    body: 'READY: nothing on the live feeds blocks this route. VERIFY: something needs on-site or dispatcher confirmation before departure. HOLD: a confirmed block — do not depart.',
    anchor: '[data-tour="route-verdict-banner"]',
    route: '/route-checks',
  },
  {
    id: 'route-cta',
    section: 'route-check',
    title: 'Take the verdict action',
    body: 'The button matches the verdict: Proceed with departure (READY), Verify before departure (opens an on-site request), or Take action (HOLD options).',
    anchor: '[data-tour="route-verdict-cta"]',
    route: '/route-checks',
    optional: true,
  },
  {
    id: 'route-evidence',
    section: 'route-check',
    title: 'Evidence on the route',
    body: 'Evidence lists closures, roadworks, and warnings that touched your GPX. Use it to decide what to verify or hold for.',
    anchor: '[data-tour="route-evidence"]',
    route: '/route-checks',
    optional: true,
  },
  {
    id: 'route-confirm',
    section: 'route-check',
    title: 'Confirm on site',
    body: 'VERIFY items can be confirmed on site with a confirmer name. HOLD items cannot be acknowledged away — change the route or wait out the restriction.',
    anchor: '[data-tour="route-confirm-bar"]',
    route: '/route-checks',
    optional: true,
  },
  {
    id: 'route-export',
    section: 'route-check',
    title: 'Export the check',
    body: 'Export PDF or CSV for the shift log. Re-check refreshes live feeds without re-entering the permit.',
    anchor: '[data-tour="route-result-actions"]',
    route: '/route-checks',
  },
  {
    id: 'route-save-job',
    section: 'route-check',
    title: 'Save as a job',
    body: 'Save as job keeps the permit, vehicle, departure, and re-check interval in your account so monitoring can continue while this tab stays open.',
    anchor: '[data-tour="route-result-actions"]',
    route: '/route-checks',
    advance: { type: 'present', selector: '[data-tour="route-save-job"]' },
    doItLabel: 'Open save form',
    doItSelector: '[data-tour="route-save-job-btn"]',
  },
  {
    id: 'route-save-submit',
    section: 'route-check',
    title: 'Save the job',
    body: 'Set the re-check interval, then Save job. Monitoring only runs while this browser tab is open.',
    anchor: '[data-tour="route-save-job"]',
    route: '/route-checks',
    advance: { type: 'click' },
    doItLabel: 'Save job for me',
    doItSelector: '[data-tour="route-save-job-submit"]',
  },

  // ── Jobs ──────────────────────────────────────────────────────────────
  {
    id: 'jobs-banner',
    section: 'jobs',
    title: 'Jobs stay monitored here',
    body: 'Saved jobs re-check on an interval while this tab is open. Allow browser notifications if you want desktop alerts for HOLD/VERIFY changes.',
    anchor: '[data-tour="jobs-monitor-banner"]',
    route: '/jobs',
  },
  {
    id: 'jobs-prefs',
    section: 'jobs',
    title: 'Default monitoring interval',
    body: 'Set the default re-check interval and when to escalate unacknowledged HOLD or VERIFY alerts.',
    anchor: '[data-tour="jobs-prefs"]',
    route: '/jobs',
  },
  {
    id: 'jobs-card',
    section: 'jobs',
    title: 'A saved job card',
    body: 'Each card shows monitoring status, last check, and actions. Re-run check opens the full result again.',
    anchor: '[data-tour="jobs-card"]',
    route: '/jobs',
    optional: true,
  },
  {
    id: 'jobs-edit',
    section: 'jobs',
    title: 'Edit the re-check interval',
    body: 'Edit opens the job dialog so you can change the re-check interval without deleting the job.',
    anchor: '[data-tour="jobs-edit"]',
    route: '/jobs',
    optional: true,
  },

  // ── Alerts & history ──────────────────────────────────────────────────
  {
    id: 'alerts-filters',
    section: 'alerts',
    title: 'Filter alerts',
    body: 'Filter by All, Hold, Verify, or Resolved, and optionally by permitted route.',
    anchor: '[data-tour="activity-severity"]',
    route: '/activity',
  },
  {
    id: 'alerts-list',
    section: 'alerts',
    title: 'Alerts by route',
    body: 'Alerts group by route. Mark resolved when you have handled a HOLD or VERIFY change. If the list is empty, use Load demo history.',
    anchor: '[data-tour="activity-alerts"]',
    route: '/activity',
  },
  {
    id: 'alerts-history',
    section: 'alerts',
    title: 'Check history',
    body: 'Check history by route keeps every completed check for this account — verdict, time, and source.',
    anchor: '[data-tour="activity-history"]',
    route: '/activity',
  },

  // ── Corridor monitor ──────────────────────────────────────────────────
  {
    id: 'corridor-scope',
    section: 'corridor',
    title: 'Scope and basemap',
    body: 'Switch Germany or Bavaria scope, and Road or Contrast basemap, without leaving the live feed.',
    anchor: '[data-tour="corridor-tabs"]',
    route: '/map-explorer',
  },
  {
    id: 'corridor-search',
    section: 'corridor',
    title: 'Search road or place',
    body: 'Search filters the event list by road name or place so you can find a corridor quickly.',
    anchor: '[data-tour="corridor-search"]',
    route: '/map-explorer',
  },
  {
    id: 'corridor-filters',
    section: 'corridor',
    title: 'Closures, roadworks, warnings',
    body: 'Tap a counter to show only that signal type. Counts reflect the current scope, layers, and search.',
    anchor: '[data-tour="corridor-filters"]',
    route: '/map-explorer',
  },
  {
    id: 'corridor-events',
    section: 'corridor',
    title: 'Event list and map',
    body: 'Click an event to focus it on the map. Layers and Refresh data control what is drawn; Fit Germany resets the view.',
    anchor: '[data-tour="corridor-events"]',
    route: '/map-explorer',
  },
  {
    id: 'corridor-layers',
    section: 'corridor',
    title: 'Layers and refresh',
    body: 'Open Layers to toggle signal groups. Refresh pulls the latest Autobahn GmbH feed; Fit Germany reframes the map.',
    anchor: '[data-tour="corridor-layers"]',
    route: '/map-explorer',
  },

  // ── Settings ──────────────────────────────────────────────────────────
  {
    id: 'settings-tabs',
    section: 'settings',
    title: 'Settings tabs',
    body: 'Organisation profile, Notifications, Monitoring, and Data sources. Changes save to your Demo account only.',
    anchor: '[data-tour="settings-tabs"]',
    route: '/settings',
  },
  {
    id: 'settings-save',
    section: 'settings',
    title: 'Save changes',
    body: 'Edit the organisation profile, then Save changes. Nothing here affects other login accounts.',
    anchor: '[data-tour="settings-save"]',
    route: '/settings',
  },

  // ── Search & Switch user ──────────────────────────────────────────────
  {
    id: 'chrome-search',
    section: 'chrome',
    title: 'Search the workspace',
    body: 'Search permits, routes, roads, and alerts from any page. Pick a hit or press Enter for full results.',
    anchor: '[data-tour="chrome-search"]',
    route: '/',
  },
  {
    id: 'chrome-notifications',
    section: 'chrome',
    title: 'Notifications bell',
    body: 'Recent HOLD and VERIFY alerts appear here. Open Alerts & history for the full list.',
    anchor: '[data-tour="chrome-notifications"]',
    route: '/',
  },
  {
    id: 'chrome-switch',
    section: 'chrome',
    title: 'Switch user',
    body: 'Switch user returns to the login list. This tour only appears for the Demo account — other users never see it.',
    anchor: '[data-tour="switch-user"]',
    route: '/',
  },

  // ── Data partners (coming later) ──────────────────────────────────────
  {
    id: 'data-partners',
    section: 'data-partners',
    title: 'Data partners (coming later)',
    body: 'This page is planned only — Mobility Data Space partner feeds are not connected yet. Live checks already use Autobahn GmbH and MIA DATEX.',
    anchor: '[data-tour="data-partners-heading"]',
    route: '/data-partners',
  },
]

export type DemoTourProgress = {
  /** Welcome was dismissed ("Not now") or the user started at least once. */
  welcomeSeen: boolean
  /** Section ids the user finished (Skip guide or last step Next). */
  completedSections: TourSectionId[]
  /** Full tour finished or user chose Not now after seeing welcome. */
  tourDismissed: boolean
}

export const EMPTY_TOUR_PROGRESS: DemoTourProgress = {
  welcomeSeen: false,
  completedSections: [],
  tourDismissed: false,
}

type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

function getStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

export function readTourProgress(storage?: StorageLike | null): DemoTourProgress {
  const store = storage === undefined ? getStorage() : storage
  if (!store) return { ...EMPTY_TOUR_PROGRESS }
  try {
    const raw = store.getItem(DEMO_TOUR_STORAGE_KEY)
    if (!raw) return { ...EMPTY_TOUR_PROGRESS }
    const parsed = JSON.parse(raw) as Partial<DemoTourProgress>
    const completed = Array.isArray(parsed.completedSections)
      ? parsed.completedSections.filter((id): id is TourSectionId =>
          TOUR_SECTION_ORDER.includes(id as TourSectionId),
        )
      : []
    return {
      welcomeSeen: Boolean(parsed.welcomeSeen),
      completedSections: completed,
      tourDismissed: Boolean(parsed.tourDismissed),
    }
  } catch {
    return { ...EMPTY_TOUR_PROGRESS }
  }
}

export function writeTourProgress(
  progress: DemoTourProgress,
  storage?: StorageLike | null,
): void {
  const store = storage === undefined ? getStorage() : storage
  if (!store) return
  try {
    store.setItem(DEMO_TOUR_STORAGE_KEY, JSON.stringify(progress))
  } catch {
    // Private mode — tour still works for the session.
  }
}

export function markSectionComplete(
  section: TourSectionId,
  storage?: StorageLike | null,
): DemoTourProgress {
  const current = readTourProgress(storage)
  if (!current.completedSections.includes(section)) {
    current.completedSections = [...current.completedSections, section]
  }
  writeTourProgress(current, storage)
  return current
}

export function resetTourProgress(storage?: StorageLike | null): DemoTourProgress {
  const next = { ...EMPTY_TOUR_PROGRESS, welcomeSeen: true, tourDismissed: false }
  writeTourProgress(next, storage)
  return next
}

export function dismissWelcome(storage?: StorageLike | null): DemoTourProgress {
  const current = readTourProgress(storage)
  const next = { ...current, welcomeSeen: true, tourDismissed: true }
  writeTourProgress(next, storage)
  return next
}

export function acknowledgeWelcome(storage?: StorageLike | null): DemoTourProgress {
  const current = readTourProgress(storage)
  const next = { ...current, welcomeSeen: true }
  writeTourProgress(next, storage)
  return next
}

export function stepsForSection(section: TourSectionId): TourStepDef[] {
  return TOUR_STEPS.filter(step => step.section === section)
}

export function sectionLabel(section: TourSectionId): string {
  return TOUR_SECTIONS.find(item => item.id === section)?.label ?? section
}

/** Non-Demo ids used in tests — every APP_USERS id except demo. */
export function nonDemoUserIds(): string[] {
  return APP_USERS.map(user => user.id).filter(id => id !== DEMO_TOUR_USER_ID)
}
