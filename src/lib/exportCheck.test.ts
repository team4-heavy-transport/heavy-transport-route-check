import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RouteEvidence } from '../data/routeChecks.ts'
import { exportFilename, pdfBytesFromSnapshot, snapshotFromResult, snapshotToCsv } from './exportCheck.ts'
import type { RouteCheckResult } from './routeCheck.ts'
import { applySiteAcknowledgements } from './siteAcknowledgements.ts'

function decodePdfStrings(buffer: ArrayBuffer | Uint8Array) {
  const latin1 = Buffer.from(new Uint8Array(buffer)).toString('latin1')
  const strings: string[] = []
  const re = /\((?:\\.|[^\\)])*\)/g
  let match
  while ((match = re.exec(latin1))) {
    strings.push(
      match[0]
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
        .replace(/\\(.)/g, '$1'),
    )
  }
  return { text: strings.join('\n'), compact: strings.join('').replace(/\s+/g, ' ') }
}

function verifyItem(id: string, title: string, detail = 'Lane restriction on the permitted corridor.'): RouteEvidence {
  return {
    id,
    title,
    detail,
    source: 'Autobahn GmbH',
    age: '',
    confidence: 'medium',
    state: 'warning',
    category: 'roadworks',
    blocker: true,
  }
}

function baseResult(evidence: RouteEvidence[]): RouteCheckResult {
  return {
    verdict: 'VERIFY',
    title: 'Verification required – potential issue detected',
    summary: `${evidence.length} unresolved VERIFY items.`,
    impact: `Selected vehicle: 3.20m W x 4.50m H x 28.5m L · 60t. ${evidence.length} unresolved VERIFY items.`,
    confidence: 'medium',
    issueCount: evidence.length,
    evidence,
    route: { coordinates: [], origin: 'Hamburg', destination: 'Hannover', distance: 140, corridor: 'A7' },
    degraded: false,
    retrievedAt: '2026-11-09T12:00:00Z',
    source: 'Autobahn GmbH',
  }
}

test('PDF and CSV after dispatcher acks list confirmations, not unresolved VERIFY', () => {
  const evidence = [
    verifyItem('v1', 'A7 roadworks near Soltau'),
    verifyItem('v2', 'A7 lane shift near Hannover'),
    verifyItem('v3', 'Temporary speed limit'),
    verifyItem('v4', 'Bridge works on corridor'),
  ]
  const overlaid = applySiteAcknowledgements(
    baseResult(evidence),
    evidence.map(item => ({
      evidenceId: item.id,
      acknowledgedBy: 'Ada Dispatcher',
      acknowledgedAt: '2026-11-09T12:00:00Z',
    })),
    true,
  )
  assert.equal(overlaid.verdict, 'READY')
  assert.match(overlaid.summary, /4 VERIFY items confirmed on site by Ada Dispatcher at/)
  assert.doesNotMatch(overlaid.impact, /unresolved VERIFY/)

  const snapshot = snapshotFromResult(overlaid, { permitNumber: 'DE-HH-2026-01845', permitName: 'Hamburg → Hannover' })
  assert.match(snapshot.summary, /4 VERIFY items confirmed on site by Ada Dispatcher at/)
  assert.doesNotMatch(snapshot.impact, /unresolved VERIFY/)
  assert.equal(snapshot.onSiteConfirmations.length, 4)

  const extracted = decodePdfStrings(pdfBytesFromSnapshot(snapshot))
  assert.match(extracted.compact, /4 VERIFY items confirmed on site by Ada Dispatcher at/)
  assert.doesNotMatch(extracted.compact, /unresolved VERIFY/)
  assert.match(extracted.compact, /Confirmed on site by Ada Dispatcher/)
  assert.match(extracted.compact, /A7 roadworks near Soltau/)
  assert.match(extracted.compact, /confirmed by Ada Dispatcher at/)

  const csv = snapshotToCsv(snapshot)
  assert.match(csv, /4 VERIFY items confirmed on site by Ada Dispatcher at/)
  assert.doesNotMatch(csv, /unresolved VERIFY/)
  assert.match(csv, /On-site confirmation title/)
  assert.match(csv, /Ada Dispatcher/)
  assert.match(csv, /A7 roadworks near Soltau/)
})

