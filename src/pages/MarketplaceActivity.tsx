import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle, BellRing, CheckCircle2, ChevronDown, ChevronRight, CircleX, Download, History, Route, Plus,
} from 'lucide-react'
import PageHeader from '../components/PageHeader'
import { useRouteMonitoring, type CheckHistoryRecord, type MonitoringAlert } from '../context/RouteMonitoringContext'
import { alertMatchesRouteFilter, historyMatchesRouteFilter } from '../lib/activityFilter'
import { formatBerlinDateTime } from '../lib/formatTime'
import { downloadSnapshot, snapshotFromHistory } from '../lib/exportCheck'
import { groupActivityByRoute, isDemoOrSimulatedSource } from '../lib/routeActivityGroups'

const filters = ['All', 'Hold', 'Verify', 'Resolved'] as const

export default function MarketplaceActivity() {
  const [filter, setFilter] = useState<(typeof filters)[number]>('All')
  const [routeFilter, setRouteFilter] = useState('all')
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({})
  const { alerts, history, acknowledgeAlert, resolveAlert, recordCheck, addAlert } = useRouteMonitoring()
  const navigate = useNavigate()
  const routeOptions = Array.from(new Set(history.map(record => record.permitName).filter(Boolean)))
  const shown = alerts.filter(alert => {
    const matchesRoute = alertMatchesRouteFilter(alert, routeFilter, history)
    const matchesFilter = filter === 'All'
      || filter === 'Hold' && alert.severity === 'HOLD'
      || filter === 'Verify' && alert.severity === 'VERIFY'
      || filter === 'Resolved' && alert.status === 'Resolved'
    return matchesRoute && matchesFilter
  })
  const shownHistory = history.filter(record => historyMatchesRouteFilter(record, routeFilter))

  const routeGroups = useMemo(
    () => groupActivityByRoute(shownHistory, shown),
    [shownHistory, shown],
  )
  const alertGroups = useMemo(
    () => routeGroups.filter(group => group.alerts.length > 0),
    [routeGroups],
  )
  const historyGroups = useMemo(
    () => routeGroups.filter(group => group.history.length > 0),
    [routeGroups],
  )

  const toggleExpanded = (key: string) => {
    setExpandedKeys(current => ({ ...current, [key]: !current[key] }))
  }

  return (
    <div className="market-page route-alert-page">
      <PageHeader
        eyebrow="Live route monitoring"
        title="Alerts & history"
        description="Alerts and history come only from route checks you ran with this account, plus their Autobahn GmbH results."
      />
      <p className="storage-note activity-storage-note">History is saved to your account.</p>

      <div className="route-alert-filters">
        <div className="activity-filters" role="group" aria-label="Alert severity">
          {filters.map(item => (
            <button type="button" key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>
              {item}
            </button>
          ))}
        </div>
        <div className="route-alert-filter-row">
          <label>
            <span>Route</span>
            <select value={routeFilter} onChange={event => setRouteFilter(event.target.value)}>
              <option value="all">All permitted routes</option>
              {routeOptions.map(name => (
                <option value={name} key={name}>{name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-text load-demo-btn"
            onClick={() => {
              const now = new Date()
              const hour = 3600000
              const demoSource = 'Simulated — not live data'
              
              // Sample 1: HOLD alert from 2 hours ago
              const holdCheck = recordCheck({
                permitName: 'Mannheim to Freiburg',
                routeLabel: 'A5 Karlsruhe → Basel',
                runAt: new Date(now.getTime() - 2 * hour).toISOString(),
                verdict: 'HOLD',
                evidenceCount: 3,
                retrievedAt: new Date(now.getTime() - 2 * hour).toISOString(),
                source: demoSource,
                summary: 'Full closure detected on mainline',
                alertEligible: true,
              })
              
              addAlert({
                runAt: holdCheck.runAt,
                routeId: holdCheck.id,
                routeLabel: holdCheck.routeLabel,
                change: 'Demo: READY → HOLD',
                detail: 'Full carriageway closure detected near AS Baden-Baden',
                severity: 'HOLD',
                status: 'New',
                source: demoSource,
                previousVerdict: 'READY',
                nextVerdict: 'HOLD',
              })
              
              // Sample 2: VERIFY alert from 45 minutes ago
              const verifyCheck = recordCheck({
                permitName: 'Stuttgart to Karlsruhe',
                routeLabel: 'A8 Stuttgart → Karlsruhe',
                runAt: new Date(now.getTime() - 45 * 60000).toISOString(),
                verdict: 'VERIFY',
                evidenceCount: 2,
                retrievedAt: new Date(now.getTime() - 45 * 60000).toISOString(),
                source: demoSource,
                summary: 'Width limit requires verification',
                alertEligible: true,
              })
              
              addAlert({
                runAt: verifyCheck.runAt,
                routeId: verifyCheck.id,
                routeLabel: verifyCheck.routeLabel,
                change: 'Demo: READY → VERIFY',
                detail: 'Roadworks with 3.2m width limit detected',
                severity: 'VERIFY',
                status: 'New',
                source: demoSource,
                previousVerdict: 'READY',
                nextVerdict: 'VERIFY',
              })
              
              // Sample 3: Resolved VERIFY from yesterday
              recordCheck({
                permitName: 'Frankfurt to Mannheim',
                routeLabel: 'A67 Darmstadt → Mannheim',
                runAt: new Date(now.getTime() - 24 * hour).toISOString(),
                verdict: 'READY',
                evidenceCount: 0,
                retrievedAt: new Date(now.getTime() - 24 * hour).toISOString(),
                source: demoSource,
                summary: 'Route clear',
                alertEligible: false,
              })
            }}
          >
            <Plus size={16} />
            Load demo history
          </button>
        </div>
      </div>

      <section className="route-alert-log" data-testid="alerts-by-route">
        <header>
          <div><BellRing size={20} /><h2>Alerts by route</h2></div>
          <span>{alertGroups.length} route{alertGroups.length === 1 ? '' : 's'} · {shown.length} alerts</span>
        </header>
        {alertGroups.map((group, index) => {
          const Icon = group.latestVerdict === 'HOLD' ? CircleX : group.latestVerdict === 'VERIFY' ? AlertTriangle : CheckCircle2
          const expanded = Boolean(expandedKeys[group.key])
          const openAlert = group.alerts.find(alert => alert.status !== 'Resolved')
          const historyCount = group.history.length
          const alertCount = group.alerts.length
          return (
            <article
              className={`route-alert-group severity-${group.latestVerdict.toLowerCase()}`}
              key={group.key}
              data-testid="route-alert-group"
              data-route-key={group.key}
            >
              <div className="route-alert-group-header">
                <button
                  type="button"
                  className="route-alert-main"
                  aria-expanded={expanded}
                  onClick={() => toggleExpanded(group.key)}
                >
                  <span className="route-alert-icon"><Icon size={19} /></span>
                  <div>
                    <span className="route-alert-meta">
                      <b>Route {index + 1}: {group.label}</b>
                      <small>
                        Last checked {formatBerlinDateTime(group.lastCheckedAt) || '—'}
                        {group.isDemo ? ' · Simulated — not live data' : ''}
                      </small>
                    </span>
                    <strong>
                      Latest: {group.latestVerdict}
                      {group.latestAlert ? ` · ${group.latestAlert.change}` : ''}
                    </strong>
                    <p>
                      {historyCount} check{historyCount === 1 ? '' : 's'}
                      {alertCount ? ` · ${alertCount} alert${alertCount === 1 ? '' : 's'}` : ''}
                      {group.latestHistory?.summary ? ` · ${group.latestHistory.summary}` : group.latestAlert?.detail ? ` · ${group.latestAlert.detail}` : ''}
                    </p>
                  </div>
                  <span className="route-alert-badges">
                    <span className={`alert-status ${group.latestVerdict.toLowerCase()}`}>{group.latestVerdict}</span>
                    {group.isDemo && (
                      <span className="alert-status demo" title="Demo / simulated">Simulated</span>
                    )}
                    {group.latestAlert?.escalated && (
                      <span className="alert-status escalated" title="Escalated" aria-label="Escalated">Escalated</span>
                    )}
                  </span>
                  {expanded ? <ChevronDown size={18} className="route-alert-chevron" aria-hidden="true" /> : <ChevronRight size={18} className="route-alert-chevron" aria-hidden="true" />}
                </button>
                {openAlert && (
                  <button type="button" className="resolve-alert" onClick={() => resolveAlert(openAlert.id)}>
                    Mark resolved
                  </button>
                )}
              </div>

              {expanded && (
                <div className="route-alert-group-history" data-testid="route-alert-history">
                  {group.alerts.map(alert => (
                    <AlertHistoryRow
                      key={`alert-${alert.id}`}
                      alert={alert}
                      onOpen={() => {
                        acknowledgeAlert(alert.id)
                        navigate('/route-checks')
                      }}
                      onResolve={() => resolveAlert(alert.id)}
                    />
                  ))}
                  {group.history.map(record => (
                    <HistoryRow
                      key={`history-${record.id}`}
                      record={record}
                      onOpen={() => navigate('/route-checks')}
                    />
                  ))}
                </div>
              )}
            </article>
          )
        })}
        {!alertGroups.length && (
          <div className="market-empty">
            <Route size={30} />
            <h2>{history.length ? 'Nothing in this view' : 'No alerts yet'}</h2>
            <p>{history.length ? 'No saved-check alerts match the selected filters.' : 'Run a route check to create an alert. Example Overview data does not appear here.'}</p>
          </div>
        )}
      </section>

      <section className="route-alert-log check-history-log" data-testid="check-history-by-route">
        <header>
          <div><History size={20} /><h2>Check history by route</h2></div>
          <span>{historyGroups.length} route{historyGroups.length === 1 ? '' : 's'} · {shownHistory.length} checks</span>
        </header>
        {historyGroups.map((group, index) => {
          const Icon = group.latestVerdict === 'HOLD' ? CircleX : group.latestVerdict === 'VERIFY' ? AlertTriangle : CheckCircle2
          const expanded = Boolean(expandedKeys[`history:${group.key}`])
          return (
            <article className={`route-alert-group severity-${group.latestVerdict.toLowerCase()}`} key={`history-group-${group.key}`}>
              <div className="route-alert-group-header">
                <button
                  type="button"
                  className="route-alert-main"
                  aria-expanded={expanded}
                  onClick={() => toggleExpanded(`history:${group.key}`)}
                >
                  <span className="route-alert-icon"><Icon size={19} /></span>
                  <div>
                    <span className="route-alert-meta">
                      <b>Route {index + 1}: {group.label}</b>
                      <small>Last checked {formatBerlinDateTime(group.lastCheckedAt) || '—'}</small>
                    </span>
                    <strong>{group.latestVerdict} · {group.history.length} check{group.history.length === 1 ? '' : 's'}</strong>
                    <p>{group.latestHistory?.summary || 'No summary'} · latest source {group.latestHistory?.source || '—'}</p>
                  </div>
                  <span className="route-alert-badges">
                    <span className={`alert-status ${group.latestVerdict.toLowerCase()}`}>{group.latestVerdict}</span>
                    {group.isDemo && <span className="alert-status demo">Simulated</span>}
                  </span>
                  {expanded ? <ChevronDown size={18} className="route-alert-chevron" aria-hidden="true" /> : <ChevronRight size={18} className="route-alert-chevron" aria-hidden="true" />}
                </button>
              </div>
              {expanded && (
                <div className="route-alert-group-history">
                  {group.history.map(record => (
                    <HistoryRow
                      key={record.id}
                      record={record}
                      onOpen={() => navigate('/route-checks')}
                    />
                  ))}
                </div>
              )}
            </article>
          )
        })}
        {!history.length && (
          <div className="market-empty">
            <History size={30} />
            <h2>No checks yet</h2>
            <p>When a route check finishes, a record is saved here with the permit name, time, verdict, evidence count, and data retrieved-at.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function AlertHistoryRow({
  alert,
  onOpen,
  onResolve,
}: {
  alert: MonitoringAlert
  onOpen: () => void
  onResolve: () => void
}) {
  const Icon = alert.severity === 'HOLD' ? CircleX : alert.severity === 'VERIFY' ? AlertTriangle : CheckCircle2
  const demo = isDemoOrSimulatedSource(alert.source, alert.change)
  return (
    <div className={`route-alert-item nested severity-${alert.severity.toLowerCase()}`}>
      <button type="button" className="route-alert-main" onClick={onOpen}>
        <span className="route-alert-icon"><Icon size={19} /></span>
        <div>
          <span className="route-alert-meta">
            <b>{alert.routeLabel}</b>
            <small>{alert.source} · {formatBerlinDateTime(alert.runAt)}</small>
          </span>
          <strong>{alert.change}</strong>
          <p>{alert.detail}</p>
        </div>
        <span className="route-alert-badges">
          <span className={`alert-status ${alert.status.toLowerCase()}`}>{alert.status}</span>
          {demo && <span className="alert-status demo">Simulated</span>}
          {alert.escalated && (
            <span className="alert-status escalated" title="Escalated" aria-label="Escalated">Escalated</span>
          )}
        </span>
        <ChevronRight size={18} className="route-alert-chevron" aria-hidden="true" />
      </button>
      {alert.status !== 'Resolved' && (
        <button type="button" className="resolve-alert" onClick={onResolve}>Mark resolved</button>
      )}
    </div>
  )
}

function HistoryRow({
  record,
  onOpen,
}: {
  record: CheckHistoryRecord
  onOpen: () => void
}) {
  const Icon = record.verdict === 'HOLD' ? CircleX : record.verdict === 'VERIFY' ? AlertTriangle : CheckCircle2
  const demo = isDemoOrSimulatedSource(record.source)
  return (
    <div className={`route-alert-item nested severity-${record.verdict.toLowerCase()}`}>
      <button type="button" className="route-alert-main" onClick={onOpen}>
        <span className="route-alert-icon"><Icon size={19} /></span>
        <div>
          <span className="route-alert-meta">
            <b>{record.permitName}</b>
            <small>{record.source} · {formatBerlinDateTime(record.runAt)}</small>
          </span>
          <strong>{record.verdict} · {record.routeLabel}</strong>
          <p>{record.summary} · {record.evidenceCount} evidence · retrieved {formatBerlinDateTime(record.retrievedAt)}</p>
          {record.actionsLog?.length ? (
            <p data-testid="history-actions-log">{record.actionsLog.join(' · ')}</p>
          ) : null}
        </div>
        <span className="route-alert-badges">
          <span className={`alert-status ${record.verdict.toLowerCase()}`}>{record.verdict}</span>
          {demo && <span className="alert-status demo">Simulated</span>}
        </span>
        <ChevronRight size={18} className="route-alert-chevron" aria-hidden="true" />
      </button>
      <div className="history-export-actions">
        <button type="button" className="resolve-alert" onClick={() => downloadSnapshot(snapshotFromHistory(record), 'pdf')}>
          <Download size={14} /> PDF
        </button>
        <button type="button" className="resolve-alert" onClick={() => downloadSnapshot(snapshotFromHistory(record), 'csv')}>
          <Download size={14} /> CSV
        </button>
      </div>
    </div>
  )
}
