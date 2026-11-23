import { useEffect, useRef, useState } from 'react'
import L, { type LayerGroup, type Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Route } from 'lucide-react'
import { ROUTE_FIT_MAX_ZOOM } from '../lib/mapBounds'
import { downsampleTrack, loadGpxTrack, parseGpxTrack, type LatLng } from '../lib/gpxTrack'
import {
  compareTracksForMapDrawOrder,
  VERDICT_TRACK_COLORS,
  type OverviewVerdict,
} from '../lib/overviewTracks'
import { countRoutesWithoutGeometry, type OverviewRoute } from '../lib/overviewRoutes'

export type OverviewMapTrack = {
  id: string
  origin: string
  destination: string
  status: OverviewVerdict | null
  coordinates: LatLng[]
}

type Props = {
  routes: OverviewRoute[]
  selectedId?: string | null
  onSelect?: (id: string) => void
  badgeTitle?: string
  badgeSubtitle?: string
  showLegend?: boolean
  className?: string
  dataTestId?: string
  /** When set, fit/focus this route only. */
  focusId?: string | null
  /**
   * `all` — fit every loaded track on load/filter change; fit selected on click.
   * `focus` — always fit the focused/selected route (single-route mode).
   */
  fitPolicy?: 'all' | 'focus'
}

const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const GERMANY_CENTER: LatLng = [51.16, 10.45]
const GERMANY_ZOOM = 6
const UNKNOWN_COLOR = '#64748b'
const FIT_PADDING: [number, number] = [32, 32]

function shortLabel(value: string) {
  const part = value.split(/[,/·]/)[0]?.trim() || value
  return part.length > 18 ? `${part.slice(0, 16)}…` : part
}

function trackColor(status: OverviewVerdict | null) {
  return status ? VERDICT_TRACK_COLORS[status] : UNKNOWN_COLOR
}

async function resolveCoordinates(route: OverviewRoute): Promise<LatLng[]> {
  if (route.geometry && route.geometry.length >= 2) {
    return downsampleTrack(route.geometry, 240)
  }
  if (route.gpxFile) {
    try {
      return downsampleTrack(await loadGpxTrack(route.gpxFile), 240)
    } catch {
      return []
    }
  }
  return []
}

