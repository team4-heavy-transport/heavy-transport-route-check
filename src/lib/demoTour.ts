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

export type TourSetupFallback = {
  body: string
  ctaLabel: string
  ctaSection: TourSectionId
}

export type TourStepDef = {
  id: string
  section: TourSectionId
  title: string
  body: string
  /** Narrow-viewport body (≤720px); falls back to `body` when omitted. */
  bodyNarrow?: string
  /** Prefer [data-tour="…"]; falls back to a centred card if missing. */
  anchor?: string
  /** Navigate here before showing the step (if not already there). */
  route?: string
  /** Skip when the anchor never appears (timeout). */
  optional?: boolean
  /**
   * When the anchor is missing, show this tip instead of skipping/hanging
   * (e.g. Jobs guide with no saved jobs yet).
   */
  setupFallback?: TourSetupFallback
  advance?: TourAdvance
  /** Label for a button that performs the interactive action for the user. */
  doItLabel?: string
  /** Selector to click for "Do it for me" (defaults to anchor). */
  doItSelector?: string
  /**
   * Included in single-section guides only — omitted from the full tour
   * (e.g. Route check closing confirmation before Jobs).
   */
  singleFlowOnly?: boolean
  /** Last-step CTA that starts another guide (single-flow closers). */
  nextFlowCta?: { label: string; section: TourSectionId }
}

/** One-line descriptions for the Guide flow picker. */
export const TOUR_FLOW_DESCRIPTIONS: Record<'full' | TourSectionId, string> = {
  full: 'Walk every guide in order — Overview through Data partners.',
  overview:
    'Walk the 3-step strip, Check new route, filters, the route block, and full-size map.',
  'route-check':
    'Pick a sample permit, run a live check, open the full-size map, and save as a job.',
  jobs: 'Review monitored jobs, intervals, and edit a saved job card.',
  alerts: 'Filter HOLD/VERIFY alerts and skim check history by route.',
  corridor: 'Scope the live map, search a road, and open layers.',
  settings: 'Open settings tabs and save organisation profile changes.',
  chrome: 'Use workspace search, the alerts bell, and Switch user.',
  'data-partners': 'See the planned partners page (feeds not connected yet).',
}

export type TourFlowId = 'full' | TourSectionId

export type TourFlowEntry = {
  id: TourFlowId
  label: string
  description: string
  stepCount: number
}

