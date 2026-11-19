import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatVerdictCheckedMeta } from './verdictMeta.ts'
import { checkCompleteDetail, osmRestrictionSummary } from './statusTimelineDetail.ts'

test('formatVerdictCheckedMeta shows Berlin date/time and sources', () => {
  const meta = formatVerdictCheckedMeta(
    '2026-11-18T22:46:00Z',
    'Autobahn GmbH + MobiData BW + OpenStreetMap',
  )
  assert.match(meta, /^Last checked /)
  assert.match(meta, /18\.11\.2026/)
  assert.match(meta, /Autobahn GmbH \+ MobiData BW \+ OpenStreetMap/)
  assert.equal(formatVerdictCheckedMeta('not-a-date', ''), '')
  assert.equal(formatVerdictCheckedMeta(null, 'Autobahn GmbH'), 'Autobahn GmbH')
})

test('checkCompleteDetail uses OSM summary for live results (not Static check)', () => {
  const liveOsm = {
    mode: 'live' as const,
    evidence: [
      { id: 'bridge-clearance-osm', title: 'OSM clearance: 2 restrictions exceeded' },
    ],
  }
  assert.equal(checkCompleteDetail(liveOsm), 'OSM: 2 restrictions exceeded')
  assert.equal(
    checkCompleteDetail({ mode: 'live', evidence: [] }),
    'Live Autobahn + OSM check',
  )
  assert.equal(
    checkCompleteDetail({ mode: 'simulated', evidence: [] }),
    'Simulated check',
  )
  assert.doesNotMatch(checkCompleteDetail(liveOsm), /Static check/i)
})

test('osmRestrictionSummary counts conflict and unknown markers', () => {
  const summary = osmRestrictionSummary({
    evidence: [
      { id: 'osm-conflict-1' },
      { id: 'osm-conflict-2' },
      { id: 'osm-unknown-1' },
    ],
  })
  assert.equal(summary, 'OSM: 2 restrictions exceeded · 1 untagged bridge/tunnel')
})
