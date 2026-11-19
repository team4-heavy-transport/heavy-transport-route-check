import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  groupActivityByRoute,
  isDemoOrSimulatedSource,
  routeGroupKey,
} from './routeActivityGroups.ts'

test('routeGroupKey prefers jobId, then permit number, then route label', () => {
  assert.equal(routeGroupKey({ jobId: 'job-1', permitNumber: 'P-9', routeLabel: 'A → B' }), 'job:job-1')
  assert.equal(routeGroupKey({ permitNumber: 'P-9', routeLabel: 'A → B' }), 'permit:P-9')
  assert.equal(routeGroupKey({ routeLabel: 'Hamburg Port → Hannover' }), 'route:hamburg port → hannover')
  assert.equal(routeGroupKey({ permitName: 'SCENARIO-HOLD' }), 'permitName:scenario-hold')
})

test('groupActivityByRoute collapses re-checks of the same route and keeps history', () => {
  const history = [
    {
      id: 'c1',
      jobId: 'job-hamburg',
      permitName: 'Hamburg permit',
      routeLabel: 'Hamburg Port Terminal → Hannover Logistics Hub',
      runAt: '2026-11-18T11:54:00Z',
      verdict: 'HOLD',
      source: 'Autobahn GmbH',
      summary: 'Blocking issue',
      evidenceCount: 1,
    },
    {
      id: 'c2',
      jobId: 'job-hamburg',
      permitName: 'Hamburg permit',
      routeLabel: 'Hamburg Port Terminal → Hannover Logistics Hub',
      runAt: '2026-11-18T11:18:00Z',
      verdict: 'HOLD',
      source: 'Autobahn GmbH',
      summary: 'Still blocked',
      evidenceCount: 2,
    },
    {
      id: 'c3',
      routeLabel: 'München Wind Farm → Stuttgart Industrial Complex',
      permitName: 'Munich permit',
      runAt: '2026-11-13T10:00:00Z',
      verdict: 'VERIFY',
      source: 'Simulated — not live data',
      summary: 'Demo verify',
      evidenceCount: 1,
    },
  ]

  const alerts = [
    {
      id: 'a1',
      routeId: 'job-hamburg',
      jobId: 'job-hamburg',
      routeLabel: 'Hamburg Port Terminal → Hannover Logistics Hub',
      runAt: '2026-11-18T11:54:00Z',
      severity: 'HOLD',
      status: 'New',
      change: 'Route check: HOLD',
      detail: '1 blocking issue',
      source: 'Autobahn GmbH',
    },
    {
      id: 'a2',
      routeId: 'job-hamburg',
      jobId: 'job-hamburg',
      routeLabel: 'Hamburg Port Terminal → Hannover Logistics Hub',
      runAt: '2026-11-18T11:18:00Z',
      severity: 'HOLD',
      status: 'New',
      change: 'Route check: HOLD',
      detail: 'Earlier check',
      source: 'Autobahn GmbH',
    },
  ]

  const groups = groupActivityByRoute(history, alerts)
  assert.equal(groups.length, 2)

  const hamburg = groups[0]
  assert.equal(hamburg.key, 'job:job-hamburg')
  assert.match(hamburg.label, /Hamburg Port/)
  assert.equal(hamburg.history.length, 2)
  assert.equal(hamburg.alerts.length, 2)
  assert.equal(hamburg.latestVerdict, 'HOLD')
  assert.equal(hamburg.lastCheckedAt, '2026-11-18T11:54:00Z')
  assert.equal(hamburg.latestHistory?.id, 'c1')
  assert.equal(hamburg.isDemo, false)

  const munich = groups[1]
  assert.equal(munich.isDemo, true)
  assert.equal(munich.history.length, 1)
  assert.equal(munich.alerts.length, 0)
})

test('isDemoOrSimulatedSource labels demo and simulated entries', () => {
  assert.equal(isDemoOrSimulatedSource('Simulated — not live data'), true)
  assert.equal(isDemoOrSimulatedSource('Autobahn GmbH', 'Demo: HOLD'), true)
  assert.equal(isDemoOrSimulatedSource('Autobahn GmbH + MobiData BW'), false)
})