export default function OverviewRoutesMap({
  routes,
  selectedId,
  onSelect,
  badgeTitle = 'Routes',
  badgeSubtitle = 'Coloured by latest status',
  showLegend = true,
  className = '',
  dataTestId = 'overview-routes-map',
  focusId,
  fitPolicy = 'all',
}: Props) {
  const mapNode = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const lineGroupRef = useRef<LayerGroup | null>(null)
  const tracksRef = useRef<OverviewMapTrack[]>([])
  const routesRef = useRef(routes)
  routesRef.current = routes
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const focusRef = useRef(focusId)
  focusRef.current = focusId
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const fitPolicyRef = useRef(fitPolicy)
  fitPolicyRef.current = fitPolicy
  const prevRoutesKeyRef = useRef('')
  const prevSelectedRef = useRef(selectedId)
  const routesKey = routes.map(r => `${r.id}:${r.status ?? 'none'}:${r.gpxFile ?? ''}:${r.geometry?.length ?? 0}`).join('|')
  const [loadedMissing, setLoadedMissing] = useState(() => countRoutesWithoutGeometry(routes).missing)

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return

    const map = L.map(mapNode.current, {
      zoomControl: false,
      attributionControl: true,
      minZoom: 5,
      maxZoom: 16,
      zoomSnap: 0,
      zoomDelta: 0.5,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: true,
      touchZoom: true,
      keyboard: true,
      boxZoom: false,
      center: GERMANY_CENTER,
      zoom: GERMANY_ZOOM,
    })
    map.attributionControl?.setPrefix(false)
    L.control.zoom({ position: 'topright' }).addTo(map)
    L.tileLayer(OSM_TILES, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map)
    map.on('click', () => map.scrollWheelZoom.enable())
    const disableWheel = () => map.scrollWheelZoom.disable()
    map.getContainer().addEventListener('mouseleave', disableWheel)

    mapRef.current = map
    lineGroupRef.current = L.layerGroup().addTo(map)

    const observer = new ResizeObserver(() => {
      mapRef.current?.invalidateSize({ animate: false })
    })
    observer.observe(mapNode.current)

    return () => {
      map.getContainer().removeEventListener('mouseleave', disableWheel)
      observer.disconnect()
      map.remove()
      mapRef.current = null
      lineGroupRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!mapRef.current || !lineGroupRef.current) return
    let cancelled = false

    async function draw() {
      const loaded: OverviewMapTrack[] = []
      for (const route of routesRef.current) {
        const coordinates = await resolveCoordinates(route)
        if (coordinates.length < 2) continue
        loaded.push({
          id: route.id,
          origin: route.origin,
          destination: route.destination,
          status: route.status,
          coordinates,
        })
      }
      if (cancelled) return
      const map = mapRef.current
      const group = lineGroupRef.current
      if (!map || !group) return

      tracksRef.current = loaded
      const missingAfterLoad = Math.max(0, routesRef.current.length - loaded.length)
      setLoadedMissing(missingAfterLoad)

      group.clearLayers()
      const allPoints: LatLng[] = []
      const highlightId = focusRef.current || selectedRef.current
      // READY → VERIFY → HOLD, then selected on top (Leaflet paints later layers above).
      const paintOrder = [...loaded].sort((a, b) =>
        compareTracksForMapDrawOrder(a, b, highlightId),
      )

      paintOrder.forEach(track => {
        const color = trackColor(track.status)
        const highlighted = track.id === highlightId
        const weight = highlighted ? 6 : 5
        const casing = highlighted ? 11 : 9
        const line = L.polyline(track.coordinates, {
          color: '#fff',
          weight: casing,
          opacity: 0.95,
          interactive: true,
          lineCap: 'round',
          lineJoin: 'round',
        })
        const coloured = L.polyline(track.coordinates, {
          color,
          weight,
          opacity: highlighted ? 1 : 0.88,
          interactive: true,
          lineCap: 'round',
          lineJoin: 'round',
        })
        const select = () => onSelectRef.current?.(track.id)
        line.on('click', select)
        coloured.on('click', select)
        line.addTo(group)
        coloured.addTo(group)
        ;[track.coordinates[0], track.coordinates[track.coordinates.length - 1]].forEach(point => {
          L.circleMarker(point, {
            radius: highlighted ? 7 : 5,
            color: '#fff',
            weight: 2,
            fillColor: color,
            fillOpacity: 1,
            interactive: false,
          }).addTo(group)
        })
        allPoints.push(...track.coordinates)
      })

      map.invalidateSize({ animate: false })

      const routesChanged = prevRoutesKeyRef.current !== routesKey
      const selectedChanged = prevSelectedRef.current !== selectedRef.current
      prevRoutesKeyRef.current = routesKey
      prevSelectedRef.current = selectedRef.current

      const focusTrack = loaded.find(t => t.id === (focusRef.current || selectedRef.current))
      let fitPoints: LatLng[] = allPoints

      if (fitPolicyRef.current === 'focus') {
        fitPoints = focusTrack?.coordinates?.length ? focusTrack.coordinates : allPoints
      } else if (loaded.length === 1) {
        fitPoints = loaded[0].coordinates
      } else if (selectedChanged && !routesChanged && focusTrack?.coordinates?.length) {
        fitPoints = focusTrack.coordinates
      } else {
        fitPoints = allPoints
      }

      if (fitPoints.length >= 2) {
        map.fitBounds(L.latLngBounds(fitPoints), {
          padding: FIT_PADDING,
          maxZoom: ROUTE_FIT_MAX_ZOOM,
          animate: false,
        })
      } else {
        map.setView(GERMANY_CENTER, GERMANY_ZOOM, { animate: false })
      }
    }

    void draw()
    return () => {
      cancelled = true
    }
  }, [routesKey, selectedId, focusId, fitPolicy])

  const resolvedSubtitle =
    loadedMissing > 0 && routes.length > 0
      ? `${loadedMissing} of ${routes.length} routes have no map geometry`
      : badgeSubtitle

  return (
    <div
      className={`heatmap-shell heatmap-compact permit-leaflet-shell overview-routes-map-shell ${className}`}
      data-overview-map={dataTestId}
      data-selected-route={selectedId || ''}
      data-missing-geometry={loadedMissing}
    >
      <div className="heatmap-canvas" role="img" aria-label={resolvedSubtitle}>
        <div ref={mapNode} className="permit-leaflet-map overview-routes-map" />
        <div className="permit-map-badge">
          <Route size={16} aria-hidden />
          <span>
            <strong>{badgeTitle}</strong>
            <small>{resolvedSubtitle}</small>
          </span>
        </div>
        {showLegend ? (
          <div className="permit-map-legend overview-route-legend">
            <span><i className="alert-key ready" /> Ready</span>
            <span><i className="alert-key verify" /> Verify</span>
            <span><i className="alert-key hold" /> Hold</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Sync helper for tests / callers that already have GPX text. */
export function parseOverviewGpx(xml: string): LatLng[] {
  return parseGpxTrack(xml)
}

export { shortLabel }
