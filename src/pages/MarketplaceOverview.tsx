import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleX,
  Expand,
  FileJson,
  Minimize2,
  Route,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import OverviewRoutesMap from '../components/OverviewRoutesMap'
import { useJobs } from '../context/JobsContext'
import { useRouteMonitoring } from '../context/RouteMonitoringContext'
import { formatBerlinDateTime } from '../lib/formatTime'
import { formatVehicleDims } from '../lib/jobs'
import {
  applyOverviewFiltersToSearch,
  buildOverviewRoutes,
  countByStatus,
  DEFAULT_OVERVIEW_FILTERS,
  filterOverviewRoutes,
  filtersAreActive,
  groupAlertsByStatus,
  parseOverviewFilters,
  type OverviewFilters,
  type OverviewRoute,
  type OverviewStatusFilter,
} from '../lib/overviewRoutes'
import { sampleTestPermits } from '../lib/routeCheck'

const verdictMeta = {
  READY: { label: 'Ready', icon: CheckCircle2, iconClass: 'green', badgeClass: 'ready' },
  HOLD: { label: 'Hold departure', icon: CircleX, iconClass: 'red', badgeClass: 'hold' },
  VERIFY: { label: 'Verify evidence', icon: AlertTriangle, iconClass: 'amber', badgeClass: 'verify' },
} as const

function StatusPill({ status }: { status: OverviewRoute['status'] }) {
  if (!status) return <b className="sample">Unchecked</b>
  const meta = verdictMeta[status]
  const Icon = meta.icon
  return (
    <b className={meta.badgeClass}>
      <Icon size={14} aria-hidden /> {meta.label}
    </b>
  )
}

