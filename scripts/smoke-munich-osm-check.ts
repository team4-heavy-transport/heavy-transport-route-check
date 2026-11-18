import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

async function main() {
  const handler = (await import(resolve(process.cwd(), 'api/check-route.ts'))).default
  const gpxContent = readFileSync('public/samples/munich-low-clearance.gpx', 'utf8')
  const req = {
    method: 'POST',
    headers: {},
    body: {
      gpxContent,
      vehicle: { width: 3.5, height: 4.5, length: 30, grossWeight: 80 },
      corridor: 'A99',
      permittedRoads: ['A99'],
      bridgeClearanceConfirmed: false,
    },
  }
  const res: any = {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code: number) { this.statusCode = code; return this },
    json(data: unknown) { this.body = data },
  }
  await handler(req, res)
  const result = res.body
  const osm = (result?.evidence || []).filter((item: any) =>
    String(item.id).startsWith('osm-') || String(item.id).startsWith('bridge-clearance')
  )
  console.log(JSON.stringify({
    status: res.statusCode,
    verdict: result?.verdict,
    title: result?.title,
    source: result?.source,
    osmEvidence: osm.map((item: any) => ({
      id: item.id,
      state: item.state,
      title: item.title,
      lat: item.lat,
      lng: item.lng,
    })),
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
