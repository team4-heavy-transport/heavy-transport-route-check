import type { RouteEvidence, RouteVerdict } from '../data/routeChecks'
import type { CheckHistoryRecord, MonitoringAlert } from '../context/RouteMonitoringContext'
import type { SavedJob, VehicleDims } from './jobs'
import type { TestPermit } from './routeCheck'
import { parseGpxTrack, type LatLng } from './gpxTrack'

export type OverviewRouteSource = 'job' | 'check' | 'example'

export type OverviewSummarySeverity = 'HOLD' | 'VERIFY' | 'READY'

export type OverviewSummaryItem = {
  id: string
  label: string
  severity: OverviewSummarySeverity
  /** When >1, identical rows were collapsed — render as "×N" after the label. */
  count?: number
}

export type OverviewRoute = {
  id: string
  /** Route lead title: `origin → destination` or job name when ends look like coordinates. */
  title: string
  origin: string
  destination: string
  permitNumber: string
  status: RouteVerdict | null
  addedAt: string
  lastCheckedAt: string | null
  plannedDeparture: string | null
  vehicle: VehicleDims | null
  latestEvidence: RouteEvidence[]
  summaryItems: OverviewSummaryItem[]
  /** When no itemised rows, show this line in the route's severity colour. */
  summaryFallback: OverviewSummaryItem | null
  alerts: MonitoringAlert[]
  /** Check history ids merged into this route (for alert matching). */
  checkIds: string[]
  /** Parsed track points, or null when geometry is unknown / still URL-backed. */
  geometry: LatLng[] | null
  /** Sample/test permit GPX URL when geometry must be loaded async. */
  gpxFile: string | null
  source: OverviewRouteSource
  jobId?: string
  permitId?: string
  routeLabel?: string
}

export type OverviewStatusFilter = RouteVerdict

export type OverviewAddedPreset = 'any' | 'today' | '7d' | '30d'
export type OverviewCheckedPreset = 'any' | '24h' | '7d' | 'older7d'

export type OverviewFilters = {
  /** Empty array = All (no status filter). */
  statuses: OverviewStatusFilter[]
  added: OverviewAddedPreset
  checked: OverviewCheckedPreset
}

export const DEFAULT_OVERVIEW_FILTERS: OverviewFilters = {
  statuses: [],
  added: 'any',
  checked: 'any',
}

export const SUMMARY_ITEM_CAP = 6

const STATUS_ORDER: Record<OverviewSummarySeverity, number> = {
  HOLD: 0,
  VERIFY: 1,
  READY: 2,
}

const MS_DAY = 24 * 60 * 60 * 1000

/** Loose match for numeric lat/lon pairs shown as "53.5511, 9.9937". */
const COORD_PAIR_RE =
  /^\s*-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?\s*$/

export function looksLikeCoordinates(value: string | null | undefined): boolean {
  if (!value) return false
  return COORD_PAIR_RE.test(value.trim())
}

/**
 * Prefer a human corridor/job name when origin/destination look like raw coordinates.
 */
export function routeDisplayTitle(opts: {
  origin?: string | null
  destination?: string | null
  jobName?: string | null
  corridor?: string | null
  routeLabel?: string | null
  permitName?: string | null
}): string {
  const origin = (opts.origin || '').trim()
  const destination = (opts.destination || '').trim()
  const coords = looksLikeCoordinates(origin) || looksLikeCoordinates(destination)
  if (coords) {
    const fallback =
      (opts.jobName || '').trim() ||
      (opts.corridor || '').trim() ||
      (opts.routeLabel || '').trim() ||
      (opts.permitName || '').trim()
    if (fallback) return fallback
  }
  if (origin && destination) return `${origin} → ${destination}`
  if (origin || destination) return origin || destination
  return (
    (opts.jobName || '').trim() ||
    (opts.routeLabel || '').trim() ||
    (opts.permitName || '').trim() ||
    'Route'
  )
}

export function evidenceToSummarySeverity(item: Pick<RouteEvidence, 'state'>): OverviewSummarySeverity {
  if (item.state === 'danger' || item.state === 'conflict') return 'HOLD'
  if (item.state === 'warning') return 'VERIFY'
  return 'READY'
}

/** HOLD → VERIFY → READY order for blocking / evidence summary lists. */
export function sortSummaryBySeverity<T extends { severity: OverviewSummarySeverity }>(items: T[]): T[] {
  return [...items].sort((a, b) => STATUS_ORDER[a.severity] - STATUS_ORDER[b.severity])
}