function SummaryList({ items }: { items: OverviewRoute['summaryItems'] }) {
  if (!items.length) {
    return <p className="overview-summary-empty">No blocking items on the latest check.</p>
  }
  return (
    <ul className="overview-summary-list">
      {items.map(item => (
        <li key={item.id} className={`is-${item.severity.toLowerCase()}`}>
          <span className="overview-summary-dot" aria-hidden />
          <span>
            <span className="overview-summary-sev">{item.severity === 'HOLD' ? 'Hold' : item.severity === 'VERIFY' ? 'Verify' : 'Ready'}</span>
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  )
}

function OverviewFiltersBar({
  filters,
  counts,
  onChange,
  listCount,
}: {
  filters: OverviewFilters
  counts: ReturnType<typeof countByStatus>
  onChange: (next: OverviewFilters) => void
  listCount: number
}) {
  const toggleStatus = (status: OverviewStatusFilter) => {
    const has = filters.statuses.includes(status)
    onChange({
      ...filters,
      statuses: has ? filters.statuses.filter(s => s !== status) : [...filters.statuses, status],
    })
  }

  const active = filtersAreActive(filters)

  return (
    <div className="overview-filters" data-tour="overview-filters" role="group" aria-label="Filter routes">
      <div className="overview-filter-row">
        <span className="overview-filter-label">Status</span>
        <div className="overview-filter-chips" role="group" aria-label="Status">
          <button
            type="button"
            className={!filters.statuses.length ? 'is-active' : ''}
            aria-pressed={!filters.statuses.length}
            onClick={() => onChange({ ...filters, statuses: [] })}
          >
            All <span className="overview-filter-count">{counts.all}</span>
          </button>
          {(['READY', 'VERIFY', 'HOLD'] as const).map(status => (
            <button
              key={status}
              type="button"
              className={filters.statuses.includes(status) ? 'is-active' : ''}
              aria-pressed={filters.statuses.includes(status)}
              onClick={() => toggleStatus(status)}
            >
              {status === 'READY' ? 'Ready' : status === 'VERIFY' ? 'Verify evidence' : 'Hold departure'}
              <span className="overview-filter-count">{counts[status]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="overview-filter-row">
        <label className="overview-filter-label" htmlFor="overview-added">
          Date added
        </label>
        <select
          id="overview-added"
          value={filters.added}
          onChange={e => onChange({ ...filters, added: e.target.value as OverviewFilters['added'] })}
          data-tour="overview-filter-added"
        >
          <option value="any">Any time</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
      </div>

      <div className="overview-filter-row">
        <label className="overview-filter-label" htmlFor="overview-checked">
          Last checked
        </label>
        <select
          id="overview-checked"
          value={filters.checked}
          onChange={e => onChange({ ...filters, checked: e.target.value as OverviewFilters['checked'] })}
          data-tour="overview-filter-checked"
        >
          <option value="any">Any time</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="older7d">Older than 7 days</option>
        </select>
      </div>

      {active ? (
        <button
          type="button"
          className="overview-clear-filters"
          onClick={() => onChange(DEFAULT_OVERVIEW_FILTERS)}
        >
          Clear filters
        </button>
      ) : null}

      <p className="overview-filter-meta" data-testid="overview-filter-count">
        Showing {listCount} route{listCount === 1 ? '' : 's'}
      </p>
    </div>
  )
}

function RouteCard({
  route,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  route: OverviewRoute
  expanded: boolean
  selected: boolean
  onToggle: () => void
  onSelect: () => void
}) {
  const panelId = useId()
  return (
    <article
      className={`overview-route-card${selected ? ' is-selected' : ''}${route.source === 'example' ? ' is-example' : ''}`}
      data-route-id={route.id}
      data-testid={`overview-route-card-${route.id}`}
    >
      <button type="button" className="overview-route-card-main" onClick={onSelect}>
        <div>
          <strong>{route.title}</strong>
          <span>
            {route.origin} → {route.destination}
            {route.source === 'example' ? ' · Example' : ''}
          </span>
        </div>
        <StatusPill status={route.status} />
        <span className="overview-route-card-checked">
          {route.lastCheckedAt ? `Last checked ${formatBerlinDateTime(route.lastCheckedAt)}` : 'Not checked yet'}
        </span>
      </button>
      <button
        type="button"
        className="overview-route-show"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={event => {
          event.stopPropagation()
          onToggle()
        }}
      >
        {expanded ? 'Hide' : 'Show'}
      </button>
      {expanded ? (
        <div id={panelId} className="overview-route-card-details">
          {route.vehicle ? (
            <p><span>Vehicle</span> {formatVehicleDims(route.vehicle)}</p>
          ) : null}
          {route.permitNumber ? (
            <p><span>Permit</span> {route.permitNumber}</p>
          ) : null}
          <SummaryList items={route.summaryItems} />
          {route.source === 'job' ? (
            <Link to={`/route-checks?job=${route.id}&run=1`} className="overview-route-open">
              Open route check <ArrowRight size={14} aria-hidden />
            </Link>
          ) : route.permitId ? (
            <Link to={`/route-checks?permit=${route.permitId}`} className="overview-route-open">
              Open sample check <ArrowRight size={14} aria-hidden />
            </Link>
          ) : (
            <Link to="/route-checks" className="overview-route-open">
              Check this route <ArrowRight size={14} aria-hidden />
            </Link>
          )}
        </div>
      ) : null}
    </article>
  )
}

function FullSizeMapDialog({
  open,
  mode,
  onModeChange,
  routes,
  selectedId,
  onSelect,
  onClose,
  restoreFocusRef,
}: {
  open: boolean
  mode: 'all' | 'single'
  onModeChange: (mode: 'all' | 'single') => void
  routes: OverviewRoute[]
  selectedId: string | null
  onSelect: (id: string) => void
  onClose: () => void
  restoreFocusRef: React.RefObject<HTMLElement | null>
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const selected = routes.find(r => r.id === selectedId) || routes[0] || null
  const titleId = useId()
  const scrollY = useRef(0)

  useEffect(() => {
    if (!open) return
    scrollY.current = window.scrollY
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const node = dialogRef.current
    const focusables = () =>
      node
        ? Array.from(
            node.querySelectorAll<HTMLElement>(
              'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter(el => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true')
        : []

    queueMicrotask(() => {
      const first = focusables()[0]
      first?.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !node) return
      const list = focusables()
      if (!list.length) return
      const first = list[0]
      const last = list[list.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKeyDown)
      window.scrollTo(0, scrollY.current)
      restoreFocusRef.current?.focus()
    }
  }, [open, onClose, restoreFocusRef])

  if (!open) return null

  const alertGroups = selected ? groupAlertsByStatus(selected.alerts) : null

  return (
    <div
      ref={dialogRef}
      className="overview-fullmap"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-tour="overview-fullmap"
      data-testid="overview-fullmap"
    >
      <div className="overview-fullmap-header">
        <h2 id={titleId}>Full-size map</h2>
        <div className="overview-fullmap-modes" role="tablist" aria-label="Map mode" data-tour="overview-fullmap-modes">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'all'}
            className={mode === 'all' ? 'is-active' : ''}
            onClick={() => onModeChange('all')}
          >
            All routes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'single'}
            className={mode === 'single' ? 'is-active' : ''}
            onClick={() => onModeChange('single')}
            disabled={!selected}
          >
            Single route
          </button>
        </div>
        <button
          type="button"
          className="market-button secondary overview-fullmap-minimise"
          data-tour="overview-fullmap-minimise"
          onClick={onClose}
        >
          <Minimize2 size={16} aria-hidden /> Minimise
        </button>
      </div>

      {mode === 'all' ? (
        <div className="overview-fullmap-all">
          <div className="overview-fullmap-cards" data-tour="overview-fullmap-cards">
            {routes.map(route => (
              <button
                key={route.id}
                type="button"
                className={`overview-fullmap-card${route.id === selectedId ? ' is-selected' : ''}`}
                onClick={() => onSelect(route.id)}
              >
                <strong>{route.title}</strong>
                <StatusPill status={route.status} />
              </button>
            ))}
          </div>
          <OverviewRoutesMap
            routes={routes}
            selectedId={selectedId}
            onSelect={onSelect}
            badgeTitle={`${routes.length} route${routes.length === 1 ? '' : 's'}`}
            badgeSubtitle="Click a route to focus"
            dataTestId="overview-fullmap-all"
          />
        </div>
      ) : selected ? (
        <div className="overview-fullmap-single" data-tour="overview-fullmap-single">
          <aside className="overview-fullmap-single-panel">
            <label className="overview-fullmap-picker">
              <span>Route</span>
              <select
                value={selected.id}
                onChange={e => onSelect(e.target.value)}
                aria-label="Pick a route"
              >
                {routes.map(route => (
                  <option key={route.id} value={route.id}>{route.title}</option>
                ))}
              </select>
            </label>
            <button type="button" className="btn-text" onClick={() => onModeChange('all')}>
              Back to all routes
            </button>
            {selected.vehicle ? (
              <p className="overview-fullmap-vehicle" data-testid="overview-fullmap-vehicle">
                <span>Vehicle</span> {formatVehicleDims(selected.vehicle)}
              </p>
            ) : null}
            <p className="overview-fullmap-checked" data-testid="overview-fullmap-checked">
              <span>Last checked</span>{' '}
              {selected.lastCheckedAt ? formatBerlinDateTime(selected.lastCheckedAt) : 'Not checked yet'}
            </p>
            <div className="overview-fullmap-alerts" data-testid="overview-fullmap-alerts">
              {alertGroups && (['HOLD', 'VERIFY', 'READY'] as const).map(sev => (
                <section key={sev}>
                  <h3>
                    {sev === 'HOLD' ? 'Hold' : sev === 'VERIFY' ? 'Verify' : 'Ready / resolved'}
                    <span>{alertGroups[sev].length}</span>
                  </h3>
                  {alertGroups[sev].length ? (
                    <ul>
                      {alertGroups[sev].map(alert => (
                        <li key={alert.id}>{alert.change || alert.detail}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="overview-summary-empty">None</p>
                  )}
                </section>
              ))}
              {selected.summaryItems.length > 0 && selected.alerts.length === 0 ? (
                <section>
                  <h3>Latest evidence</h3>
                  <SummaryList items={selected.summaryItems} />
                </section>
              ) : null}
            </div>
          </aside>
          <OverviewRoutesMap
            routes={[selected]}
            selectedId={selected.id}
            focusId={selected.id}
            badgeTitle={selected.title}
            badgeSubtitle={selected.permitNumber || 'Single route'}
            dataTestId="overview-fullmap-single-map"
          />
        </div>
      ) : (
        <p className="overview-empty-filter">No route selected.</p>
      )}
    </div>
  )
}

export default function MarketplaceOverview() {
  const { history, alerts } = useRouteMonitoring()
  const { jobs } = useJobs()
  const [searchParams, setSearchParams] = useSearchParams()
  const fullMapButtonRef = useRef<HTMLButtonElement>(null)

  const filters = useMemo(() => parseOverviewFilters(searchParams), [searchParams])
  const mapFull = searchParams.get('map') === 'full'
  const routeParam = searchParams.get('route')

  const allRoutes = useMemo(
    () => buildOverviewRoutes({ jobs, history, examplePermits: sampleTestPermits, alerts }),
    [jobs, history, alerts],
  )
  const showingExamples = allRoutes.length > 0 && allRoutes.every(r => r.source === 'example')
  const filteredRoutes = useMemo(() => filterOverviewRoutes(allRoutes, filters), [allRoutes, filters])
  const statusCounts = useMemo(() => countByStatus(allRoutes), [allRoutes])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [fullMapMode, setFullMapMode] = useState<'all' | 'single'>('all')

  useEffect(() => {
    if (!filteredRoutes.length) {
      setSelectedId(null)
      return
    }
    if (routeParam && filteredRoutes.some(r => r.id === routeParam)) {
      setSelectedId(routeParam)
      return
    }
    if (!selectedId || !filteredRoutes.some(r => r.id === selectedId)) {
      setSelectedId(filteredRoutes[0].id)
    }
  }, [filteredRoutes, routeParam, selectedId])

  useEffect(() => {
    if (mapFull && routeParam) setFullMapMode('single')
  }, [mapFull, routeParam])

  const setFilters = (next: OverviewFilters) => {
    setSearchParams(prev => applyOverviewFiltersToSearch(prev, next), { replace: true })
  }

  const openFullMap = (mode: 'all' | 'single' = fullMapMode) => {
    setFullMapMode(mode)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('map', 'full')
      if (mode === 'single' && selectedId) next.set('route', selectedId)
      else if (mode === 'all') next.delete('route')
      return next
    }, { replace: true })
  }

  const closeFullMap = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('map')
      next.delete('route')
      return next
    }, { replace: true })
  }

  const selectRoute = (id: string) => {
    setSelectedId(id)
    if (mapFull && fullMapMode === 'single') {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('map', 'full')
        next.set('route', id)
        return next
      }, { replace: true })
    }
  }

  const allExpanded = filteredRoutes.length > 0 && filteredRoutes.every(r => expandedIds.has(r.id))
  const toggleAll = () => {
    if (allExpanded) setExpandedIds(new Set())
    else setExpandedIds(new Set(filteredRoutes.map(r => r.id)))
  }

  const emptyFilterMessage: ReactNode = filtersAreActive(filters) ? (
    <div className="overview-empty-filter" data-testid="overview-empty-filter">
      <p>No routes match these filters.</p>
      <button type="button" className="market-button secondary" onClick={() => setFilters(DEFAULT_OVERVIEW_FILTERS)}>
        Clear filters
      </button>
    </div>
  ) : null

  return (
    <div className="market-page transport-overview">
      <header className="overview-page-header" data-tour="overview-hero">
        <h1>Overview</h1>
      </header>

      <section
        className="transport-workflow"
        aria-label="Heavy transport route monitoring workflow"
        data-tour="overview-workflow"
      >
        <div>
          <span>1</span>
          <FileJson size={18} aria-hidden />
          <strong>Import the permit</strong>
          <p>Upload the exact VEMAGS route and approved transport dimensions.</p>
        </div>
        <ArrowRight size={18} aria-hidden />
        <div>
          <span>2</span>
          <Route size={18} aria-hidden />
          <strong>Check the route</strong>
          <p>Compare only the approved route with current restrictions and roadworks.</p>
        </div>
        <ArrowRight size={18} aria-hidden />
        <div>
          <span>3</span>
          <ShieldCheck size={18} aria-hidden />
          <strong>Monitor until departure</strong>
          <p>Receive early warnings when conditions change or evidence is uncertain.</p>
        </div>
      </section>

      <Link
        to="/route-checks"
        className="market-button primary overview-check-cta"
        data-tour="overview-check-new"
      >
        <Upload size={18} aria-hidden /> Check new route
      </Link>

      <section className="overview-routes-section" aria-label="Upcoming routes" data-tour="overview-routes">
        <div className="market-section-header compact">
          <div>
            <span className="market-eyebrow">Your routes</span>
            <h2>Upcoming routes</h2>
          </div>
        </div>

        {showingExamples ? (
          <p className="overview-examples-note" data-testid="overview-examples-note">
            Example routes — samples from Route Checks so you can try the workflow before importing a permit.
          </p>
        ) : null}

        <OverviewFiltersBar
          filters={filters}
          counts={statusCounts}
          onChange={setFilters}
          listCount={filteredRoutes.length}
        />

        {filteredRoutes.length === 0 ? (
          emptyFilterMessage
        ) : (
          <div className="transport-route-list overview-upcoming-list" data-tour="overview-route-list">
            {filteredRoutes.map(route => {
              const href = route.source === 'job'
                ? `/route-checks?job=${route.id}&run=1`
                : route.permitId
                  ? `/route-checks?permit=${route.permitId}`
                  : '/route-checks'
              return (
                <Link
                  to={href}
                  key={`list-${route.id}`}
                  data-route-id={route.id}
                  className={route.id === selectedId ? 'is-selected' : undefined}
                  onClick={() => setSelectedId(route.id)}
                >
                  <span className={`transport-list-icon ${route.status ? verdictMeta[route.status].iconClass : 'blue'}`}>
                    <Route size={16} aria-hidden />
                  </span>
                  <div>
                    <strong>
                      {route.title}
                      {route.source === 'example' ? <em className="overview-example-tag"> Example</em> : null}
                    </strong>
                    <span>
                      {route.origin} → {route.destination}
                      {route.permitNumber ? ` · ${route.permitNumber}` : ''}
                      {route.lastCheckedAt ? ` · Checked ${formatBerlinDateTime(route.lastCheckedAt)}` : ''}
                    </span>
                  </div>
                  <StatusPill status={route.status} />
                  <ArrowRight size={16} aria-hidden />
                </Link>
              )
            })}
          </div>
        )}
      </section>

      <section className="overview-route-block" aria-label="Route map and details" data-tour="overview-route-block">
        <div className="overview-route-block-header">
          <div data-tour="overview-route-block-heading">
            <span className="market-eyebrow">Route block</span>
            <h2>Routes on the map</h2>
          </div>
          <div className="overview-route-block-actions">
            <button
              type="button"
              className="market-button secondary"
              data-tour="overview-show-all"
              onClick={toggleAll}
              disabled={!filteredRoutes.length}
            >
              {allExpanded ? 'Hide all' : 'Show all'}
            </button>
            <button
              ref={fullMapButtonRef}
              type="button"
              className="market-button secondary"
              data-tour="overview-fullmap-open"
              onClick={() => openFullMap(selectedId ? fullMapMode : 'all')}
              disabled={!filteredRoutes.length}
            >
              <Expand size={16} aria-hidden /> Full-size map
            </button>
          </div>
        </div>

        {filteredRoutes.length === 0 ? (
          emptyFilterMessage
        ) : (
          <div className="overview-route-block-grid">
            {/* Map above cards on phones so geography leads; cards then refine selection. */}
            <div className="overview-route-block-map" data-tour="overview-route-block-map">
              <OverviewRoutesMap
                routes={filteredRoutes}
                selectedId={selectedId}
                onSelect={selectRoute}
                focusId={selectedId}
                badgeTitle={`${filteredRoutes.length} route${filteredRoutes.length === 1 ? '' : 's'}`}
                badgeSubtitle="Coloured by status"
                dataTestId="overview-block-map"
              />
            </div>
            <div className="overview-route-block-cards" data-tour="overview-route-cards">
              {filteredRoutes.map(route => (
                <RouteCard
                  key={`card-${route.id}`}
                  route={route}
                  selected={route.id === selectedId}
                  expanded={expandedIds.has(route.id)}
                  onSelect={() => selectRoute(route.id)}
                  onToggle={() => {
                    setExpandedIds(prev => {
                      const next = new Set(prev)
                      if (next.has(route.id)) next.delete(route.id)
                      else next.add(route.id)
                      return next
                    })
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      <FullSizeMapDialog
        open={mapFull}
        mode={fullMapMode}
        onModeChange={mode => {
          setFullMapMode(mode)
          setSearchParams(prev => {
            const next = new URLSearchParams(prev)
            next.set('map', 'full')
            if (mode === 'single' && selectedId) next.set('route', selectedId)
            else next.delete('route')
            return next
          }, { replace: true })
        }}
        routes={filteredRoutes}
        selectedId={selectedId}
        onSelect={selectRoute}
        onClose={closeFullMap}
        restoreFocusRef={fullMapButtonRef}
      />
    </div>
  )
}