test('PDF and CSV keep one de-DE date, reflect result-screen clearance, and name files from READY', () => {
  const evidence = [
    verifyItem('v1', 'A7 roadworks near Soltau'),
    verifyItem('v2', 'A7 lane shift near Hannover'),
    verifyItem('v3', 'Temporary speed limit'),
    verifyItem('v4', 'Bridge works on corridor'),
    {
      id: 'bridge-clearance-unknown',
      title: 'Bridge and clearance data not available',
      detail: 'Unknown clearance cannot yield READY — confirm on site or tick dispatcher confirmation.',
      source: 'Route check system',
      age: '',
      confidence: 'medium' as const,
      state: 'warning' as const,
      category: 'observations' as const,
      blocker: true,
    },
  ]
  const raw = baseResult(evidence)
  raw.impact = 'Selected vehicle: 3.20m W x 4.50m H x 28.5m L · 60t. 4 unresolved VERIFY items. Bridge and clearance are not dispatcher-confirmed.'
  raw.summary = 'Bridge and clearance are not dispatcher-confirmed.'
  raw.clearanceConfirmed = false
  const overlaid = applySiteAcknowledgements(
    raw,
    evidence.filter(item => item.id !== 'bridge-clearance-unknown').map(item => ({
      evidenceId: item.id,
      acknowledgedBy: 'QA Test',
      acknowledgedAt: '2026-11-09T12:00:00Z',
    })),
    true,
    { by: 'QA Test', at: '2026-11-09T12:00:00Z' },
  )
  assert.equal(overlaid.verdict, 'READY')
  const snapshot = snapshotFromResult(overlaid, { permitNumber: 'DE-HH-2026-01845', permitName: 'Hamburg → Hannover' })
  assert.equal(exportFilename(snapshot, 'csv'), 'route-check-DE-HH-2026-01845-READY.csv')
  assert.equal(exportFilename(snapshot, 'pdf'), 'route-check-DE-HH-2026-01845-READY.pdf')
  assert.doesNotMatch(exportFilename(snapshot, 'csv'), /HOLD/)

  const extracted = decodePdfStrings(pdfBytesFromSnapshot(snapshot))
  assert.match(extracted.compact, /4 VERIFY items confirmed on site by QA Test at/)
  assert.match(extracted.compact, /09\.11\.2026/)
  assert.doesNotMatch(extracted.compact, /11\.09\.2026/)
  assert.match(extracted.compact, /Clearance confirmed by QA Test at/)
  assert.match(extracted.compact, /Bridge and clearance confirmed by dispatcher/)
  assert.doesNotMatch(extracted.compact, /Bridge and clearance are not dispatcher-confirmed/)
  assert.doesNotMatch(extracted.compact, /Bridge and clearance data not available/)

  const csv = snapshotToCsv(snapshot)
  assert.match(csv, /4 VERIFY items confirmed on site by QA Test at/)
  assert.match(csv, /09\.11\.2026/)
  assert.doesNotMatch(csv, /11\.09\.2026/)
  assert.match(csv, /Clearance confirmed by QA Test at/)
  assert.doesNotMatch(csv, /Bridge and clearance are not dispatcher-confirmed/)
  assert.doesNotMatch(csv, /"Impact".*data not available/)
  const csvImpact = (csv.split('\n').find(row => row.startsWith('"Impact",')) || '').replace(/^"Impact",/, '')
  assert.equal((csvImpact.match(/Clearance confirmed by QA Test at/g) || []).length, 1)
  const pdfImpact = extracted.compact.slice(
    extracted.compact.indexOf('Selected vehicle:'),
    extracted.compact.indexOf('Permit'),
  )
  assert.equal((pdfImpact.match(/Clearance confirmed by QA Test at/g) || []).length, 1)
})

test('export uses the displayed retrievedAt and never writes start Start', () => {
  const displayed = baseResult([
    verifyItem('e1', 'A7 works', 'Start: not published. Lane restriction on the permitted corridor.'),
  ])
  displayed.retrievedAt = '2026-11-09T21:50:00.000Z'
  displayed.route = { ...displayed.route, origin: 'Start', destination: 'End' }
  displayed.evidence[0].startTimestamp = null
  displayed.evidence[0].age = 'Start: not published · Retrieved 09.11.2026, 21:12'
  displayed.evidence[0].retrievedAt = '2026-11-09T21:12:00.000Z'
  const snapshot = snapshotFromResult(displayed, {
    permitName: 'Hamburg → Hannover',
    runAt: '2026-11-09T21:12:00.000Z',
  })
  assert.equal(snapshot.retrievedAt, displayed.retrievedAt)
  assert.equal(snapshot.runAt, displayed.retrievedAt)
  assert.equal(snapshot.evidence[0].start, 'Start: not published')
  assert.equal(snapshot.routeLabel, 'Origin → Destination')

  const pdf = decodePdfStrings(pdfBytesFromSnapshot(snapshot))
  assert.match(pdf.compact, /Start: not published/)
  assert.doesNotMatch(pdf.compact, /start\s+Start/i)
  assert.doesNotMatch(pdf.compact, /Start:\s*Start/)
  assert.match(pdf.compact, /21:50|09\.11\.2026/)

  const csv = snapshotToCsv(snapshot)
  assert.match(csv, /Start: not published/)
  assert.doesNotMatch(csv, /start Start/i)
  assert.doesNotMatch(csv, /Start: Start/)
})

