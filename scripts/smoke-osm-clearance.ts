import { readFileSync } from 'node:fs'
import { buildOverpassQuery, checkOsmClearance } from '../api/_lib/osmClearance.ts'
import { parseGpxDocument } from '../api/_lib/gpxParse.ts'

async function main() {
  const gpx = readFileSync(new URL('../public/samples/munich-low-clearance.gpx', import.meta.url), 'utf8')
  const points = parseGpxDocument(gpx).points.map(point => ({ lat: point.lat, lng: point.lng }))
  console.log(buildOverpassQuery(points).slice(0, 280))
  const result = await checkOsmClearance({
    points,
    vehicle: { width: 3.5, height: 4.5, length: 30, grossWeight: 80 },
    timeoutMs: 45000,
  })
  console.log(JSON.stringify({
    ok: result.ok,
    error: result.error,
    hits: result.hits.length,
    conflicts: result.conflicts.map(item => `${item.kind}=${item.limit} vs ${item.vehicleValue}`),
    unknowns: result.unknownStructures.length,
    checkedOk: result.checkedOk,
    titles: result.evidence.slice(0, 8).map(e => e.title),
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
