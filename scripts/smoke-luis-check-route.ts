import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

async function main() {
  const handler = (await import(resolve(process.cwd(), 'api/check-route.ts'))).default
  const gpxContent = readFileSync('public/samples/luis-munich-cycling.gpx', 'utf8')
  const fitting = process.argv.includes('--fitting')
  const vehicle = fitting
    ? { width: 1.9, height: 1.9, length: 4, grossWeight: 2.5 }
    : { width: 3.0, height: 4.0, length: 25, grossWeight: 52 }
  const req = {
    method: 'POST',
    headers: {},
    body: {
      gpxContent,
      vehicle,
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
    summary: result?.summary,
    source: result?.source,
    issueCount: result?.issueCount,
    evidenceCount: result?.evidence?.length,
    osm: osm.map((item: any) => ({
      id: item.id,
      state: item.state,
      blocker: item.blocker,
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
