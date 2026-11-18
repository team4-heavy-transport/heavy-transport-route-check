import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildOsmClearanceEvidence,
  buildOverpassQuery,
  checkOsmClearance,
  compareHitToVehicle,
  elementToHit,
  parseOsmMapXml,
  parseOsmMeasure,
  type OsmRestrictionHit,
} from './osmClearance.js'
import { buildCorridorIndex } from './corridor.js'

test('parseOsmMeasure accepts metric, feet-inches, and unrestricted tokens', () => {
  assert.equal(parseOsmMeasure('4.2').value, 4.2)
  assert.equal(parseOsmMeasure('4.2 m').value, 4.2)
  assert.equal(parseOsmMeasure('4,2m').value, 4.2)
  assert.equal(parseOsmMeasure('12 t', 't').value, 12)
  assert.equal(parseOsmMeasure('12t', 't').value, 12)
  assert.ok(Math.abs((parseOsmMeasure(`14'6"`).value || 0) - (14 * 0.3048 + 6 * 0.0254)) < 0.001)
  assert.ok(Math.abs((parseOsmMeasure('10 ft').value || 0) - 3.048) < 0.001)
  assert.equal(parseOsmMeasure('none').unrestricted, true)
  assert.equal(parseOsmMeasure('default').unrestricted, true)
  assert.equal(parseOsmMeasure('unsigned').unrestricted, true)
  assert.equal(parseOsmMeasure('banana').unparsed, true)
  assert.equal(parseOsmMeasure('').value, null)
  assert.equal(parseOsmMeasure(null).raw, null)
})

test('compareHitToVehicle HOLDs when vehicle exceeds OSM limits', () => {
  const hit: OsmRestrictionHit = {
    osmType: 'way',
    osmId: 1,
    lat: 48.13,
    lng: 11.57,
    isBridge: true,
    isTunnel: false,
    tags: { maxheight: '4.0', maxweight: '40 t', maxwidth: '3.0' },
    distanceKm: 0.01,
  }
  const tall = compareHitToVehicle(hit, {
    width: 2.5,
    height: 4.3,
    length: 20,
    grossWeight: 30,
  })
  assert.equal(tall.conflicts.length, 1)
  assert.equal(tall.conflicts[0].kind, 'maxheight')
  assert.equal(tall.checkedOk, 2)

  const heavy = compareHitToVehicle(hit, {
    width: 2.5,
    height: 3.8,
    length: 20,
    grossWeight: 60,
  })
  assert.equal(heavy.conflicts.some(item => item.kind === 'maxweight'), true)

  const ok = compareHitToVehicle(hit, {
    width: 2.5,
    height: 3.8,
    length: 20,
    grossWeight: 30,
  })
  assert.equal(ok.conflicts.length, 0)
  assert.equal(ok.checkedOk, 3)
})

test('maxaxleload without vehicle axle data is uncompared, not HOLD', () => {
  const hit: OsmRestrictionHit = {
    osmType: 'way',
    osmId: 2,
    lat: 48.13,
    lng: 11.57,
    isBridge: true,
    isTunnel: false,
    tags: { maxaxleload: '10 t' },
    distanceKm: 0.01,
  }
  const result = compareHitToVehicle(hit, {
    width: 2.5,
    height: 4,
    length: 20,
    grossWeight: 40,
  })
  assert.equal(result.conflicts.length, 0)
  assert.deepEqual(result.uncompared, ['maxaxleload'])
})

test('buildOsmClearanceEvidence emits HOLD conflicts and VERIFY unknowns', () => {
  const hits: OsmRestrictionHit[] = [
    {
      osmType: 'way',
      osmId: 10,
      name: 'Low bridge',
      lat: 48.14,
      lng: 11.58,
      isBridge: true,
      isTunnel: false,
      tags: { maxheight: '3.5' },
      distanceKm: 0.02,
    },
    {
      osmType: 'way',
      osmId: 11,
      name: 'Undocumented bridge',
      lat: 48.15,
      lng: 11.59,
      isBridge: true,
      isTunnel: false,
      tags: {},
      distanceKm: 0.01,
    },
    {
      osmType: 'way',
      osmId: 12,
      lat: 48.16,
      lng: 11.60,
      isBridge: false,
      isTunnel: false,
      tags: { maxwidth: '4.0' },
      distanceKm: 0.01,
    },
  ]

  const built = buildOsmClearanceEvidence(hits, {
    width: 3.2,
    height: 4.2,
    length: 25,
    grossWeight: 60,
  }, '2026-11-18T12:00:00.000Z')

  assert.equal(built.conflicts.length, 1)
  assert.equal(built.unknownStructures.length, 1)
  assert.equal(built.checkedOk, 1)
  assert.ok(built.evidence.some(item => item.id.startsWith('osm-conflict-') && item.state === 'danger'))
  assert.ok(built.evidence.some(item => item.id.startsWith('osm-unknown-') && item.state === 'warning'))
  const summary = built.evidence.find(item => item.id === 'bridge-clearance-osm')
  assert.ok(summary)
  assert.equal(summary?.state, 'warning')
  assert.equal(summary?.blocker, false)
  assert.match(built.evidence[0].detail, /OpenStreetMap|ODbL/)
})

