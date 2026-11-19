type TimelineEvidence = { id?: string; title?: string }

type TimelineResult = {
  evidence: TimelineEvidence[]
  mode?: 'live' | 'simulated' | string
}

export function osmRestrictionSummary(result: Pick<TimelineResult, 'evidence'>): string | null {
  const summary = result.evidence.find(item => item.id === 'bridge-clearance-osm')
  if (summary?.title) return summary.title.replace(/^OSM clearance:\s*/i, 'OSM: ')
  const conflicts = result.evidence.filter(item => String(item.id).startsWith('osm-conflict-')).length
  const unknowns = result.evidence.filter(item => String(item.id).startsWith('osm-unknown-')).length
  if (!conflicts && !unknowns) return null
  const parts: string[] = []
  if (conflicts) parts.push(`${conflicts} restriction${conflicts === 1 ? '' : 's'} exceeded`)
  if (unknowns) parts.push(`${unknowns} untagged bridge${unknowns === 1 ? '' : 's'}/tunnel${unknowns === 1 ? '' : 's'}`)
  return `OSM: ${parts.join(' · ')}`
}

/** Detail under “Check complete” — never hardcode “Static check” for live OSM runs. */
export function checkCompleteDetail(
  result: Pick<TimelineResult, 'evidence' | 'mode'>,
  monitoring = false,
): string {
  if (monitoring) {
    return `${result.evidence.length} source${result.evidence.length === 1 ? '' : 's'} connected`
  }
  if (result.mode === 'live') {
    return osmRestrictionSummary(result) || 'Live Autobahn + OSM check'
  }
  if (result.mode === 'simulated') return 'Simulated check'
  return 'Route check complete'
}
