import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RouteEvidence } from '../data/routeChecks.ts'
import type { CheckHistoryRecord, MonitoringAlert } from '../context/RouteMonitoringContext.tsx'
import type { SavedJob } from './jobs.ts'
import type { TestPermit } from './routeCheck.ts'
import {
  alertsForRoute,
  attachOrphanChecksToJobs,
  buildOverviewRoutes,
  buildRouteSummary,
  buildSummaryItems,
  collapseDuplicateAlerts,
  collapseSummaryDuplicates,
  countByStatus,
  countRoutesWithoutGeometry,
  endsMatchPermit,
  filterOverviewRoutes,
  filtersAreActive,
  findGeometryPermit,
  groupAlertsByStatus,
  looksLikeCoordinates,
  normaliseSummaryKey,
  overviewRouteIdForResult,
  parseOverviewFilters,
  routeDisplayTitle,
  routeLacksMapGeometry,
  serializeOverviewFilters,
  sortOverviewRoutes,
  sortSummaryBySeverity,
} from './overviewRoutes.ts'
import { geometryTestPermits, sampleTestPermits } from './routeCheck.ts'

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

function alert(partial: Partial<MonitoringAlert> & Pick<MonitoringAlert, 'id' | 'routeId' | 'severity'>): MonitoringAlert {
  return {
    time: '2026-11-22T18:00:00+01:00',
    runAt: '2026-11-22T18:00:00+01:00',
    routeLabel: 'Hamburg → Hannover',
    change: `${partial.severity} change`,
    detail: 'detail',
    status: 'New',
    source: 'Autobahn GmbH',
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
  assert.equal(jobRoute.title, 'Hamburg → Hannover')

  const orphan = routes.find(r => r.id === 'DE-ORPHAN-1')
  assert.ok(orphan)
  assert.equal(orphan.source, 'check')
  assert.equal(orphan.status, 'READY')
  assert.equal(orphan.lastCheckedAt, '2026-11-22T09:00:00+01:00')
  assert.equal(orphan.addedAt, '2026-11-20T09:00:00+01:00')
})

