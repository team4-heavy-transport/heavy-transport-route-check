/** Group Alerts & history by route for the activity page. Read-time only — no storage rewrite. */

export type HistoryGroupRef = {
  id: string
  jobId?: string
  permitName?: string
  permitNumber?: string
  routeLabel?: string
  runAt: string
  verdict: string
  source?: string
  summary?: string
  evidenceCount?: number
  actionsLog?: string[]
}

export type AlertGroupRef = {
  id: string
  routeId: string
  routeLabel: string
  jobId?: string
  runAt: string
  severity: string
  status: string
  change: string
  detail: string
  source?: string
  escalated?: boolean
}

export type RouteActivityGroup<THistory extends HistoryGroupRef, TAlert extends AlertGroupRef> = {
  key: string
  label: string
  latestHistory?: THistory
  latestAlert?: TAlert
  history: THistory[]
  alerts: TAlert[]
  lastCheckedAt: string
  latestVerdict: string
  isDemo: boolean
}

function normalizeLabel(value?: string | null): string {
  return (value || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Stable route key: prefer jobId, then permit number, then origin→destination / permit name. */
export function routeGroupKey(input: {
  jobId?: string | null
  permitNumber?: string | null
  routeLabel?: string | null
  permitName?: string | null
}): string {
  const jobId = (input.jobId || '').trim()
  if (jobId) return `job:${jobId}`

  const permitNumber = (input.permitNumber || '').trim()
  if (permitNumber) return `permit:${permitNumber}`

  const routeLabel = normalizeLabel(input.routeLabel)
  if (routeLabel) return `route:${routeLabel}`

  const permitName = normalizeLabel(input.permitName)
  if (permitName) return `permitName:${permitName}`

  return 'route:unknown'
}

export function isDemoOrSimulatedSource(source?: string | null, change?: string | null): boolean {
  const haystack = `${source || ''} ${change || ''}`.toLowerCase()
  return /\b(demo|simulated|not live)\b/.test(haystack)
}

function groupLabelFromHistory(record: HistoryGroupRef): string {
  return (record.routeLabel || record.permitName || 'Unknown route').trim() || 'Unknown route'
}

function groupLabelFromAlert(alert: AlertGroupRef): string {
  return (alert.routeLabel || 'Unknown route').trim() || 'Unknown route'
}

function sortByRunAtDesc<T extends { id: string; runAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => Date.parse(b.runAt) - Date.parse(a.runAt) || b.id.localeCompare(a.id))
}

/**
 * Group history checks and alerts by route. Existing stored rows are unchanged;
 * grouping is derived at read time so nothing is lost.
 */
export function groupActivityByRoute<THistory extends HistoryGroupRef, TAlert extends AlertGroupRef>(
  history: THistory[],
  alerts: TAlert[],
): RouteActivityGroup<THistory, TAlert>[] {
  const historyByKey = new Map<string, THistory[]>()
  const labels = new Map<string, string>()

  for (const record of history) {
    const key = routeGroupKey(record)
    const list = historyByKey.get(key) || []
    list.push(record)
    historyByKey.set(key, list)
    if (!labels.has(key)) labels.set(key, groupLabelFromHistory(record))
  }

  const alertsByKey = new Map<string, TAlert[]>()
  for (const alert of alerts) {
    const linked = history.find(
      record => record.id === alert.routeId || record.jobId === alert.routeId || record.jobId === alert.jobId,
    )
    const key = routeGroupKey({
      jobId: alert.jobId || linked?.jobId,
      permitNumber: linked?.permitNumber,
      routeLabel: alert.routeLabel || linked?.routeLabel,
      permitName: linked?.permitName,
    })
    const list = alertsByKey.get(key) || []
    list.push(alert)
    alertsByKey.set(key, list)
    if (!labels.has(key)) labels.set(key, groupLabelFromAlert(alert))
  }

  const keys = new Set([...historyByKey.keys(), ...alertsByKey.keys()])
  const groups: RouteActivityGroup<THistory, TAlert>[] = []

  for (const key of keys) {
    const groupedHistory = sortByRunAtDesc(historyByKey.get(key) || [])
    const groupedAlerts = sortByRunAtDesc(alertsByKey.get(key) || [])
    const latestHistory = groupedHistory[0]
    const latestAlert = groupedAlerts[0]
    const lastCheckedAt = latestHistory?.runAt || latestAlert?.runAt || ''
    const latestVerdict = latestHistory?.verdict || latestAlert?.severity || 'READY'
    const isDemo = groupedHistory.some(item => isDemoOrSimulatedSource(item.source))
      || groupedAlerts.some(item => isDemoOrSimulatedSource(item.source, item.change))

    groups.push({
      key,
      label: labels.get(key) || 'Unknown route',
      latestHistory,
      latestAlert,
      history: groupedHistory,
      alerts: groupedAlerts,
      lastCheckedAt,
      latestVerdict,
      isDemo,
    })
  }

  return groups.sort((a, b) => Date.parse(b.lastCheckedAt) - Date.parse(a.lastCheckedAt) || a.label.localeCompare(b.label))
}
