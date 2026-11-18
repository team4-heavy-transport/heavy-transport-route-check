import { readFileSync, writeFileSync } from 'node:fs'
import { checkOsmClearance } from '../api/_lib/osmClearance.ts'
import { parseGpxDocument } from '../api/_lib/gpxParse.ts'
import { prepareRouteGeometry } from '../api/_lib/corridor.ts'

async function main() {
  const gpx = readFileSync('public/samples/luis-munich-cycling.gpx', 'utf8')
  const parsed = parseGpxDocument(gpx, { downsample: false })
  const geometry = prepareRouteGeometry(parsed.points)
  const vehicle = { width: 3.0, height: 4.0, length: 25, grossWeight: 52 }
  console.log(JSON.stringify({
    points: parsed.points.length,
    matchPoints: geometry.matchPoints.length,
    distanceKm: geometry.distanceKm,
  }))

  const result = await checkOsmClearance({
    points: geometry.matchPoints,
    vehicle,
    corridor: geometry.corridor,
    timeoutMs: 22000,
  })

  const summary = {
    ok: result.ok,
    error: result.error,
    hits: result.hits.length,
    conflicts: result.conflicts.map(c => ({
      kind: c.kind,
      limit: c.limit,
      vehicle: c.vehicleValue,
      name: c.hit.name,
      lat: c.hit.lat,
      lng: c.hit.lng,
    })),
    unknowns: result.unknownStructures.length,
    checkedOk: result.checkedOk,
    evidence: result.evidence.map(e => ({
      id: e.id,
      state: e.state,
      blocker: e.blocker,
      title: e.title,
      lat: e.lat,
      lng: e.lng,
    })),
  }
  writeFileSync('/tmp/luis-osm-result.json', JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