/** Normalise summary/alert text for duplicate matching (whitespace + case). */
export function normaliseSummaryKey(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function buildSummaryItems(evidence: RouteEvidence[] | undefined | null): OverviewSummaryItem[] {
  const items = (evidence || []).map(item => ({
    id: item.id,
    label: (item.title || item.detail || 'Evidence item').trim() || 'Evidence item',
    severity: evidenceToSummarySeverity(item),
  }))
  return collapseSummaryDuplicates(sortSummaryBySeverity(items))
}

/**
 * Collapse identical summary rows (same severity + normalised label) into one row with count.
 * Order follows first occurrence after severity sort.
 */
export function collapseSummaryDuplicates(items: OverviewSummaryItem[]): OverviewSummaryItem[] {
  const order: string[] = []
  const byKey = new Map<string, OverviewSummaryItem>()
  for (const item of items) {
    if (item.id === 'summary-more') continue
    const key = `${item.severity}:${normaliseSummaryKey(item.label)}`
    const existing = byKey.get(key)
    if (existing) {
      existing.count = (existing.count || 1) + (item.count || 1)
      continue
    }
    byKey.set(key, { ...item, count: item.count || 1 })
    order.push(key)
  }
  return order.map(key => {
    const row = byKey.get(key)!
    return row.count && row.count > 1 ? row : { ...row, count: undefined }
  })
}

/**
 * Collapse alerts that share the same change + detail (normalised) into one row with count
 * and the newest timestamp kept as the representative.
 */
export function collapseDuplicateAlerts(alerts: MonitoringAlert[]): Array<MonitoringAlert & { count: number }> {
  const order: string[] = []
  const byKey = new Map<string, MonitoringAlert & { count: number }>()
  for (const alert of alerts) {
    const change = normaliseSummaryKey(alert.change)
    const detail = normaliseSummaryKey(alert.detail)
    const key = `${change}::${detail}`
    const existing = byKey.get(key)
    if (existing) {
      existing.count += 1
      const nextTs = Date.parse(alert.runAt || alert.time)
      const prevTs = Date.parse(existing.runAt || existing.time)
      if (Number.isFinite(nextTs) && (!Number.isFinite(prevTs) || nextTs > prevTs)) {
        Object.assign(existing, alert, { count: existing.count })
      }
      continue
    }
    byKey.set(key, { ...alert, count: 1 })
    order.push(key)
  }
  return order.map(key => byKey.get(key)!)
}

/**
 * Build expanded-card summary rows from evidence when present, else confirmOnSite
 * (+ linked alerts). Identical labels collapse to "×N"; then cap at SUMMARY_ITEM_CAP
 * with a "+N more" tail. For HOLD/VERIFY with nothing to itemise, returns `fallback`.
 */
export function buildRouteSummary(opts: {
  evidence?: RouteEvidence[] | null
  confirmOnSite?: string[] | null
  summary?: string | null
  title?: string | null
  impact?: string | null
  verdict?: RouteVerdict | null
  alerts?: MonitoringAlert[] | null
}): { items: OverviewSummaryItem[]; fallback: OverviewSummaryItem | null } {
  const evidence = opts.evidence || []
  const alerts = opts.alerts || []
  const verdict = opts.verdict ?? null
  const confirmSeverity: OverviewSummarySeverity =
    verdict === 'HOLD' ? 'HOLD' : verdict === 'VERIFY' ? 'VERIFY' : 'VERIFY'

  let items: OverviewSummaryItem[] = []

  if (evidence.length > 0) {
    items = buildSummaryItems(evidence)
  } else {
    const confirmItems = (opts.confirmOnSite || [])
      .map((label, index) => ({
        id: `confirm-${index}`,
        label: label.trim() || 'Confirm on site',
        severity: confirmSeverity,
      }))
      .filter(item => item.label)
    items = collapseSummaryDuplicates(confirmItems)
  }

  const alertItems: OverviewSummaryItem[] = alerts.map(alert => ({
    id: `alert-${alert.id}`,
    label: (alert.change || alert.detail || 'Alert').trim() || 'Alert',
    severity:
      alert.status === 'Resolved'
        ? 'READY'
        : alert.severity === 'HOLD'
          ? 'HOLD'
          : alert.severity === 'VERIFY'
            ? 'VERIFY'
            : 'READY',
  }))

  // Merge alert lines into evidence/confirm rows; bump count when labels match.
  const seen = new Map<string, OverviewSummaryItem>()
  for (const item of items) {
    seen.set(`${item.severity}:${normaliseSummaryKey(item.label)}`, item)
  }
  for (const alertItem of alertItems) {
    const key = `${alertItem.severity}:${normaliseSummaryKey(alertItem.label)}`
    const existing = seen.get(key)
    if (existing) {
      existing.count = (existing.count || 1) + 1
      continue
    }
    const row = { ...alertItem, count: 1 }
    seen.set(key, row)
    items.push(row)
  }

  items = collapseSummaryDuplicates(sortSummaryBySeverity(items))

  if (items.length > SUMMARY_ITEM_CAP) {
    const extra = items.length - SUMMARY_ITEM_CAP
    items = [
      ...items.slice(0, SUMMARY_ITEM_CAP),
      {
        id: 'summary-more',
        label: `+${extra} more`,
        severity: items[SUMMARY_ITEM_CAP]?.severity ?? 'READY',
      },
    ]
  }

  if (items.length > 0) {
    return { items, fallback: null }
  }

  if (verdict === 'HOLD' || verdict === 'VERIFY') {
    const label =
      (opts.summary || '').trim() ||
      (opts.impact || '').trim() ||
      (opts.title || '').trim() ||
      (verdict === 'HOLD' ? 'Hold departure' : 'Verify evidence')
    return {
      items: [],
      fallback: { id: 'summary-fallback', label, severity: verdict },
    }
  }

  return { items: [], fallback: null }
}

export function overviewRouteKeyFromCheck(record: Pick<CheckHistoryRecord, 'jobId' | 'permitNumber' | 'routeLabel'>): string {
  if (record.jobId) return record.jobId
  const permit = (record.permitNumber || '').trim()
  if (permit) return permit
  return (record.routeLabel || '').trim() || 'check'
}

export function overviewRouteIdForResult(opts: {
  jobId?: string | null
  permitNumber?: string | null
  routeLabel?: string | null
}): string {
  if (opts.jobId) return opts.jobId
  const permit = (opts.permitNumber || '').trim()
  if (permit) return permit
  return (opts.routeLabel || '').trim() || 'check'
}

function parseJobGeometry(gpxContent: string | undefined | null): LatLng[] | null {
  if (!gpxContent || typeof gpxContent !== 'string') return null
  try {
    const points = parseGpxTrack(gpxContent)
    return points.length >= 2 ? points : null
  } catch {
    return null
  }
}

function findPermitByNumber(
  permits: TestPermit[],
  permitNumber: string,
): TestPermit | undefined {
  const needle = permitNumber.trim().toLowerCase()
  if (!needle) return undefined
  return permits.find(p => p.permitNumber.trim().toLowerCase() === needle)
}

/** Case/diacritics-insensitive place string; treats "→" and "->" as separators when splitting labels. */
export function normalisePlaceKey(value: string | null | undefined): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Loose origin/destination match: exact normalised equality, or one end contains the other
 * (so "Hof A9" matches permit origin "Hof A9" or short "Hof").
 */
export function endsMatchPermit(
  origin: string | null | undefined,
  destination: string | null | undefined,
  permit: Pick<TestPermit, 'origin' | 'destination' | 'originShort' | 'destinationShort'>,
): boolean {
  const o = normalisePlaceKey(origin)
  const d = normalisePlaceKey(destination)
  if (!o || !d) return false

  const candidates: Array<[string, string]> = [
    [normalisePlaceKey(permit.origin), normalisePlaceKey(permit.destination)],
    [normalisePlaceKey(permit.originShort), normalisePlaceKey(permit.destinationShort)],
  ]

  return candidates.some(([po, pd]) => {
    if (!po || !pd) return false
    const originOk = o === po || o.includes(po) || po.includes(o)
    const destOk = d === pd || d.includes(pd) || pd.includes(d)
    return originOk && destOk
  })
}

/**
 * Resolve a catalogue permit for geometry/vehicle: prefer permitNumber, else origin+destination.
 */
export function findGeometryPermit(
  permits: TestPermit[],
  opts: {
    permitNumber?: string | null
    origin?: string | null
    destination?: string | null
    routeLabel?: string | null
  },
): TestPermit | undefined {
  const byNumber = findPermitByNumber(permits, opts.permitNumber || '')
  if (byNumber) return byNumber

  let origin = (opts.origin || '').trim()
  let destination = (opts.destination || '').trim()
  if ((!origin || !destination) && opts.routeLabel) {
    const split = splitRouteLabel(opts.routeLabel)
    origin = origin || split.origin
    destination = destination || split.destination
  }
  if (!origin || !destination) return undefined
  return permits.find(p => endsMatchPermit(origin, destination, p))
}

/**
 * Collect alerts linked to a route via check ids, job id, route id, or routeLabel.
 */
export function alertsForRoute(
  alerts: MonitoringAlert[],
  opts: {
    routeId: string
    jobId?: string
    routeLabel?: string
    checkIds?: string[]
  },
): MonitoringAlert[] {
  const checkIds = new Set(opts.checkIds || [])
  const jobId = opts.jobId
  const routeId = opts.routeId
  const label = (opts.routeLabel || '').trim().toLowerCase()

  const matched = alerts.filter(alert => {
    if (jobId && (alert.jobId === jobId || alert.routeId === jobId)) return true
    if (alert.routeId === routeId || alert.jobId === routeId) return true
    if (checkIds.has(alert.routeId) || (alert.jobId && checkIds.has(alert.jobId))) return true
    if (label && (alert.routeLabel || '').trim().toLowerCase() === label) return true
    return false
  })

  return [...matched].sort((a, b) => Date.parse(b.runAt || b.time) - Date.parse(a.runAt || a.time))
}

function exampleToRoute(permit: TestPermit): OverviewRoute {
  return {
    id: permit.permitNumber || permit.id,
    title: `${permit.originShort} → ${permit.destinationShort}`,
    origin: permit.origin,
    destination: permit.destination,
    permitNumber: permit.permitNumber,
    status: permit.expectedVerdict ?? null,
    addedAt: permit.validFrom || new Date(0).toISOString(),
    lastCheckedAt: null,
    plannedDeparture: null,
    vehicle: permit.vehicle,
    latestEvidence: [],
    summaryItems: [],
    summaryFallback: null,
    alerts: [],
    checkIds: [],
    geometry: null,
    gpxFile: permit.gpxFile,
    source: 'example',
    permitId: permit.id,
    routeLabel: `${permit.originShort} → ${permit.destinationShort}`,
  }
}

function splitRouteLabel(label: string | undefined | null): { origin: string; destination: string } {
  const parts = (label || '').split(/\s*(?:→|->)\s*/)
  return {
    origin: parts[0]?.trim() || '',
    destination: parts[1]?.trim() || '',
  }
}

/**
 * Attach a check without jobId to the most recently checked job sharing the same
 * permitNumber. Separate jobs with the same permit stay separate entries.
 */
export function attachOrphanChecksToJobs(
  jobs: SavedJob[],
  history: CheckHistoryRecord[],
): { jobChecks: Map<string, CheckHistoryRecord[]>; remainingOrphans: CheckHistoryRecord[] } {
  const jobChecks = new Map<string, CheckHistoryRecord[]>()
  for (const job of jobs) {
    jobChecks.set(
      job.id,
      history.filter(h => h.jobId === job.id),
    )
  }

  const orphans = history.filter(h => !h.jobId)
  const remainingOrphans: CheckHistoryRecord[] = []

  const jobsByPermit = new Map<string, SavedJob[]>()
  for (const job of jobs) {
    const key = (job.permitNumber || '').trim().toLowerCase()
    if (!key) continue
    const list = jobsByPermit.get(key) || []
    list.push(job)
    jobsByPermit.set(key, list)
  }

  for (const record of orphans) {
    const permit = (record.permitNumber || '').trim().toLowerCase()
    const candidates = permit ? jobsByPermit.get(permit) || [] : []
    if (!candidates.length) {
      remainingOrphans.push(record)
      continue
    }
    // Most recently checked job (lastCheckedAt / last history run / updatedAt).
    const ranked = [...candidates].sort((a, b) => {
      const aChecks = jobChecks.get(a.id) || []
      const bChecks = jobChecks.get(b.id) || []
      const aLatest = Math.max(
        Date.parse(a.lastCheckedAt || '') || 0,
        ...aChecks.map(c => Date.parse(c.runAt) || 0),
        Date.parse(a.updatedAt) || 0,
      )
      const bLatest = Math.max(
        Date.parse(b.lastCheckedAt || '') || 0,
        ...bChecks.map(c => Date.parse(c.runAt) || 0),
        Date.parse(b.updatedAt) || 0,
      )
      return bLatest - aLatest
    })
    const target = ranked[0]
    const list = jobChecks.get(target.id) || []
    list.push(record)
    jobChecks.set(target.id, list)
  }

  return { jobChecks, remainingOrphans }
}

export function sortOverviewRoutes(routes: OverviewRoute[]): OverviewRoute[] {
  return [...routes].sort((a, b) => {
    const aSev = a.status ? STATUS_ORDER[a.status] : 99
    const bSev = b.status ? STATUS_ORDER[b.status] : 99
    if (aSev !== bSev) return aSev - bSev

    const aDep = Date.parse(a.plannedDeparture || '') || Number.POSITIVE_INFINITY
    const bDep = Date.parse(b.plannedDeparture || '') || Number.POSITIVE_INFINITY
    if (aDep !== bDep) return aDep - bDep

    const aChecked = Date.parse(a.lastCheckedAt || '') || 0
    const bChecked = Date.parse(b.lastCheckedAt || '') || 0
    return bChecked - aChecked
  })
}

export function buildOverviewRoutes(input: {
  jobs: SavedJob[]
  history: CheckHistoryRecord[]
  /** Sample live permits used only for the empty-account example fallback. */
  examplePermits: TestPermit[]
  /**
   * Catalogue used to resolve gpxFile / vehicle / corridor for jobs and checks.
   * Prefer live + scenario permits (excludes invalid). Falls back to examplePermits.
   */
  geometryPermits?: TestPermit[]
  alerts?: MonitoringAlert[]
}): OverviewRoute[] {
  const alerts = input.alerts || []
  const geometryPermits = input.geometryPermits ?? input.examplePermits
  const byId = new Map<string, OverviewRoute>()
  const { jobChecks, remainingOrphans } = attachOrphanChecksToJobs(input.jobs, input.history)

  // Jobs first — keyed by job id.
  for (const job of input.jobs) {
    const checks = [...(jobChecks.get(job.id) || [])].sort(
      (a, b) => Date.parse(b.runAt) - Date.parse(a.runAt),
    )
    const latest = checks[0]
    const status = latest?.verdict ?? job.lastVerdict ?? null
    const lastCheckedAt = latest?.runAt ?? job.lastCheckedAt ?? null
    const evidence = latest?.evidence || []
    const routeLabel = `${job.origin} → ${job.destination}`
    const permit = findGeometryPermit(geometryPermits, {
      permitNumber: job.permitNumber,
      origin: job.origin,
      destination: job.destination,
      routeLabel,
    })
    // Prefer parsed job GPX; fall back to permit file when content is missing or unparseable.
    const geometry = parseJobGeometry(job.gpxContent)
    const checkIds = checks.map(c => c.id)
    const routeAlerts = alertsForRoute(alerts, {
      routeId: job.id,
      jobId: job.id,
      routeLabel: job.name || routeLabel,
      checkIds,
    })
    const summary = buildRouteSummary({
      evidence,
      confirmOnSite: latest?.confirmOnSite,
      summary: latest?.summary ?? job.lastSummary,
      title: latest?.title,
      impact: latest?.impact,
      verdict: status,
      alerts: routeAlerts,
    })
    const title = routeDisplayTitle({
      origin: job.origin,
      destination: job.destination,
      jobName: job.name,
      corridor: job.corridor,
      routeLabel,
    })

    byId.set(job.id, {
      id: job.id,
      title,
      origin: job.origin,
      destination: job.destination,
      permitNumber: job.permitNumber,
      status,
      addedAt: job.createdAt,
      lastCheckedAt,
      plannedDeparture: job.plannedDeparture || null,
      vehicle: job.vehicle ?? permit?.vehicle ?? null,
      latestEvidence: evidence,
      summaryItems: summary.items,
      summaryFallback: summary.fallback,
      alerts: routeAlerts,
      checkIds,
      geometry,
      gpxFile: geometry ? null : (permit?.gpxFile ?? null),
      source: 'job',
      jobId: job.id,
      permitId: permit?.id,
      routeLabel,
    })
  }

  // Remaining history without a job — keyed by permitNumber else routeLabel.
  const orphanGroups = new Map<string, CheckHistoryRecord[]>()
  for (const record of remainingOrphans) {
    const key = overviewRouteKeyFromCheck(record)
    const list = orphanGroups.get(key) || []
    list.push(record)
    orphanGroups.set(key, list)
  }

  for (const [key, records] of orphanGroups) {
    const sorted = [...records].sort((a, b) => Date.parse(b.runAt) - Date.parse(a.runAt))
    const latest = sorted[0]
    const earliest = [...records].sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))[0]
    const evidence = latest.evidence || []
    const { origin: labelOrigin, destination: labelDestination } = splitRouteLabel(latest.routeLabel)
    const origin = labelOrigin || latest.permitName || ''
    const destination = labelDestination || ''
    const permit = findGeometryPermit(geometryPermits, {
      permitNumber: latest.permitNumber,
      origin,
      destination,
      routeLabel: latest.routeLabel,
    })
    const checkIds = records.map(r => r.id)
    const routeAlerts = alertsForRoute(alerts, {
      routeId: key,
      routeLabel: latest.routeLabel,
      checkIds,
    })
    const summary = buildRouteSummary({
      evidence,
      confirmOnSite: latest.confirmOnSite,
      summary: latest.summary,
      title: latest.title,
      impact: latest.impact,
      verdict: latest.verdict,
      alerts: routeAlerts,
    })
    const title = routeDisplayTitle({
      origin,
      destination,
      routeLabel: latest.routeLabel,
      permitName: latest.permitName,
      corridor: permit?.corridor,
    })

    byId.set(key, {
      id: key,
      title,
      origin,
      destination,
      permitNumber: latest.permitNumber || '',
      status: latest.verdict,
      addedAt: earliest.runAt,
      lastCheckedAt: latest.runAt,
      plannedDeparture: null,
      vehicle: latest.vehicle ?? permit?.vehicle ?? null,
      latestEvidence: evidence,
      summaryItems: summary.items,
      summaryFallback: summary.fallback,
      alerts: routeAlerts,
      checkIds,
      geometry: null,
      gpxFile: permit?.gpxFile ?? null,
      source: 'check',
      permitId: permit?.id,
      routeLabel: latest.routeLabel,
    })
  }

  const routes = [...byId.values()]
  if (routes.length > 0) {
    return sortOverviewRoutes(routes)
  }

  // Empty account → example permits in the same list (not the full geometry catalogue).
  return input.examplePermits.map(exampleToRoute)
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function matchesAddedPreset(addedAt: string, preset: OverviewAddedPreset, now: Date): boolean {
  if (preset === 'any') return true
  const t = Date.parse(addedAt)
  if (!Number.isFinite(t)) return false
  const startToday = startOfLocalDay(now).getTime()
  if (preset === 'today') return t >= startToday
  if (preset === '7d') return t >= now.getTime() - 7 * MS_DAY
  if (preset === '30d') return t >= now.getTime() - 30 * MS_DAY
  return true
}