test('buildOverviewRoutes attaches orphan checks to jobs by permitNumber', () => {
  const jobs = [
    job({
      id: 'job-a',
      name: 'HH night',
      permitNumber: 'DE-HH-2026-01845',
      lastVerdict: 'VERIFY',
      lastCheckedAt: '2026-11-12T10:00:00+01:00',
      plannedDeparture: '2026-11-25T22:00:00+01:00',
    }),
    job({
      id: 'job-b',
      name: 'HH day',
      permitNumber: 'DE-HH-2026-01845',
      lastVerdict: 'VERIFY',
      lastCheckedAt: '2026-11-10T10:00:00+01:00',
      plannedDeparture: '2026-11-26T08:00:00+01:00',
      createdAt: '2026-11-19T10:00:00+01:00',
    }),
  ]
  const history = [
    check({
      id: 'job-check',
      jobId: 'job-a',
      verdict: 'VERIFY',
      runAt: '2026-11-12T10:00:00+01:00',
      permitNumber: 'DE-HH-2026-01845',
    }),
    check({
      id: 'orphan-hold',
      verdict: 'HOLD',
      runAt: '2026-11-22T18:00:00+01:00',
      permitNumber: 'DE-HH-2026-01845',
      routeLabel: 'Hamburg → Hannover',
      summary: 'Full closure on A7',
      confirmOnSite: ['Confirm barrier'],
    }),
  ]

  const attached = attachOrphanChecksToJobs(jobs, history)
  assert.equal(attached.remainingOrphans.length, 0)
  assert.ok(attached.jobChecks.get('job-a')?.some(c => c.id === 'orphan-hold'))
  assert.ok(!(attached.jobChecks.get('job-b') || []).some(c => c.id === 'orphan-hold'))

  const routes = buildOverviewRoutes({ jobs, history, examplePermits: examples })
  assert.equal(routes.length, 2)
  assert.ok(!routes.some(r => r.source === 'check' && r.permitNumber === 'DE-HH-2026-01845'))
  const jobA = routes.find(r => r.id === 'job-a')
  assert.ok(jobA)
  assert.equal(jobA.status, 'HOLD')
  assert.equal(jobA.lastCheckedAt, '2026-11-22T18:00:00+01:00')
  assert.ok(jobA.checkIds.includes('orphan-hold'))
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
  assert.equal(routes[0].title, 'Leipzig → Nürnberg')
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

test('buildRouteSummary uses confirmOnSite and alerts when evidence is empty', () => {
  const withConfirm = buildRouteSummary({
    evidence: [],
    confirmOnSite: ['Check bridge clearance', 'Confirm escort'],
    verdict: 'HOLD',
    summary: 'Blocking works',
    alerts: [
      alert({ id: 'a1', routeId: 'h1', severity: 'VERIFY', change: 'Lane narrows' }),
      alert({ id: 'a2', routeId: 'h1', severity: 'HOLD', change: 'Full closure' }),
    ],
  })
  assert.deepEqual(
    withConfirm.items.map(i => [i.severity, i.label]),
    [
      ['HOLD', 'Check bridge clearance'],
      ['HOLD', 'Confirm escort'],
      ['HOLD', 'Full closure'],
      ['VERIFY', 'Lane narrows'],
    ],
  )
  assert.equal(withConfirm.fallback, null)

  const fallback = buildRouteSummary({
    evidence: [],
    confirmOnSite: [],
    verdict: 'VERIFY',
    summary: 'Verify lane widths on site',
    alerts: [],
  })
  assert.equal(fallback.items.length, 0)
  assert.equal(fallback.fallback?.severity, 'VERIFY')
  assert.equal(fallback.fallback?.label, 'Verify lane widths on site')

  const capped = buildRouteSummary({
    evidence: Array.from({ length: 8 }, (_, i) =>
      evidence({ id: `e${i}`, state: i < 2 ? 'danger' : 'warning', title: `Item ${i}` }),
    ),
    verdict: 'HOLD',
  })
  assert.equal(capped.items.length, 7)
  assert.equal(capped.items[6].label, '+2 more')
})

test('alertsForRoute matches check ids, job id, and routeLabel', () => {
  const alerts = [
    alert({ id: 'by-check', routeId: 'check-9', severity: 'HOLD' }),
    alert({ id: 'by-job', routeId: 'job-1', jobId: 'job-1', severity: 'VERIFY' }),
    alert({ id: 'by-label', routeId: 'other', routeLabel: 'Hof A9 → Bayreuth A9', severity: 'READY' }),
    alert({ id: 'unrelated', routeId: 'nope', severity: 'HOLD' }),
  ]
  const matched = alertsForRoute(alerts, {
    routeId: 'job-1',
    jobId: 'job-1',
    routeLabel: 'Hof A9 → Bayreuth A9',
    checkIds: ['check-9', 'check-8'],
  })
  assert.deepEqual(matched.map(a => a.id).sort(), ['by-check', 'by-job', 'by-label'])
})

test('groupAlertsByStatus puts Resolved into READY and sorts newest first', () => {
  const groups = groupAlertsByStatus([
    alert({
      id: 'old',
      routeId: 'r',
      severity: 'HOLD',
      change: 'Old closure',
      detail: 'A7 north',
      runAt: '2026-11-20T10:00:00+01:00',
      time: '2026-11-20T10:00:00+01:00',
    }),
    alert({
      id: 'new',
      routeId: 'r',
      severity: 'HOLD',
      change: 'New closure',
      detail: 'A7 south',
      runAt: '2026-11-22T10:00:00+01:00',
      time: '2026-11-22T10:00:00+01:00',
    }),
    alert({ id: 'done', routeId: 'r', severity: 'HOLD', status: 'Resolved', runAt: '2026-11-21T10:00:00+01:00', time: '2026-11-21T10:00:00+01:00' }),
    alert({ id: 'v', routeId: 'r', severity: 'VERIFY', runAt: '2026-11-21T12:00:00+01:00', time: '2026-11-21T12:00:00+01:00' }),
  ])
  assert.deepEqual(groups.HOLD.map(a => a.id), ['new', 'old'])
  assert.deepEqual(groups.VERIFY.map(a => a.id), ['v'])
  assert.deepEqual(groups.READY.map(a => a.id), ['done'])
})

test('normaliseSummaryKey collapses whitespace and case', () => {
  assert.equal(normaliseSummaryKey('  Weight   Limit 3.5 T  '), 'weight limit 3.5 t')
})

test('collapseSummaryDuplicates merges identical labels and keeps ×N', () => {
  const collapsed = collapseSummaryDuplicates([
    { id: '1', label: 'Weight limit 3.5 t vs vehicle 60 t', severity: 'HOLD' },
    { id: '2', label: 'Weight  Limit 3.5 T vs vehicle 60 t', severity: 'HOLD' },
    { id: '3', label: 'Weight limit 3.5 t vs vehicle 60 t', severity: 'HOLD' },
    { id: '4', label: 'Lane narrows', severity: 'VERIFY' },
  ])
  assert.equal(collapsed.length, 2)
  assert.equal(collapsed[0].count, 3)
  assert.equal(collapsed[0].severity, 'HOLD')
  assert.equal(collapsed[1].label, 'Lane narrows')
  assert.equal(collapsed[1].count, undefined)
})

test('buildRouteSummary collapses duplicate labels before the +N more cap', () => {
  const summary = buildRouteSummary({
    evidence: Array.from({ length: 5 }, (_, i) =>
      evidence({
        id: `e${i}`,
        state: 'danger',
        title: 'Weight limit 3.5 t vs vehicle 60 t',
      }),
    ),
    verdict: 'HOLD',
  })
  assert.equal(summary.items.length, 1)
  assert.equal(summary.items[0].count, 5)
  assert.match(summary.items[0].label, /Weight limit/i)
})

test('collapseDuplicateAlerts keeps newest timestamp and ×N', () => {
  const collapsed = collapseDuplicateAlerts([
    alert({
      id: 'a1',
      routeId: 'r',
      severity: 'HOLD',
      change: 'Weight limit',
      detail: '3.5 t vs 60 t',
      runAt: '2026-11-20T10:00:00+01:00',
      time: '2026-11-20T10:00:00+01:00',
    }),
    alert({
      id: 'a2',
      routeId: 'r',
      severity: 'HOLD',
      change: 'Weight  limit',
      detail: '3.5 t vs 60 t',
      runAt: '2026-11-22T10:00:00+01:00',
      time: '2026-11-22T10:00:00+01:00',
    }),
    alert({
      id: 'a3',
      routeId: 'r',
      severity: 'HOLD',
      change: 'Weight limit',
      detail: '3.5 t vs 60 t',
      runAt: '2026-11-21T10:00:00+01:00',
      time: '2026-11-21T10:00:00+01:00',
    }),
    alert({
      id: 'b1',
      routeId: 'r',
      severity: 'HOLD',
      change: 'Full closure',
      detail: 'A7',
      runAt: '2026-11-21T09:00:00+01:00',
      time: '2026-11-21T09:00:00+01:00',
    }),
  ])
  assert.equal(collapsed.length, 2)
  assert.equal(collapsed[0].count, 3)
  assert.equal(collapsed[0].id, 'a2')
  assert.equal(collapsed[1].id, 'b1')
  assert.equal(collapsed[1].count, 1)
})

test('groupAlertsByStatus collapses identical change+detail rows', () => {
  const groups = groupAlertsByStatus([
    alert({
      id: '1',
      routeId: 'r',
      severity: 'VERIFY',
      change: 'Lane narrows',
      detail: 'Right lane',
      runAt: '2026-11-20T10:00:00+01:00',
      time: '2026-11-20T10:00:00+01:00',
    }),
    alert({
      id: '2',
      routeId: 'r',
      severity: 'VERIFY',
      change: 'Lane narrows',
      detail: 'Right lane',
      runAt: '2026-11-22T10:00:00+01:00',
      time: '2026-11-22T10:00:00+01:00',
    }),
  ])
  assert.equal(groups.VERIFY.length, 1)
  assert.equal(groups.VERIFY[0].count, 2)
  assert.equal(groups.VERIFY[0].id, '2')
})

test('routeDisplayTitle falls back when ends look like coordinates', () => {
  assert.equal(looksLikeCoordinates('53.5511, 9.9937'), true)
  assert.equal(looksLikeCoordinates('Hamburg'), false)
  assert.equal(
    routeDisplayTitle({
      origin: '53.5511, 9.9937',
      destination: '52.3736, 9.7394',
      jobName: 'Port night run',
      corridor: 'A7',
    }),
    'Port night run',
  )
  assert.equal(
    routeDisplayTitle({ origin: 'Hof A9', destination: 'Bayreuth A9' }),
    'Hof A9 → Bayreuth A9',
  )
})

test('sortOverviewRoutes orders by severity then departure then last checked', () => {
  const routes = sortOverviewRoutes(
    buildOverviewRoutes({
      jobs: [
        job({
          id: 'ready-soon',
          name: 'Ready soon',
          lastVerdict: 'READY',
          plannedDeparture: '2026-11-24T08:00:00+01:00',
          lastCheckedAt: '2026-11-20T08:00:00+01:00',
        }),
        job({
          id: 'hold-later',
          name: 'Hold later',
          lastVerdict: 'HOLD',
          plannedDeparture: '2026-11-25T08:00:00+01:00',
          lastCheckedAt: '2026-11-22T08:00:00+01:00',
        }),
        job({
          id: 'hold-soon',
          name: 'Hold soon',
          lastVerdict: 'HOLD',
          plannedDeparture: '2026-11-24T06:00:00+01:00',
          lastCheckedAt: '2026-11-21T08:00:00+01:00',
        }),
        job({
          id: 'verify',
          name: 'Verify',
          lastVerdict: 'VERIFY',
          plannedDeparture: '2026-11-24T12:00:00+01:00',
          lastCheckedAt: '2026-11-22T18:00:00+01:00',
        }),
      ],
      history: [],
      examplePermits: [],
    }),
  )
  assert.deepEqual(
    routes.map(r => r.id),
    ['hold-soon', 'hold-later', 'verify', 'ready-soon'],
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

test('buildOverviewRoutes attaches matching alerts via check id', () => {
  const alerts: MonitoringAlert[] = [
    alert({
      id: 'a1',
      routeId: 'h-hold',
      severity: 'HOLD',
      change: 'HOLD',
      detail: 'closure',
      jobId: undefined,
    }),
    alert({
      id: 'a2',
      routeId: 'job-1',
      jobId: 'job-1',
      severity: 'VERIFY',
    }),
  ]
  const routes = buildOverviewRoutes({
    jobs: [job({ id: 'job-1', name: 'Night', permitNumber: 'DE-HH-2026-01845' })],
    history: [
      check({
        id: 'h-hold',
        jobId: 'job-1',
        verdict: 'HOLD',
        runAt: '2026-11-22T18:00:00+01:00',
        permitNumber: 'DE-HH-2026-01845',
      }),
    ],
    examplePermits: [],
    alerts,
  })
  assert.equal(routes[0].alerts.length, 2)
  assert.deepEqual(routes[0].alerts.map(a => a.id).sort(), ['a1', 'a2'])
})

test('countRoutesWithoutGeometry reports missing tracks', () => {
  const routes = buildOverviewRoutes({
    jobs: [job({ id: 'with-geom', name: 'Has track' })],
    history: [
      check({
        id: 'no-geom',
        verdict: 'VERIFY',
        runAt: '2026-11-22T10:00:00+01:00',
        permitNumber: 'DE-NO-GEOM',
        routeLabel: 'Leipzig → Nürnberg',
      }),
    ],
    examplePermits: [],
  })
  const { missing, total } = countRoutesWithoutGeometry(routes)
  assert.equal(total, 2)
  assert.equal(missing, 1)
})

test('sampleTestPermits are live-only — scenario permits need geometryPermits', () => {
  assert.ok(sampleTestPermits.every(p => p.kind === 'live'))
  assert.ok(!sampleTestPermits.some(p => p.permitNumber === 'SCENARIO-READY'))
  assert.ok(geometryTestPermits.some(p => p.permitNumber === 'SCENARIO-READY'))
  assert.ok(geometryTestPermits.some(p => p.id === 'hof-bayreuth'))
})

test('findGeometryPermit matches SCENARIO-READY by number and Hof by origin/destination', () => {
  const scenario = findGeometryPermit(geometryTestPermits, { permitNumber: 'SCENARIO-READY' })
  assert.ok(scenario)
  assert.equal(scenario.id, 'scenario-ready')
  assert.equal(scenario.gpxFile, '/test-permits/lubeck-rostock-a20.gpx')

  const hof = findGeometryPermit(geometryTestPermits, {
    permitNumber: '',
    routeLabel: 'Hof A9 → Bayreuth A9',
  })
  assert.ok(hof)
  assert.equal(hof.id, 'hof-bayreuth')
  assert.equal(hof.gpxFile, '/test-permits/hof-bayreuth-a9.gpx')

  const lubeckArrow = findGeometryPermit(geometryTestPermits, {
    permitNumber: 'unknown',
    origin: 'Lübeck A20',
    destination: 'Rostock A20',
  })
  assert.ok(lubeckArrow)
  assert.ok(
    lubeckArrow.id === 'lubeck-rostock' || lubeckArrow.permitNumber === 'SCENARIO-READY',
    `expected Lübeck–Rostock permit, got ${lubeckArrow.id}`,
  )
})

test('endsMatchPermit is diacritics- and arrow-tolerant', () => {
  const lubeck = geometryTestPermits.find(p => p.id === 'lubeck-rostock')
  assert.ok(lubeck)
  assert.ok(endsMatchPermit('Lubeck A20', 'Rostock A20', lubeck))
  assert.ok(endsMatchPermit('Lübeck A20', 'Rostock A20', lubeck))
})

test('buildOverviewRoutes resolves scenario + empty-number geometry via geometryPermits', () => {
  const history = [
    check({
      id: 'sc-ready',
      verdict: 'READY',
      runAt: '2026-11-22T10:00:00+01:00',
      permitNumber: 'SCENARIO-READY',
      routeLabel: 'Lübeck A20 → Rostock A20',
      permitName: 'Simulated READY',
    }),
    check({
      id: 'hof-orphan',
      verdict: 'VERIFY',
      runAt: '2026-11-22T11:00:00+01:00',
      permitNumber: '',
      routeLabel: 'Hof A9 → Bayreuth A9',
      permitName: 'Hof run',
    }),
  ]

  // Old bug: number-only match against live samples misses SCENARIO-* and empty numbers.
  assert.equal(
    findGeometryPermit(sampleTestPermits, { permitNumber: 'SCENARIO-READY' })?.kind === 'scenario',
    false,
  )
  assert.equal(
    findGeometryPermit(sampleTestPermits, { permitNumber: 'SCENARIO-READY' })?.permitNumber,
    undefined,
  )
  // Number miss + no ends → no permit (simulates pre-fallback behaviour for empty ends).
  assert.equal(
    findGeometryPermit(sampleTestPermits, { permitNumber: 'SCENARIO-READY', origin: '', destination: '' }),
    undefined,
  )

  const fixed = buildOverviewRoutes({
    jobs: [],
    history,
    examplePermits: sampleTestPermits,
    geometryPermits: geometryTestPermits,
  })
  const ready = fixed.find(r => r.permitNumber === 'SCENARIO-READY')
  assert.ok(ready)
  assert.equal(ready.gpxFile, '/test-permits/lubeck-rostock-a20.gpx')
  assert.equal(ready.permitId, 'scenario-ready')
  assert.equal(routeLacksMapGeometry(ready), false)

  const hof = fixed.find(r => r.id === 'Hof A9 → Bayreuth A9' || /Hof/i.test(r.title))
  assert.ok(hof)
  assert.equal(hof.gpxFile, '/test-permits/hof-bayreuth-a9.gpx')
  assert.equal(routeLacksMapGeometry(hof), false)
})

test('buildOverviewRoutes falls back to permit gpxFile when job GPX fails to parse', () => {
  const routes = buildOverviewRoutes({
    jobs: [
      job({
        id: 'job-bad-gpx',
        name: 'Broken GPX',
        permitNumber: 'SCENARIO-READY',
        origin: 'Lübeck A20',
        destination: 'Rostock A20',
        gpxContent: '<not-valid-gpx',
      }),
    ],
    history: [],
    examplePermits: sampleTestPermits,
    geometryPermits: geometryTestPermits,
  })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].geometry, null)
  assert.equal(routes[0].gpxFile, '/test-permits/lubeck-rostock-a20.gpx')
  assert.equal(routeLacksMapGeometry(routes[0]), false)
})
