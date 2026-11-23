import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RouteEvidence } from '../data/routeChecks.ts'
import type { CheckHistoryRecord, MonitoringAlert } from '../context/RouteMonitoringContext.tsx'
import type { SavedJob } from './jobs.ts'
import type { TestPermit } from './routeCheck.ts'
import {
  buildOverviewRoutes,
  buildSummaryItems,
  countByStatus,
  filterOverviewRoutes,
  filtersAreActive,
  overviewRouteIdForResult,
  parseOverviewFilters,
  serializeOverviewFilters,
  sortSummaryBySeverity,
} from './overviewRoutes.ts'

const NOW = new Date('2026-11-23T12:00:00+01:00')

function vehicle() {
  return { width: 3.2, height: 4.5, length: 28, grossWeight: 60 }
}

function evidence(partial: Partial<RouteEvidence> & Pick<RouteEvidence, 'id' | 'state' | 'title'>): RouteEvidence {
  return {
    detail: '',
    source: 'test',
    age: 'now',
    confidence: 'high',
    category: 'roadworks',
    ...partial,
  }
}

function job(partial: Partial<SavedJob> & Pick<SavedJob, 'id' | 'name'>): SavedJob {
  return {
    permitNumber: 'DE-TEST-1',
    routeFileName: 'route.gpx',
    gpxContent: '<gpx><trk><trkseg><trkpt lat="53.5" lon="10.0"/><trkpt lat="52.5" lon="9.7"/></trkseg></trk></gpx>',
    origin: 'Hamburg',
    destination: 'Hannover',
    corridor: 'A7',
    vehicle: vehicle(),
    plannedDeparture: '2026-11-24T22:00:00+01:00',
    monitorIntervalMinutes: 15,
    createdAt: '2026-11-20T10:00:00+01:00',
    updatedAt: '2026-11-20T10:00:00+01:00',
    ...partial,
  }
}

function check(partial: Partial<CheckHistoryRecord> & Pick<CheckHistoryRecord, 'id' | 'verdict' | 'runAt'>): CheckHistoryRecord {
  return {
    permitName: 'Permit',
    routeLabel: 'Hamburg → Hannover',
    evidenceCount: 0,
    retrievedAt: partial.runAt,
    source: 'Autobahn GmbH',
    summary: 'ok',
    ...partial,
  }
}

const examples: TestPermit[] = [
  {
    id: 'hamburg-hannover',
    name: 'Hamburg → Hannover',
    gpxFile: '/test-permits/hamburg-hannover-a7.gpx',
    metadataFile: '/test-permits/hamburg-hannover-a7.json',
    origin: 'Hamburg Port',
    destination: 'Hannover Hub',
    originShort: 'Hamburg',
    destinationShort: 'Hannover',
    permitNumber: 'DE-HH-2026-01845',
    corridor: 'A7',
    distance: '151 km',
    vehicle: vehicle(),
    routeDescription: 'A7',
    kind: 'live',
    expectedVerdict: 'VERIFY',
    liveLabel: 'Sample',
  },
]

test('buildOverviewRoutes merges jobs and orphan checks with latest status', () => {
  const jobs = [
    job({
      id: 'job-1',
      name: 'Night run',
      permitNumber: 'DE-HH-2026-01845',
      lastVerdict: 'READY',
      lastCheckedAt: '2026-11-21T08:00:00+01:00',
      createdAt: '2026-11-18T09:00:00+01:00',
    }),
  ]
  const history = [
    check({
      id: 'h1',
      jobId: 'job-1',
      verdict: 'HOLD',
      runAt: '2026-11-22T18:00:00+01:00',
      evidence: [evidence({ id: 'e1', state: 'danger', title: 'Closure' })],
    }),
    check({
      id: 'h2',
      jobId: 'job-1',
      verdict: 'VERIFY',
      runAt: '2026-11-21T12:00:00+01:00',
    }),
    check({
      id: 'h3',
      verdict: 'READY',
      runAt: '2026-11-22T09:00:00+01:00',
      permitNumber: 'DE-ORPHAN-1',
      routeLabel: 'Bremen → Dortmund',
      permitName: 'Orphan permit',
      vehicle: vehicle(),
    }),
    check({
      id: 'h4',
      verdict: 'VERIFY',
      runAt: '2026-11-20T09:00:00+01:00',
      permitNumber: 'DE-ORPHAN-1',
      routeLabel: 'Bremen → Dortmund',
      permitName: 'Orphan permit',
    }),
  ]

  const routes = buildOverviewRoutes({ jobs, history, examplePermits: examples })
  assert.equal(routes.length, 2)

  const jobRoute = routes.find(r => r.id === 'job-1')
  assert.ok(jobRoute)
  assert.equal(jobRoute.source, 'job')
  assert.equal(jobRoute.status, 'HOLD')
  assert.equal(jobRoute.lastCheckedAt, '2026-11-22T18:00:00+01:00')
  assert.equal(jobRoute.addedAt, '2026-11-18T09:00:00+01:00')
  assert.ok(jobRoute.geometry && jobRoute.geometry.length >= 2)
  assert.equal(jobRoute.summaryItems[0]?.severity, 'HOLD')

  const orphan = routes.find(r => r.id === 'DE-ORPHAN-1')
  assert.ok(orphan)
  assert.equal(orphan.source, 'check')
  assert.equal(orphan.status, 'READY')
  assert.equal(orphan.lastCheckedAt, '2026-11-22T09:00:00+01:00')
  assert.equal(orphan.addedAt, '2026-11-20T09:00:00+01:00')
})

