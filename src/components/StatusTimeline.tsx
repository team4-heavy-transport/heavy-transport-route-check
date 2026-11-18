import { CheckCircle2, FileUp, MapPin, Play, ShieldCheck } from 'lucide-react'
import type { RouteCheckResult } from '../lib/routeCheck'

interface StatusTimelineProps {
  result: RouteCheckResult
  permitNumber?: string
  monitoring?: boolean
}

function osmRestrictionSummary(result: RouteCheckResult): string | null {
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

export default function StatusTimeline({ result, permitNumber, monitoring = false }: StatusTimelineProps) {
  const osmSummary = osmRestrictionSummary(result)
  const live = result.mode === 'live'
  const checkDetail = monitoring
    ? `${result.evidence.length} source${result.evidence.length === 1 ? '' : 's'} connected`
    : live
      ? (osmSummary || 'Live Autobahn + OSM check')
      : (result.mode === 'simulated' ? 'Simulated check' : 'Route check complete')

  const steps = [
    {
      icon: FileUp,
      label: 'Route imported',
      detail: permitNumber || 'GPX file loaded',
      completed: true,
    },
    {
      icon: MapPin,
      label: 'Route checked',
      detail: osmSummary
        ? `${result.evidence.length} items · ${osmSummary}`
        : `${result.evidence.length} item${result.evidence.length === 1 ? '' : 's'} found`,
      completed: true,
    },
    {
      icon: Play,
      label: monitoring ? 'Monitoring live' : 'Check complete',
      detail: checkDetail,
      completed: true,
    },
    {
      icon: ShieldCheck,
      label: 'Dispatch decision',
      detail: result.title,
      completed: true,
    },
  ]

  return (
    <div className="status-timeline" role="region" aria-label="Route monitoring progress">
      {steps.map((step, index) => (
        <div key={index} className={`status-timeline-step ${step.completed ? 'completed' : ''}`}>
          <div className="status-timeline-icon">
            <step.icon size={18} />
          </div>
          <div className="status-timeline-content">
            <strong>{step.label}</strong>
            <p>{step.detail}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