export function matchesCheckedPreset(
  lastCheckedAt: string | null,
  preset: OverviewCheckedPreset,
  now: Date,
): boolean {
  if (preset === 'any') return true
  if (!lastCheckedAt) return preset === 'older7d'
  const t = Date.parse(lastCheckedAt)
  if (!Number.isFinite(t)) return preset === 'older7d'
  const age = now.getTime() - t
  if (preset === '24h') return age <= MS_DAY
  if (preset === '7d') return age <= 7 * MS_DAY
  if (preset === 'older7d') return age > 7 * MS_DAY
  return true
}

export function filterOverviewRoutes(
  routes: OverviewRoute[],
  filters: OverviewFilters,
  now: Date = new Date(),
): OverviewRoute[] {
  return routes.filter(route => {
    if (filters.statuses.length > 0) {
      if (!route.status || !filters.statuses.includes(route.status)) return false
    }
    if (!matchesAddedPreset(route.addedAt, filters.added, now)) return false
    if (!matchesCheckedPreset(route.lastCheckedAt, filters.checked, now)) return false
    return true
  })
}

export function countByStatus(routes: OverviewRoute[]): Record<RouteVerdict | 'all', number> {
  const counts: Record<RouteVerdict | 'all', number> = {
    all: routes.length,
    READY: 0,
    VERIFY: 0,
    HOLD: 0,
  }
  for (const route of routes) {
    if (route.status === 'READY') counts.READY += 1
    else if (route.status === 'VERIFY') counts.VERIFY += 1
    else if (route.status === 'HOLD') counts.HOLD += 1
  }
  return counts
}