test('buildOverviewRoutes falls back to examples only when account is empty', () => {
  const empty = buildOverviewRoutes({ jobs: [], history: [], examplePermits: examples })
  assert.equal(empty.length, 1)
  assert.equal(empty[0].source, 'example')
  assert.equal(empty[0].id, 'DE-HH-2026-01845')
  assert.equal(empty[0].gpxFile, '/test-permits/hamburg-hannover-a7.gpx')

  const withJob = buildOverviewRoutes({
    jobs: [job({ id: 'job-x', name: 'Real' })],
    history: [],
    examplePermits: examples,
  })
  assert.equal(withJob.length, 1)
  assert.equal(withJob[0].source, 'job')
  assert.ok(withJob.every(r => r.source !== 'example'))
})

test('buildOverviewRoutes keys orphan checks by routeLabel when permitNumber missing', () => {
  const history = [
    check({
      id: 'h1',
      verdict: 'VERIFY',
      runAt: '2026-11-22T10:00:00+01:00',
      routeLabel: 'Leipzig → Nürnberg',
      permitName: 'Leipzig run',
    }),
  ]
  const routes = buildOverviewRoutes({ jobs: [], history, examplePermits: [] })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].id, 'Leipzig → Nürnberg')
  assert.equal(routes[0].source, 'check')
})

test('summary severity orders HOLD → VERIFY → READY', () => {
  const items = buildSummaryItems([
    evidence({ id: 'a', state: 'clear', title: 'Clear stretch' }),
    evidence({ id: 'b', state: 'danger', title: 'Full closure' }),
    evidence({ id: 'c', state: 'warning', title: 'Lane works' }),
    evidence({ id: 'd', state: 'info', title: 'Info note' }),
  ])
  assert.deepEqual(
    items.map(i => i.severity),
    ['HOLD', 'VERIFY', 'READY', 'READY'],
  )
  assert.deepEqual(
    sortSummaryBySeverity([
      { severity: 'READY' as const },
      { severity: 'HOLD' as const },
      { severity: 'VERIFY' as const },
    ]).map(i => i.severity),
    ['HOLD', 'VERIFY', 'READY'],
  )
})

test('filterOverviewRoutes status multi-select with counts helper', () => {
  const routes = buildOverviewRoutes({
    jobs: [
      job({ id: 'j1', name: 'A', lastVerdict: 'HOLD', createdAt: '2026-11-22T08:00:00+01:00', lastCheckedAt: '2026-11-23T08:00:00+01:00' }),
      job({ id: 'j2', name: 'B', lastVerdict: 'VERIFY', createdAt: '2026-11-10T08:00:00+01:00', lastCheckedAt: '2026-11-10T08:00:00+01:00' }),
      job({ id: 'j3', name: 'C', lastVerdict: 'READY', createdAt: '2026-11-23T09:00:00+01:00', lastCheckedAt: '2026-11-23T10:00:00+01:00' }),
    ],
    history: [],
    examplePermits: [],
  })
  const counts = countByStatus(routes)
  assert.equal(counts.all, 3)
  assert.equal(counts.HOLD, 1)
  assert.equal(counts.VERIFY, 1)
  assert.equal(counts.READY, 1)

  const holdVerify = filterOverviewRoutes(routes, { statuses: ['HOLD', 'VERIFY'], added: 'any', checked: 'any' }, NOW)
  assert.equal(holdVerify.length, 2)
  assert.ok(holdVerify.every(r => r.status === 'HOLD' || r.status === 'VERIFY'))
})

