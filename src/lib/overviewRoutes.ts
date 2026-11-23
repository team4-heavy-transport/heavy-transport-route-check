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
}

export type OverviewRoute = {
  id: string
  title: string
  origin: string
  destination: string
  permitNumber: string
  status: RouteVerdict | null
  addedAt: string
  lastCheckedAt: string | null
  vehicle: VehicleDims | null
  latestEvidence: RouteEvidence[]
  summaryItems: OverviewSummaryItem[]
  alerts: MonitoringAlert[]
  /** Parsed track points, or null when geometry is unknown / still URL-backed. */
  geometry: LatLng[] | null
  /** Sample/test permit GPX URL when geometry must be loaded async. */
  gpxFile: string | null
  source: OverviewRouteSource
  jobId?: string
  permitId?: string
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

const STATUS_ORDER: Record<OverviewSummarySeverity, number> = {
  HOLD: 0,
  VERIFY: 1,
  READY: 2,
}

const MS_DAY = 24 * 60 * 60 * 1000

export function evidenceToSummarySeverity(item: Pick<RouteEvidence, 'state'>): OverviewSummarySeverity {
  if (item.state === 'danger' || item.state === 'conflict') return 'HOLD'
  if (item.state === 'warning') return 'VERIFY'
  return 'READY'
}

/** HOLD → VERIFY → READY order for blocking / evidence summary lists. */
export function sortSummaryBySeverity<T extends { severity: OverviewSummarySeverity }>(items: T[]): T[] {
  return [...items].sort((a, b) => STATUS_ORDER[a.severity] - STATUS_ORDER[b.severity])
}

export function buildSummaryItems(evidence: RouteEvidence[] | undefined | null): OverviewSummaryItem[] {
  const items = (evidence || []).map(item => ({
    id: item.id,
    label: (item.title || item.detail || 'Evidence item').trim() || 'Evidence item',
    severity: evidenceToSummarySeverity(item),
  }))
  return sortSummaryBySeverity(items)
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
  examplePermits: TestPermit[],
  permitNumber: string,
): TestPermit | undefined {
  const needle = permitNumber.trim().toLowerCase()
  if (!needle) return undefined
  return examplePermits.find(p => p.permitNumber.trim().toLowerCase() === needle)
}

function alertsForRoute(
  alerts: MonitoringAlert[],
  routeId: string,
  jobId?: string,
): MonitoringAlert[] {
  return alerts.filter(alert => {
    if (jobId && (alert.jobId === jobId || alert.routeId === jobId)) return true
    return alert.routeId === routeId || alert.jobId === routeId
  })
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
    vehicle: permit.vehicle,
    latestEvidence: [],
    summaryItems: [],
    alerts: [],
    geometry: null,
    gpxFile: permit.gpxFile,
    source: 'example',
    permitId: permit.id,
  }
}

export function buildOverviewRoutes(input: {
  jobs: SavedJob[]
  history: CheckHistoryRecord[]
  examplePermits: TestPermit[]
  alerts?: MonitoringAlert[]
}): OverviewRoute[] {
  const alerts = input.alerts || []
  const byId = new Map<string, OverviewRoute>()

  // Jobs first — keyed by job id.
  for (const job of input.jobs) {
    const jobChecks = input.history
      .filter(h => h.jobId === job.id)
      .sort((a, b) => Date.parse(b.runAt) - Date.parse(a.runAt))
    const latest = jobChecks[0]
    const status = latest?.verdict ?? job.lastVerdict ?? null
    const lastCheckedAt = latest?.runAt ?? job.lastCheckedAt ?? null
    const evidence = latest?.evidence || []
    const permit = findPermitByNumber(input.examplePermits, job.permitNumber)
    const geometry = parseJobGeometry(job.gpxContent)
    byId.set(job.id, {
      id: job.id,
      title: job.name || `${job.origin} → ${job.destination}`,
      origin: job.origin,
      destination: job.destination,
      permitNumber: job.permitNumber,
      status,
      addedAt: job.createdAt,
      lastCheckedAt,
      vehicle: job.vehicle,
      latestEvidence: evidence,
      summaryItems: buildSummaryItems(evidence),
      alerts: alertsForRoute(alerts, job.id, job.id),
      geometry,
      gpxFile: geometry ? null : (permit?.gpxFile ?? null),
      source: 'job',
      jobId: job.id,
      permitId: permit?.id,
    })
  }

  // History without a job — keyed by permitNumber else routeLabel.
  const orphanHistory = input.history
    .filter(h => !h.jobId || !byId.has(h.jobId))
    .filter(h => !h.jobId)

  const orphanGroups = new Map<string, CheckHistoryRecord[]>()
  for (const record of orphanHistory) {
    const key = overviewRouteKeyFromCheck(record)
    const list = orphanGroups.get(key) || []
    list.push(record)
    orphanGroups.set(key, list)
  }

  for (const [key, records] of orphanGroups) {
    const sorted = [...records].sort((a, b) => Date.parse(b.runAt) - Date.parse(a.runAt))
    const latest = sorted[0]
    const earliest = [...records].sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))[0]
    const permit = findPermitByNumber(input.examplePermits, latest.permitNumber || '')
    const evidence = latest.evidence || []
    byId.set(key, {
      id: key,
      title: latest.title || latest.permitName || latest.routeLabel,
      origin: latest.routeLabel?.split(/\s*→\s*/)[0]?.trim() || latest.permitName,
      destination: latest.routeLabel?.split(/\s*→\s*/)[1]?.trim() || '',
      permitNumber: latest.permitNumber || '',
      status: latest.verdict,
      addedAt: earliest.runAt,
      lastCheckedAt: latest.runAt,
      vehicle: latest.vehicle ?? permit?.vehicle ?? null,
      latestEvidence: evidence,
      summaryItems: buildSummaryItems(evidence),
      alerts: alertsForRoute(alerts, key),
      geometry: null,
      gpxFile: permit?.gpxFile ?? null,
      source: 'check',
      permitId: permit?.id,
    })
  }

  const routes = [...byId.values()]
  if (routes.length > 0) {
    return routes.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
  }

  // Empty account → example permits in the same list.
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
  HOLD: MonitoringAlert[]
  VERIFY: MonitoringAlert[]
  READY: MonitoringAlert[]
} {
  const groups = { HOLD: [] as MonitoringAlert[], VERIFY: [] as MonitoringAlert[], READY: [] as MonitoringAlert[] }
  for (const alert of alerts) {
    if (alert.severity === 'HOLD') groups.HOLD.push(alert)
    else if (alert.severity === 'VERIFY') groups.VERIFY.push(alert)
    else groups.READY.push(alert)
  }
  return groups
}