export function filtersAreActive(filters: OverviewFilters): boolean {
  return filters.statuses.length > 0 || filters.added !== 'any' || filters.checked !== 'any'
}

const ADDED_VALUES = new Set<OverviewAddedPreset>(['any', 'today', '7d', '30d'])
const CHECKED_VALUES = new Set<OverviewCheckedPreset>(['any', '24h', '7d', 'older7d'])
const STATUS_VALUES = new Set<OverviewStatusFilter>(['READY', 'VERIFY', 'HOLD'])

export function parseOverviewFilters(
  params: URLSearchParams | Record<string, string | null | undefined>,
): OverviewFilters {
  const get = (key: string): string => {
    if (params instanceof URLSearchParams) return params.get(key) || ''
    return String(params[key] ?? '')
  }

  const statusRaw = get('status')
  const statuses: OverviewStatusFilter[] = statusRaw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .map(s => {
      if (s === 'ready') return 'READY' as const
      if (s === 'verify' || s === 'verify evidence') return 'VERIFY' as const
      if (s === 'hold' || s === 'hold departure') return 'HOLD' as const
      const upper = s.toUpperCase()
      return STATUS_VALUES.has(upper as OverviewStatusFilter) ? (upper as OverviewStatusFilter) : null
    })
    .filter((s): s is OverviewStatusFilter => Boolean(s))

  const addedRaw = (get('added') || 'any').toLowerCase() as OverviewAddedPreset
  const checkedRaw = (get('checked') || 'any').toLowerCase() as OverviewCheckedPreset

  return {
    statuses: [...new Set(statuses)],
    added: ADDED_VALUES.has(addedRaw) ? addedRaw : 'any',
    checked: CHECKED_VALUES.has(checkedRaw) ? checkedRaw : 'any',
  }
}