test('PDF wraps long evidence titles instead of clipping them', () => {
  const title = 'Entwässerungsarbeiten auf der Fahrbahn der A7 Richtung Hannover in Fahrtrichtung Süd bei länger andauernder Baustelle'
  const snapshot = snapshotFromResult(baseResult([
    verifyItem('long', title, 'Detail text that must wrap inside the evidence card without overlapping the next card edge.'),
  ]), { permitName: 'Hamburg → Hannover' })
  const extracted = decodePdfStrings(pdfBytesFromSnapshot(snapshot))
  assert.match(extracted.compact, /Roadworks/)
  assert.match(extracted.compact, /Entwässerungsarbeiten/)
  assert.match(extracted.compact, /andauernder Baustelle/)
  assert.match(extracted.text, /Fahrtrichtung Süd/)
})

test('PDF and CSV list OSM clearance conflicts, unknown bridges, and ODbL attribution', () => {
  const evidence: RouteEvidence[] = [
    {
      id: 'bridge-clearance-osm',
      title: 'OSM clearance: 2 restrictions exceeded',
      detail: '0 restrictions checked OK · 2 conflicts · 1 bridges/tunnels without data. © OpenStreetMap contributors. Data available under the Open Database License (ODbL). Crowd-sourced — not authoritative for dispatch.',
      source: 'OpenStreetMap (Overpass) · ODbL',
      age: '',
      confidence: 'high',
      state: 'warning',
      category: 'observations',
      blocker: false,
    },
    {
      id: 'osm-conflict-way-4288068-maxheight',
      title: 'Height limit 3.6 m vs vehicle 4.5 m',
      detail: 'Tunnel · Tumblingerstraße: OSM maxheight=3.6 (3.6 m) vs vehicle 4.5 m. © OpenStreetMap contributors. Data available under the Open Database License (ODbL).',
      source: 'OpenStreetMap (Overpass) · ODbL',
      age: '',
      confidence: 'high',
      state: 'danger',
      category: 'observations',
      blocker: true,
    },
    {
      id: 'osm-unknown-way-99',
      title: 'Bridge · Testbrücke — no clearance data',
      detail: 'OSM marks this as a bridge without maxheight/maxweight tags. Confirm with permit or authority. © OpenStreetMap contributors. Data available under the Open Database License (ODbL).',
      source: 'OpenStreetMap (Overpass) · ODbL',
      age: '',
      confidence: 'medium',
      state: 'warning',
      category: 'observations',
      blocker: false,
    },
  ]
  const raw = baseResult(evidence)
  raw.verdict = 'HOLD'
  raw.title = 'Hold departure – blocking issue on route'
  raw.summary = '1 blocking issue on the permitted mainline.'
  raw.source = 'Autobahn GmbH + OpenStreetMap'
  const snapshot = snapshotFromResult(raw, { permitName: 'munich-low-clearance.gpx' })
  assert.equal(snapshot.evidence.length, 3)

  const csv = snapshotToCsv(snapshot)
  assert.match(csv, /OSM clearance: 2 restrictions exceeded/)
  assert.match(csv, /Height limit 3\.6 m vs vehicle 4\.5 m/)
  assert.match(csv, /Bridge · Testbrücke — no clearance data|Bridge ·Testbrücke/)
  assert.match(csv, /OpenStreetMap \(Overpass\) · ODbL|OpenStreetMap/)
  assert.match(csv, /ODbL/)
  assert.doesNotMatch(csv, /Open – Street – Map/)
  assert.doesNotMatch(csv, /ODb – L/)

  const extracted = decodePdfStrings(pdfBytesFromSnapshot(snapshot))
  assert.match(extracted.compact, /OSM clearance: 2 restrictions exceeded/)
  assert.match(extracted.compact, /Height limit 3\.6 m vs vehicle 4\.5 m/)
  assert.match(extracted.compact, /no clearance data/)
  assert.match(extracted.compact, /OpenStreetMap/)
  assert.match(extracted.compact, /ODbL/)
  assert.doesNotMatch(extracted.compact, /Open\s*-\s*Street\s*-\s*Map/)
  assert.doesNotMatch(extracted.compact, /ODb\s*-\s*L/)
})