/** Full tour step list — chained in this order. */
export const TOUR_STEPS: readonly TourStepDef[] = [
  // ── Overview ──────────────────────────────────────────────────────────
  {
    id: 'overview-workflow',
    section: 'overview',
    title: 'The 3-step strip',
    body: 'Import the permit, check the route, then monitor until departure — the same workflow for every transport.',
    anchor: '[data-tour="overview-workflow"]',
    route: '/',
  },
  {
    id: 'overview-check-new',
    section: 'overview',
    title: 'Check new route',
    body: 'Start a live route check from here. Upload a VEMAGS GPX or pick a sample permit on the next page.',
    anchor: '[data-tour="overview-check-new"]',
    route: '/',
  },
  {
    id: 'overview-filters',
    section: 'overview',
    title: 'Route list and filters',
    body: 'One list of your routes (or labelled examples when the account is empty). Filter by status, date added, and last checked — the same filters drive the map block below.',
    anchor: '[data-tour="overview-filters"]',
    route: '/',
  },
  {
    id: 'overview-route-block',
    section: 'overview',
    title: 'Route block',
    body: 'Cards and the map share the filters. Use Show on a card for vehicle, permit, and blocking items; Show all expands every card.',
    anchor: '[data-tour="overview-route-block-heading"]',
    route: '/',
  },
  {
    id: 'overview-show-toggle',
    section: 'overview',
    title: 'Show and Show all',
    body: 'Show expands one route’s details. Show all / Hide all toggles every card so you can compare or focus.',
    anchor: '[data-tour="overview-show-all"]',
    route: '/',
  },
  {
    id: 'overview-fullmap',
    section: 'overview',
    title: 'Full-size map',
    body: 'Open the full-size map for a larger view of all filtered routes. Esc or Minimise returns you here.',
    anchor: '[data-tour="overview-fullmap-open"]',
    route: '/',
    advance: { type: 'present', selector: '[data-tour="overview-fullmap"]' },
    doItLabel: 'Open full-size map',
    doItSelector: '[data-tour="overview-fullmap-open"]',
  },
  {
    id: 'overview-fullmap-modes',
    section: 'overview',
    title: 'All routes or single route',
    body: 'Switch between All routes (cards + map) and Single route (vehicle, alerts by status, last checked, and that track only).',
    anchor: '[data-tour="overview-fullmap-modes"]',
    route: '/',
  },
  {
    id: 'overview-fullmap-minimise',
    section: 'overview',
    title: 'Minimise',
    body: 'Minimise (or Esc) closes the full-size map and restores your place on Overview.',
    anchor: '[data-tour="overview-fullmap-minimise"]',
    route: '/',
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
    anchor: '[data-tour="route-import-heading"]',
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
    body: 'Choose Hamburg → Hannover (A7). Usually VERIFY — live data can change it. Vehicle sizes are prefilled from the permit.',
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
    anchor: '[data-tour="route-vehicle-heading"]',
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
    advance: {
      type: 'present',
      selector: '.action-sheet-overlay[role="dialog"], .dialog-overlay[role="dialog"]',
    },
    doItLabel: 'Open the action for me',
    doItSelector: '[data-tour="route-verdict-cta"]',
  },
  {
    id: 'route-cta-panel',
    section: 'route-check',
    title: 'Review and close the panel',
    body: 'This sheet or dialog lists what you can do next. Pick an option or Cancel to close it — the tour pauses while it is open, then continues here.',
    anchor: '.action-sheet-overlay[role="dialog"], .dialog-overlay[role="dialog"], .action-sheet, .dialog-content',
    route: '/route-checks',
    optional: true,
  },
  {
    id: 'route-evidence',
    section: 'route-check',
    title: 'Evidence on the route',
    body: 'Evidence lists closures, roadworks, and warnings that touched your GPX. Use it to decide what to verify or hold for.',
    anchor: '[data-tour="route-evidence-heading"]',
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
    id: 'route-open-fullmap',
    section: 'route-check',
    title: 'Open in full-size map',
    body: 'Jump to Overview’s full-size map focused on this route — useful when you want the larger map after a check.',
    anchor: '[data-tour="route-open-fullmap"]',
    route: '/route-checks',
    optional: true,
  },
  {
    id: 'route-save-job',
    section: 'route-check',
    title: 'Save as a job',
    body: 'Save as job keeps the permit, vehicle, departure, and re-check interval in your account so monitoring can continue while this tab stays open.',
    anchor: '[data-tour="route-save-job-btn"]',
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
    anchor: '[data-tour="route-save-job-submit"]',
    route: '/route-checks',
    advance: { type: 'click' },
    doItLabel: 'Save job for me',
    doItSelector: '[data-tour="route-save-job-submit"]',
  },
  {
    id: 'route-job-saved',
    section: 'route-check',
    title: 'Job saved',
    body: 'Your check is now a job. Open Jobs to see it being monitored.',
    route: '/jobs',
    singleFlowOnly: true,
    nextFlowCta: { label: 'Open the Jobs guide', section: 'jobs' },
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
    setupFallback: {
      body: 'No saved jobs in this account yet. Run the Route check guide first to pick a sample permit, get a verdict, and save it as a job — then come back here.',
      ctaLabel: 'Run the Route check guide first',
      ctaSection: 'route-check',
    },
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
    anchor: '[data-tour="activity-alerts-heading"]',
    route: '/activity',
  },
  {
    id: 'alerts-history',
    section: 'alerts',
    title: 'Check history',
    body: 'Check history by route keeps every completed check for this account — verdict, time, and source.',
    anchor: '[data-tour="activity-history-heading"]',
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
    bodyNarrow: 'Tap your initials at the top to switch user. This tour only appears for the Demo account — other users never see it.',
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

/** Full tour step list — excludes single-flow-only closing steps. */
export function stepsForFullTour(): TourStepDef[] {
  return TOUR_STEPS.filter(step => !step.singleFlowOnly)
}

/** Picker entries: Full tour first, then each section guide in order. */
export function tourFlowEntries(): TourFlowEntry[] {
  return [
    {
      id: 'full',
      label: 'Full tour',
      description: TOUR_FLOW_DESCRIPTIONS.full,
      stepCount: stepsForFullTour().length,
    },
    ...TOUR_SECTIONS.map(section => ({
      id: section.id as TourFlowId,
      label: section.label,
      description: TOUR_FLOW_DESCRIPTIONS[section.id],
      stepCount: stepsForSection(section.id).length,
    })),
  ]
}

export function isSectionDone(
  section: TourSectionId,
  progress: DemoTourProgress,
): boolean {
  return progress.completedSections.includes(section)
}

export function isFullTourDone(progress: DemoTourProgress): boolean {
  return TOUR_SECTION_ORDER.every(id => progress.completedSections.includes(id))
}

export function isFlowDone(flowId: TourFlowId, progress: DemoTourProgress): boolean {
  if (flowId === 'full') return isFullTourDone(progress)
  return isSectionDone(flowId, progress)
}

/** Accessible name for a picker entry (includes step count and done state). */
export function flowAccessibleName(entry: TourFlowEntry, done: boolean): string {
  const steps = `${entry.stepCount} step${entry.stepCount === 1 ? '' : 's'}`
  return done ? `${entry.label}, ${steps}, done` : `${entry.label}, ${steps}`
}

/** Next incomplete section for picker focus; `full` when everything is done. */
export function nextIncompleteFlowId(progress: DemoTourProgress): TourFlowId {
  for (const id of TOUR_SECTION_ORDER) {
    if (!progress.completedSections.includes(id)) return id
  }
  return 'full'
}

export function sectionLabel(section: TourSectionId): string {
  return TOUR_SECTIONS.find(item => item.id === section)?.label ?? section
}

/** Last step id in a section (used to mark completion when that step is left). */
export function lastStepIdForSection(section: TourSectionId): string | undefined {
  const steps = stepsForSection(section)
  return steps[steps.length - 1]?.id
}

/**
 * Sections whose last step has been passed when moving from `fromIndex` to `toIndex`
 * (or finishing when `toIndex >= steps.length`).
 */
export function sectionsCompletedByAdvance(
  steps: readonly TourStepDef[],
  fromIndex: number,
  toIndex: number,
): TourSectionId[] {
  const completed: TourSectionId[] = []
  if (fromIndex < 0 || fromIndex >= steps.length) return completed
  const from = steps[fromIndex]
  const to = toIndex < steps.length ? steps[toIndex] : null
  if (!to || to.section !== from.section) {
    // Leaving the section (or finishing the guide) — mark it done.
    const sectionSteps = steps.filter(s => s.section === from.section)
    const lastInRun = sectionSteps[sectionSteps.length - 1]
    if (lastInRun && from.id === lastInRun.id) {
      completed.push(from.section)
    }
  }
  return completed
}

/**
 * Simulate walking every step of a step list and collect completed sections.
 * Used by unit tests and to keep Guide menu progress honest during a full tour.
 */
export function completedSectionsAfterFullWalk(
  steps: readonly TourStepDef[] = stepsForFullTour(),
): TourSectionId[] {
  const done = new Set<TourSectionId>()
  for (let i = 0; i < steps.length; i++) {
    for (const section of sectionsCompletedByAdvance(steps, i, i + 1)) {
      done.add(section)
    }
  }
  return TOUR_SECTION_ORDER.filter(id => done.has(id))
}

/** Page/section containers that must not be used as tour anchors (too tall). */
export const TALL_TOUR_ANCHOR_SELECTORS = [
  '[data-tour="overview-routes"]',
  '[data-tour="overview-route-block"]',
  '[data-tour="overview-fullmap"]',
  '[data-tour="overview-route-cards"]',
  '[data-tour="route-step-import"]',
  '[data-tour="route-step-vehicle"]',
  '[data-tour="route-evidence"]',
  '[data-tour="route-save-job"]',
  '[data-tour="activity-alerts"]',
  '[data-tour="activity-history"]',
] as const

/** Non-Demo ids used in tests — every APP_USERS id except demo. */
export function nonDemoUserIds(): string[] {
  return APP_USERS.map(user => user.id).filter(id => id !== DEMO_TOUR_USER_ID)
}