test('buildOsmClearanceEvidence all-clear still asks for dispatcher confirm', () => {
  const hits: OsmRestrictionHit[] = [{
    osmType: 'way',
    osmId: 20,
    lat: 48.14,
    lng: 11.58,
    isBridge: false,
    isTunnel: false,
    tags: { maxheight: '5.0' },
    distanceKm: 0.01,
  }]
  const built = buildOsmClearanceEvidence(hits, {
    width: 3,
    height: 4,
    length: 20,
    grossWeight: 40,
  }, '2026-11-18T12:00:00.000Z')
  assert.equal(built.conflicts.length, 0)
  assert.equal(built.unknownStructures.length, 0)
  assert.equal(built.evidence[0].id, 'bridge-clearance-unknown')
  assert.equal(built.evidence[0].blocker, true)
  assert.match(built.evidence[0].title, /checked OK/)
})

test('elementToHit drops features far from the corridor', () => {
  const corridor = buildCorridorIndex([
    { lat: 48.10, lng: 11.50 },
    { lat: 48.11, lng: 11.51 },
  ], 20)
  const near = elementToHit({
    type: 'way',
    id: 1,
    center: { lat: 48.1001, lon: 11.5001 },
    tags: { bridge: 'yes', maxheight: '4.0' },
  }, corridor)
  assert.ok(near)
  assert.equal(near?.isBridge, true)

  const far = elementToHit({
    type: 'way',
    id: 2,
    center: { lat: 48.30, lon: 11.80 },
    tags: { bridge: 'yes' },
  }, corridor)
  assert.equal(far, null)
})

test('buildOverpassQuery includes restriction and bridge selectors', () => {
  const query = buildOverpassQuery([
    { lat: 48.13, lng: 11.57 },
    { lat: 48.14, lng: 11.58 },
  ])
  assert.match(query, /maxheight/)
  assert.match(query, /maxweight/)
  assert.match(query, /around:\d+,/)
  assert.match(query, /\["bridge"\]/)
  assert.match(query, /\["tunnel"\]/)
  assert.match(query, /out center tags/)
})

test('checkOsmClearance falls back to VERIFY evidence when Overpass fails', async () => {
  const result = await checkOsmClearance({
    points: [
      { lat: 48.13, lng: 11.57 },
      { lat: 48.14, lng: 11.58 },
    ],
    vehicle: { width: 3, height: 4, length: 20, grossWeight: 40 },
    fetchImpl: async () => {
      throw new Error('network down')
    },
    endpoints: ['https://example.invalid/api/interpreter'],
    timeoutMs: 100,
    budgetMs: 1500,
  })
  assert.equal(result.ok, false)
  assert.equal(result.evidence[0].id, 'bridge-clearance-unknown')
  assert.equal(result.evidence[0].blocker, true)
  assert.match(result.evidence[0].detail, /failed|unavailable|network|budget/i)
})

test('parseOsmMapXml extracts ways with maxheight and bridge tags', () => {
  const xml = `
    <osm>
      <node id="1" lat="48.12163" lon="11.55416"/>
      <node id="2" lat="48.12170" lon="11.55420"/>
      <way id="4288068">
        <nd ref="1"/><nd ref="2"/>
        <tag k="highway" v="tertiary"/>
        <tag k="maxheight" v="3.6"/>
        <tag k="tunnel" v="yes"/>
        <tag k="name" v="Tumblingerstraße"/>
      </way>
    </osm>`
  const elements = parseOsmMapXml(xml)
  assert.equal(elements.length, 1)
  assert.equal(elements[0].id, 4288068)
  assert.equal(elements[0].tags?.maxheight, '3.6')
  assert.equal(elements[0].tags?.tunnel, 'yes')
  assert.ok(elements[0].center)
})

test('checkOsmClearance accepts injected Overpass elements', async () => {
  const result = await checkOsmClearance({
    points: [
      { lat: 48.13000, lng: 11.57000 },
      { lat: 48.13050, lng: 11.57050 },
    ],
    vehicle: { width: 3.5, height: 4.5, length: 30, grossWeight: 80 },
    elements: [{
      type: 'way',
      id: 99,
      center: { lat: 48.13010, lon: 11.57010 },
      tags: { bridge: 'yes', maxheight: '4.0', name: 'Testbrücke' },
    }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.conflicts.length, 1)
  const conflict = result.evidence.find(item => item.id.startsWith('osm-conflict-'))
  assert.ok(conflict)
  assert.equal(conflict?.state, 'danger')
  assert.match(conflict?.title || '', /Height limit/)
})