export function serializeOverviewFilters(filters: OverviewFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.statuses.length > 0) {
    params.set(
      'status',
      filters.statuses.map(s => s.toLowerCase()).join(','),
    )
  }
  if (filters.added !== 'any') params.set('added', filters.added)
  if (filters.checked !== 'any') params.set('checked', filters.checked)
  return params
}

/** Merge overview filter params into existing search (preserving map= / route=). */
export function applyOverviewFiltersToSearch(
  current: URLSearchParams,
  filters: OverviewFilters,
): URLSearchParams {
  const next = new URLSearchParams(current)
  next.delete('status')
  next.delete('added')
  next.delete('checked')
  const serialized = serializeOverviewFilters(filters)
  for (const [key, value] of serialized) next.set(key, value)
  return next
}

export function groupAlertsByStatus(alerts: MonitoringAlert[]): {
  HOLD: Array<MonitoringAlert & { count: number }>
  VERIFY: Array<MonitoringAlert & { count: number }>
  READY: Array<MonitoringAlert & { count: number }>
} {
  const buckets = {
    HOLD: [] as MonitoringAlert[],
    VERIFY: [] as MonitoringAlert[],
    READY: [] as MonitoringAlert[],
  }
  const sorted = [...alerts].sort(
    (a, b) => Date.parse(b.runAt || b.time) - Date.parse(a.runAt || a.time),
  )
  for (const alert of sorted) {
    if (alert.status === 'Resolved') {
      buckets.READY.push(alert)
    } else if (alert.severity === 'HOLD') {
      buckets.HOLD.push(alert)
    } else if (alert.severity === 'VERIFY') {
      buckets.VERIFY.push(alert)
    } else {
      buckets.READY.push(alert)
    }
  }
  return {
    HOLD: collapseDuplicateAlerts(buckets.HOLD),
    VERIFY: collapseDuplicateAlerts(buckets.VERIFY),
    READY: collapseDuplicateAlerts(buckets.READY),
  }
}

/** True when a route has no inline geometry and no GPX URL to load. */
export function routeLacksMapGeometry(route: OverviewRoute): boolean {
  const hasGeom = Boolean(route.geometry && route.geometry.length >= 2)
  return !hasGeom && !route.gpxFile
}

export function countRoutesWithoutGeometry(routes: OverviewRoute[]): { missing: number; total: number } {
  const missing = routes.filter(routeLacksMapGeometry).length
  return { missing, total: routes.length }
}