test('filterOverviewRoutes date-added presets with fixed clock', () => {
  const routes = buildOverviewRoutes({
    jobs: [
      job({ id: 'today', name: 'Today', createdAt: '2026-11-23T08:00:00+01:00' }),
      job({ id: 'week', name: 'Week', createdAt: '2026-11-18T08:00:00+01:00' }),
      job({ id: 'month', name: 'Month', createdAt: '2026-10-30T08:00:00+01:00' }),
      job({ id: 'old', name: 'Old', createdAt: '2026-09-01T08:00:00+01:00' }),
    ],
    history: [],
    examplePermits: [],
  })

  assert.equal(filterOverviewRoutes(routes, { statuses: [], added: 'today', checked: 'any' }, NOW).map(r => r.id).join(','), 'today')
  assert.deepEqual(
    filterOverviewRoutes(routes, { statuses: [], added: '7d', checked: 'any' }, NOW).map(r => r.id).sort(),
    ['today', 'week'].sort(),
  )
  assert.deepEqual(
    filterOverviewRoutes(routes, { statuses: [], added: '30d', checked: 'any' }, NOW).map(r => r.id).sort(),
    ['today', 'week', 'month'].sort(),
  )
})

test('filterOverviewRoutes last-checked presets including older than 7 days', () => {
  const routes = buildOverviewRoutes({
    jobs: [
      job({ id: 'fresh', name: 'Fresh', lastCheckedAt: '2026-11-23T06:00:00+01:00', createdAt: '2026-11-01T00:00:00+01:00' }),
      job({ id: 'week', name: 'Week', lastCheckedAt: '2026-11-18T12:00:00+01:00', createdAt: '2026-11-01T00:00:00+01:00' }),
      job({ id: 'old', name: 'Old', lastCheckedAt: '2026-11-01T12:00:00+01:00', createdAt: '2026-10-01T00:00:00+01:00' }),
      job({ id: 'never', name: 'Never', lastCheckedAt: undefined, createdAt: '2026-11-01T00:00:00+01:00' }),
    ],
    history: [],
    examplePermits: [],
  })

  assert.deepEqual(
    filterOverviewRoutes(routes, { statuses: [], added: 'any', checked: '24h' }, NOW).map(r => r.id),
    ['fresh'],
  )
  assert.deepEqual(
    filterOverviewRoutes(routes, { statuses: [], added: 'any', checked: '7d' }, NOW).map(r => r.id).sort(),
    ['fresh', 'week'].sort(),
  )
  assert.deepEqual(
    filterOverviewRoutes(routes, { statuses: [], added: 'any', checked: 'older7d' }, NOW).map(r => r.id).sort(),
    ['never', 'old'].sort(),
  )
})

test('URL query parse/serialise round-trip', () => {
  const filters = {
    statuses: ['HOLD', 'VERIFY'] as const,
    added: '7d' as const,
    checked: '24h' as const,
  }
  const params = serializeOverviewFilters({ ...filters, statuses: [...filters.statuses] })
  assert.equal(params.get('status'), 'hold,verify')
  assert.equal(params.get('added'), '7d')
  assert.equal(params.get('checked'), '24h')

  const parsed = parseOverviewFilters(params)
  assert.deepEqual(parsed.statuses, ['HOLD', 'VERIFY'])
  assert.equal(parsed.added, '7d')
  assert.equal(parsed.checked, '24h')
  assert.equal(filtersAreActive(parsed), true)
  assert.equal(filtersAreActive({ statuses: [], added: 'any', checked: 'any' }), false)

  const again = serializeOverviewFilters(parsed)
  assert.equal(again.toString(), params.toString())
})

test('overviewRouteIdForResult prefers job id then permit then label', () => {
  assert.equal(overviewRouteIdForResult({ jobId: 'job-9', permitNumber: 'P', routeLabel: 'A → B' }), 'job-9')
  assert.equal(overviewRouteIdForResult({ permitNumber: 'DE-1', routeLabel: 'A → B' }), 'DE-1')
  assert.equal(overviewRouteIdForResult({ routeLabel: 'A → B' }), 'A → B')
})

test('buildOverviewRoutes attaches matching alerts', () => {
  const alerts: MonitoringAlert[] = [
    {
      id: 'a1',
      time: '2026-11-22T18:00:00+01:00',
      runAt: '2026-11-22T18:00:00+01:00',
      routeId: 'job-1',
      routeLabel: 'Hamburg → Hannover',
      change: 'HOLD',
      detail: 'closure',
      severity: 'HOLD',
      status: 'New',
      source: 'Autobahn GmbH',
      jobId: 'job-1',
    },
  ]
  const routes = buildOverviewRoutes({
    jobs: [job({ id: 'job-1', name: 'Night' })],
    history: [],
    examplePermits: [],
    alerts,
  })
  assert.equal(routes[0].alerts.length, 1)
  assert.equal(routes[0].alerts[0].id, 'a1')
})
