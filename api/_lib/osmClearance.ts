/**
 * OpenStreetMap bridge / clearance check via Overpass API.
 *
 * Crowd-sourced (ODbL) — not authoritative. Failures must fall back to the
 * existing VERIFY / dispatcher-confirmation flow without breaking the check.
 */

import {
  buildCorridorIndex,
  distanceToCorridorKm,
  type CorridorIndex,
  type LatLngPoint,
} from './corridor.js'
import type { ClassifiedEvidence, VehicleDimensions } from './verdict.js'

export const OSM_SOURCE = 'OpenStreetMap (Overpass) · ODbL'
export const OSM_ATTRIBUTION =
  '© OpenStreetMap contributors. Data available under the Open Database License (ODbL). Crowd-sourced — not authoritative for dispatch.'

export const OSM_MATCH_DISTANCE_KM = 0.05
export const OSM_CHUNK_POINTS = 80
export const OSM_OVERPASS_TIMEOUT_MS = 22_000
export const OSM_OVERPASS_ENDPOINTS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
] as const

export type OsmRestrictionKind = 'maxheight' | 'maxweight' | 'maxwidth' | 'maxlength' | 'maxaxleload'

export type ParsedOsmMeasure = {
  /** Numeric value in metres (length/width/height) or tonnes (weight/axle). */
  value: number | null
  /** Raw tag after trim; null when absent or explicitly unrestricted. */
  raw: string | null
  /** true when the tag means no restriction (none / default / unsigned). */
  unrestricted: boolean
  /** true when a value was present but could not be parsed. */
  unparsed: boolean
}

export type OsmRestrictionHit = {
  osmType: 'way' | 'node' | 'relation'
  osmId: number
  name?: string
  lat: number
  lng: number
  isBridge: boolean
  isTunnel: boolean
  tags: Partial<Record<OsmRestrictionKind, string>>
  distanceKm: number
}

export type OsmClearanceConflict = {
  hit: OsmRestrictionHit
  kind: OsmRestrictionKind
  limit: number
  vehicleValue: number
  unit: 'm' | 't'
}

export type OsmClearanceResult = {
  ok: boolean
  error?: string
  retrievedAt: string
  hits: OsmRestrictionHit[]
  conflicts: OsmClearanceConflict[]
  /** Bridges/tunnels on the corridor with no usable restriction tags. */
  unknownStructures: OsmRestrictionHit[]
  /** Restrictions that were compared and the vehicle fits. */
  checkedOk: number
  evidence: ClassifiedEvidence[]
}

const RESTRICTION_KEYS: OsmRestrictionKind[] = [
  'maxheight',
  'maxweight',
  'maxwidth',
  'maxlength',
  'maxaxleload',
]

const UNRESTRICTED_RE = /^(none|default|unsigned|no|unlimited|unknown)$/i
const FEET_INCHES_RE = /^(\d+)\s*[\'′]\s*(?:(\d+(?:\.\d+)?)\s*(?:["″]|in|inch|inches)?)?$/i
const FEET_ONLY_RE = /^(\d+(?:\.\d+)?)\s*(?:ft|feet|foot)$/i
const INCHES_ONLY_RE = /^(\d+(?:\.\d+)?)\s*(?:["″]|in|inch|inches)$/i
const METRIC_RE = /^(\d+(?:[.,]\d+)?)\s*(m|metre|metres|meter|meters|t|to|ton|tons|tonne|tonnes)?$/i

export function parseOsmMeasure(
  raw: string | null | undefined,
  unitHint: 'm' | 't' = 'm',
): ParsedOsmMeasure {
  if (raw == null) return { value: null, raw: null, unrestricted: false, unparsed: false }
  const trimmed = String(raw).trim()
  if (!trimmed) return { value: null, raw: null, unrestricted: false, unparsed: false }
  if (UNRESTRICTED_RE.test(trimmed)) {
    return { value: null, raw: trimmed, unrestricted: true, unparsed: false }
  }

  const feetInches = trimmed.match(FEET_INCHES_RE)
  if (feetInches) {
    const feet = Number(feetInches[1])
    const inches = feetInches[2] != null ? Number(feetInches[2]) : 0
    if (Number.isFinite(feet) && Number.isFinite(inches)) {
      const metres = feet * 0.3048 + inches * 0.0254
      return { value: roundMeasure(metres), raw: trimmed, unrestricted: false, unparsed: false }
    }
  }

  const feetOnly = trimmed.match(FEET_ONLY_RE)
  if (feetOnly) {
    const feet = Number(feetOnly[1])
    if (Number.isFinite(feet)) {
      return { value: roundMeasure(feet * 0.3048), raw: trimmed, unrestricted: false, unparsed: false }
    }
  }

  const inchesOnly = trimmed.match(INCHES_ONLY_RE)
  if (inchesOnly) {
    const inches = Number(inchesOnly[1])
    if (Number.isFinite(inches)) {
      return { value: roundMeasure(inches * 0.0254), raw: trimmed, unrestricted: false, unparsed: false }
    }
  }

  const metric = trimmed.match(METRIC_RE)
  if (metric) {
    const num = parseFloat(metric[1].replace(',', '.'))
    if (!Number.isFinite(num) || num < 0) {
      return { value: null, raw: trimmed, unrestricted: false, unparsed: true }
    }
    const unit = (metric[2] || '').toLowerCase()
    if (unitHint === 't' || /^(t|to|ton|tons|tonne|tonnes)$/.test(unit)) {
      return { value: roundMeasure(num), raw: trimmed, unrestricted: false, unparsed: false }
    }
    // Bare number with metre hint, or explicit metre unit.
    return { value: roundMeasure(num), raw: trimmed, unrestricted: false, unparsed: false }
  }

  return { value: null, raw: trimmed, unrestricted: false, unparsed: true }
}

function roundMeasure(value: number): number {
  return Math.round(value * 1000) / 1000
}

function isBridgeTag(value?: string): boolean {
  if (!value) return false
  return !/^(no|none)$/i.test(value)
}

function isTunnelTag(value?: string): boolean {
  if (!value) return false
  return !/^(no|none)$/i.test(value)
}

function featureCentroid(element: OverpassElement): { lat: number; lng: number } | null {
  if (typeof element.lat === 'number' && typeof element.lon === 'number') {
    return { lat: element.lat, lng: element.lon }
  }
  if (element.center && typeof element.center.lat === 'number' && typeof element.center.lon === 'number') {
    return { lat: element.center.lat, lng: element.center.lon }
  }
  const geometry = element.geometry
  if (Array.isArray(geometry) && geometry.length) {
    let lat = 0
    let lng = 0
    let count = 0
    for (const point of geometry) {
      if (typeof point.lat === 'number' && typeof point.lon === 'number') {
        lat += point.lat
        lng += point.lon
        count += 1
      }
    }
    if (count) return { lat: lat / count, lng: lng / count }
  }
  return null
}

type OverpassElement = {
  type: 'way' | 'node' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  geometry?: Array<{ lat: number; lon: number }>
  tags?: Record<string, string>
}

type OverpassResponse = {
  elements?: OverpassElement[]
  remark?: string
}

function chunkPoints<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return [items]
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += Math.max(1, size - 1)) {
    const slice = items.slice(i, i + size)
    if (slice.length >= 2 || chunks.length === 0) chunks.push(slice)
    if (i + size >= items.length) break
  }
  return chunks
}

/** Build a compact Overpass QL query for one route chunk. */
export function buildOverpassQuery(points: LatLngPoint[], padKm = 0.08): string {
  // Sample the line so the around polyline stays small; corridor distance filters later.
  // Overpass line syntax: around:radius,lat1,lon1,lat2,lon2,...
  const sampleStep = Math.max(1, Math.floor(points.length / 24))
  const line = points
    .filter((_, index) => index === 0 || index === points.length - 1 || index % sampleStep === 0)
    .flatMap(point => [point.lat.toFixed(5), point.lng.toFixed(5)])
    .join(',')
  const aroundM = Math.max(40, Math.round(padKm * 1000))
  const around = `around:${aroundM},${line}`
  // Prefer around(line) over full bbox — long Autobahn chunks would otherwise pull
  // every bridge in a large rectangle and trip Overpass timeouts.
  // Single union keeps worker time down vs many separate statements.
  return `
[out:json][timeout:20];
(
  way(${around})["maxheight"];
  way(${around})["maxweight"];
  way(${around})["maxwidth"];
  way(${around})["maxlength"];
  way(${around})["maxaxleload"];
  node(${around})["maxheight"];
  node(${around})["maxweight"];
  node(${around})["maxwidth"];
  way(${around})["bridge"];
  way(${around})["tunnel"];
);
out center tags;
`.trim()
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchOverpassChunk(
  query: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; endpoints?: readonly string[] } = {},
): Promise<OverpassElement[]> {
  const fetchImpl = opts.fetchImpl || fetch
  const timeoutMs = opts.timeoutMs ?? OSM_OVERPASS_TIMEOUT_MS
  const endpoints = opts.endpoints || OSM_OVERPASS_ENDPOINTS
  let lastError = 'Overpass unavailable'
  for (const endpoint of endpoints) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'HeavyTransportRouteCheck/1.0 (bridge-clearance; contact: route-check)',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      })
      if (response.status === 429 || response.status === 502 || response.status === 504) {
        lastError = `Overpass HTTP ${response.status}`
        await sleep(500)
        continue
      }
      if (!response.ok) {
        lastError = `Overpass HTTP ${response.status}`
        continue
      }
      const text = await response.text()
      if (text.trimStart().startsWith('<') || text.includes('Gateway Timeout') || text.includes('at capacity')) {
        lastError = 'Overpass capacity error'
        await sleep(500)
        continue
      }
      const payload = JSON.parse(text) as OverpassResponse
      return Array.isArray(payload.elements) ? payload.elements : []
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Overpass request failed'
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(lastError)
}

/** Parse OSM API 0.6 map XML into Overpass-shaped elements (fallback when Overpass is busy). */
export function parseOsmMapXml(xml: string): OverpassElement[] {
  const elements: OverpassElement[] = []
  const nodes = new Map<string, { lat: number; lon: number }>()
  const nodeRe = /<node\b([^>]*)\/?>/gi
  let match: RegExpExecArray | null
  while ((match = nodeRe.exec(xml))) {
    const attrs = match[1]
    const id = attrs.match(/\bid\s*=\s*["'](\d+)["']/i)?.[1]
    const lat = Number(attrs.match(/\blat\s*=\s*["']([^"']+)["']/i)?.[1])
    const lon = Number(attrs.match(/\blon\s*=\s*["']([^"']+)["']/i)?.[1])
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    nodes.set(id, { lat, lon })
    const blockEnd = xml.indexOf('>', match.index)
    const selfClosing = xml.slice(match.index, blockEnd + 1).endsWith('/>')
    let tagXml = ''
    if (!selfClosing) {
      const close = xml.indexOf('</node>', blockEnd)
      if (close > blockEnd) tagXml = xml.slice(blockEnd, close)
    }
    const tags = tagsFromXml(tagXml)
    if (Object.keys(tags).length) {
      elements.push({ type: 'node', id: Number(id), lat, lon, tags })
    }
  }

  const wayRe = /<way\b([^>]*)>([\s\S]*?)<\/way>/gi
  while ((match = wayRe.exec(xml))) {
    const id = match[1].match(/\bid\s*=\s*["'](\d+)["']/i)?.[1]
    if (!id) continue
    const body = match[2]
    const tags = tagsFromXml(body)
    const ndIds = [...body.matchAll(/<nd\b[^>]*\bref\s*=\s*["'](\d+)["']/gi)].map(item => item[1])
    const geometry = ndIds
      .map(nd => nodes.get(nd))
      .filter((point): point is { lat: number; lon: number } => Boolean(point))
    if (!geometry.length && !Object.keys(tags).length) continue
    let lat = 0
    let lon = 0
    for (const point of geometry) {
      lat += point.lat
      lon += point.lon
    }
    const center = geometry.length
      ? { lat: lat / geometry.length, lon: lon / geometry.length }
      : undefined
    elements.push({
      type: 'way',
      id: Number(id),
      center,
      geometry,
      tags,
    })
  }
  return elements
}

function tagsFromXml(xml: string): Record<string, string> {
  const tags: Record<string, string> = {}
  const tagRe = /<tag\b[^>]*\bk\s*=\s*["']([^"']+)["'][^>]*\bv\s*=\s*["']([^"']*)["'][^>]*\/?>/gi
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(xml))) {
    tags[match[1]] = match[2]
  }
  // Attribute order may be v then k.
  const tagReAlt = /<tag\b[^>]*\bv\s*=\s*["']([^"']*)["'][^>]*\bk\s*=\s*["']([^"']+)["'][^>]*\/?>/gi
  while ((match = tagReAlt.exec(xml))) {
    tags[match[2]] = match[1]
  }
  return tags
}

function chunkBboxes(points: LatLngPoint[], maxSpanDeg = 0.04): Array<{ west: number; south: number; east: number; north: number }> {
  const boxes: Array<{ west: number; south: number; east: number; north: number }> = []
  let start = 0
  while (start < points.length) {
    let end = start
    let minLat = points[start].lat
    let maxLat = points[start].lat
    let minLng = points[start].lng
    let maxLng = points[start].lng
    while (end + 1 < points.length) {
      const next = points[end + 1]
      const nMinLat = Math.min(minLat, next.lat)
      const nMaxLat = Math.max(maxLat, next.lat)
      const nMinLng = Math.min(minLng, next.lng)
      const nMaxLng = Math.max(maxLng, next.lng)
      if ((nMaxLat - nMinLat) > maxSpanDeg || (nMaxLng - nMinLng) > maxSpanDeg) break
      minLat = nMinLat
      maxLat = nMaxLat
      minLng = nMinLng
      maxLng = nMaxLng
      end += 1
    }
    const pad = 0.001
    boxes.push({
      west: minLng - pad,
      south: minLat - pad,
      east: maxLng + pad,
      north: maxLat + pad,
    })
    if (end === start) start += 1
    else start = end
  }
  return boxes.slice(0, 8)
}

async function fetchOsmMapFallback(
  points: LatLngPoint[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OverpassElement[]> {
  const fetchImpl = opts.fetchImpl || fetch
  const timeoutMs = opts.timeoutMs ?? 12_000
  const boxes = chunkBboxes(points)
  const collected: OverpassElement[] = []
  const seen = new Set<string>()
  for (const box of boxes) {
    const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${box.west.toFixed(5)},${box.south.toFixed(5)},${box.east.toFixed(5)},${box.north.toFixed(5)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/xml, text/xml, */*',
          'User-Agent': 'HeavyTransportRouteCheck/1.0 (bridge-clearance; contact: route-check)',
        },
        signal: controller.signal,
      })
      if (!response.ok) continue
      const xml = await response.text()
      for (const element of parseOsmMapXml(xml)) {
        const key = `${element.type}/${element.id}`
        if (seen.has(key)) continue
        seen.add(key)
        collected.push(element)
      }
    } catch {
      // Try remaining boxes; caller handles total failure.
    } finally {
      clearTimeout(timer)
    }
  }
  if (!collected.length) throw new Error('OSM map API fallback returned no data')
  return collected
}

function tagsFromElement(tags: Record<string, string> | undefined): Partial<Record<OsmRestrictionKind, string>> {
  const out: Partial<Record<OsmRestrictionKind, string>> = {}
  if (!tags) return out
  for (const key of RESTRICTION_KEYS) {
    if (tags[key]) out[key] = tags[key]
  }
  return out
}

export function elementToHit(
  element: OverpassElement,
  corridor: CorridorIndex,
  maxDistanceKm = OSM_MATCH_DISTANCE_KM,
): OsmRestrictionHit | null {
  const center = featureCentroid(element)
  if (!center) return null
  const distanceKm = distanceToCorridorKm(corridor, center.lat, center.lng)
  if (distanceKm > maxDistanceKm) return null
  const tags = element.tags || {}
  // Pedestrian-only geometries are noise for VEMAGS heavy-transport GPX.
  if (/^(footway|path|steps|pedestrian)$/i.test(String(tags.highway || ''))) return null
  const restrictionTags = tagsFromElement(tags)
  const isBridge = isBridgeTag(tags.bridge)
  const isTunnel = isTunnelTag(tags.tunnel)
  const hasRestriction = RESTRICTION_KEYS.some(key => Boolean(restrictionTags[key]))
  if (!hasRestriction && !isBridge && !isTunnel) return null
  return {
    osmType: element.type,
    osmId: element.id,
    name: tags.name || tags.ref || undefined,
    lat: center.lat,
    lng: center.lng,
    isBridge,
    isTunnel,
    tags: restrictionTags,
    distanceKm: Math.round(distanceKm * 1000) / 1000,
  }
}

function vehicleValueFor(kind: OsmRestrictionKind, vehicle: VehicleDimensions): number | null {
  switch (kind) {
    case 'maxheight':
      return vehicle.height
    case 'maxwidth':
      return vehicle.width
    case 'maxlength':
      return vehicle.length
    case 'maxweight':
      return vehicle.grossWeight
    case 'maxaxleload':
      return null
    default:
      return null
  }
}

function unitFor(kind: OsmRestrictionKind): 'm' | 't' {
  return kind === 'maxweight' || kind === 'maxaxleload' ? 't' : 'm'
}

function kindLabel(kind: OsmRestrictionKind): string {
  switch (kind) {
    case 'maxheight':
      return 'height'
    case 'maxwidth':
      return 'width'
    case 'maxlength':
      return 'length'
    case 'maxweight':
      return 'weight'
    case 'maxaxleload':
      return 'axle load'
    default:
      return kind
  }
}

export function compareHitToVehicle(
  hit: OsmRestrictionHit,
  vehicle: VehicleDimensions,
): { conflicts: OsmClearanceConflict[]; checkedOk: number; uncompared: OsmRestrictionKind[] } {
  const conflicts: OsmClearanceConflict[] = []
  const uncompared: OsmRestrictionKind[] = []
  let checkedOk = 0
  for (const kind of RESTRICTION_KEYS) {
    const raw = hit.tags[kind]
    if (!raw) continue
    const parsed = parseOsmMeasure(raw, unitFor(kind))
    if (parsed.unrestricted) continue
    if (parsed.unparsed || parsed.value == null) {
      uncompared.push(kind)
      continue
    }
    const vehicleValue = vehicleValueFor(kind, vehicle)
    if (vehicleValue == null || !Number.isFinite(vehicleValue) || vehicleValue <= 0) {
      uncompared.push(kind)
      continue
    }
    if (vehicleValue > parsed.value) {
      conflicts.push({
        hit,
        kind,
        limit: parsed.value,
        vehicleValue,
        unit: unitFor(kind),
      })
    } else {
      checkedOk += 1
    }
  }
  return { conflicts, checkedOk, uncompared }
}

function structureLabel(hit: OsmRestrictionHit): string {
  const kind = hit.isBridge && hit.isTunnel ? 'Bridge/tunnel' : hit.isBridge ? 'Bridge' : hit.isTunnel ? 'Tunnel' : 'Restriction'
  return hit.name ? `${kind} · ${hit.name}` : `${kind} · OSM ${hit.osmType}/${hit.osmId}`
}

function conflictEvidence(conflict: OsmClearanceConflict, retrievedAt: string): ClassifiedEvidence {
  const label = kindLabel(conflict.kind)
  const title = `${label.charAt(0).toUpperCase() + label.slice(1)} limit ${conflict.limit} ${conflict.unit} vs vehicle ${conflict.vehicleValue} ${conflict.unit}`
  const place = structureLabel(conflict.hit)
  return {
    id: `osm-conflict-${conflict.hit.osmType}-${conflict.hit.osmId}-${conflict.kind}`,
    title,
    detail: `${place}: OSM ${conflict.kind}=${conflict.hit.tags[conflict.kind]} (${conflict.limit} ${conflict.unit}) vs vehicle ${conflict.vehicleValue} ${conflict.unit}. ${OSM_ATTRIBUTION}`,
    source: OSM_SOURCE,
    confidence: 'high',
    state: 'danger',
    category: 'observations',
    lat: conflict.hit.lat,
    lng: conflict.hit.lng,
    distanceKm: conflict.hit.distanceKm,
    reason: `OSM ${conflict.kind} ${conflict.limit} ${conflict.unit} exceeded by vehicle ${conflict.vehicleValue} ${conflict.unit}.`,
    locationKind: 'mainline',
    blocker: true,
    retrievedAt,
  }
}

function unknownStructureEvidence(hit: OsmRestrictionHit, retrievedAt: string): ClassifiedEvidence {
  const place = structureLabel(hit)
  return {
    id: `osm-unknown-${hit.osmType}-${hit.osmId}`,
    title: `${place} — no clearance data`,
    detail: `OSM marks this as a ${hit.isBridge ? 'bridge' : 'tunnel'} without maxheight/maxweight/maxwidth/maxlength tags. Confirm with permit or authority. ${OSM_ATTRIBUTION}`,
    source: OSM_SOURCE,
    confidence: 'medium',
    state: 'warning',
    category: 'observations',
    lat: hit.lat,
    lng: hit.lng,
    distanceKm: hit.distanceKm,
    reason: 'Bridge/tunnel on route without OSM restriction tags.',
    locationKind: 'mainline',
    blocker: false,
    retrievedAt,
  }
}

function summaryEvidence(opts: {
  retrievedAt: string
  checkedOk: number
  conflictCount: number
  unknownCount: number
  failed?: boolean
  error?: string
}): ClassifiedEvidence {
  if (opts.failed) {
    return {
      id: 'bridge-clearance-unknown',
      title: 'Bridge and clearance data not available',
      detail: `OpenStreetMap Overpass lookup failed (${opts.error || 'timeout'}). Unknown clearance cannot yield READY — confirm on site or tick dispatcher confirmation. ${OSM_ATTRIBUTION}`,
      source: 'Route check system',
      confidence: 'medium',
      state: 'warning',
      category: 'observations',
      distanceKm: null,
      reason: 'Clearance not confirmed (OSM unavailable).',
      locationKind: 'unknown',
      blocker: true,
      retrievedAt: opts.retrievedAt,
    }
  }

  if (opts.conflictCount > 0) {
    return {
      id: 'bridge-clearance-osm',
      title: `OSM clearance: ${opts.conflictCount} restriction${opts.conflictCount === 1 ? '' : 's'} exceeded`,
      detail: `${opts.checkedOk} restriction${opts.checkedOk === 1 ? '' : 's'} checked OK · ${opts.conflictCount} conflict${opts.conflictCount === 1 ? '' : 's'} · ${opts.unknownCount} bridge${opts.unknownCount === 1 ? '' : 's'}/tunnel${opts.unknownCount === 1 ? '' : 's'} without data. ${OSM_ATTRIBUTION}`,
      source: OSM_SOURCE,
      confidence: 'high',
      state: 'danger',
      category: 'observations',
      distanceKm: null,
      reason: 'OSM restriction conflict on route.',
      locationKind: 'unknown',
      blocker: true,
      retrievedAt: opts.retrievedAt,
    }
  }

  if (opts.unknownCount > 0) {
    return {
      id: 'bridge-clearance-unknown',
      title: `${opts.checkedOk} restriction${opts.checkedOk === 1 ? '' : 's'} checked OK, ${opts.unknownCount} bridge${opts.unknownCount === 1 ? '' : 's'} without data – confirm with permit/authority`,
      detail: `OpenStreetMap found restriction tags that the vehicle fits, but ${opts.unknownCount} bridge/tunnel feature${opts.unknownCount === 1 ? '' : 's'} lack clearance tags. OSM is crowd-sourced and not authoritative — confirm before dispatch. ${OSM_ATTRIBUTION}`,
      source: OSM_SOURCE,
      confidence: 'medium',
      state: 'warning',
      category: 'observations',
      distanceKm: null,
      reason: 'OSM partial clearance — bridges without data.',
      locationKind: 'unknown',
      blocker: true,
      retrievedAt: opts.retrievedAt,
    }
  }

  return {
    id: 'bridge-clearance-unknown',
    title: opts.checkedOk
      ? `${opts.checkedOk} OSM restriction${opts.checkedOk === 1 ? '' : 's'} checked OK – confirm with permit/authority`
      : 'No OSM bridge restrictions on corridor – confirm with permit/authority',
    detail: opts.checkedOk
      ? `OpenStreetMap restriction tags along the route fit this vehicle. OSM is crowd-sourced and not authoritative — dispatcher confirmation is still required before READY. ${OSM_ATTRIBUTION}`
      : `No maxheight/maxweight/maxwidth/maxlength tags and no bridge/tunnel features were found near the GPX corridor in OpenStreetMap. That is not a clearance certificate — confirm with permit/authority. ${OSM_ATTRIBUTION}`,
    source: OSM_SOURCE,
    confidence: 'medium',
    state: 'warning',
    category: 'observations',
    distanceKm: null,
    reason: 'OSM clearance checked; still needs dispatcher confirmation.',
    locationKind: 'unknown',
    blocker: true,
    retrievedAt: opts.retrievedAt,
  }
}

export function buildOsmClearanceEvidence(
  hits: OsmRestrictionHit[],
  vehicle: VehicleDimensions,
  retrievedAt: string,
): Omit<OsmClearanceResult, 'ok' | 'error'> {
  const conflicts: OsmClearanceConflict[] = []
  let checkedOk = 0
  const unknownStructures: OsmRestrictionHit[] = []
  const seenUnknown = new Set<string>()

  for (const hit of hits) {
    const compared = compareHitToVehicle(hit, vehicle)
    conflicts.push(...compared.conflicts)
    checkedOk += compared.checkedOk
    const hasUsableTag = RESTRICTION_KEYS.some(key => {
      const parsed = parseOsmMeasure(hit.tags[key], unitFor(key))
      return parsed.value != null && !parsed.unrestricted
    })
    if ((hit.isBridge || hit.isTunnel) && !hasUsableTag) {
      const key = `${hit.osmType}/${hit.osmId}`
      if (!seenUnknown.has(key)) {
        seenUnknown.add(key)
        unknownStructures.push(hit)
      }
    }
  }

  // Cap map clutter while keeping the worst conflicts.
  const conflictItems = conflicts
    .sort((a, b) => (b.vehicleValue - b.limit) - (a.vehicleValue - a.limit))
    .slice(0, 25)
    .map(item => conflictEvidence(item, retrievedAt))
  const unknownItems = unknownStructures.slice(0, 40).map(item => unknownStructureEvidence(item, retrievedAt))
  const summary = summaryEvidence({
    retrievedAt,
    checkedOk,
    conflictCount: conflicts.length,
    unknownCount: unknownStructures.length,
  })

  return {
    retrievedAt,
    hits,
    conflicts,
    unknownStructures,
    checkedOk,
    evidence: [summary, ...conflictItems, ...unknownItems],
  }
}

export async function checkOsmClearance(opts: {
  points: LatLngPoint[]
  vehicle: VehicleDimensions
  corridor?: CorridorIndex
  retrievedAt?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  endpoints?: readonly string[]
  /** Skip live Overpass (tests). */
  elements?: OverpassElement[]
}): Promise<OsmClearanceResult> {
  const retrievedAt = opts.retrievedAt || new Date().toISOString()
  const corridor = opts.corridor
    || buildCorridorIndex(opts.points, 40)
  try {
    let elements = opts.elements
    if (!elements) {
      const chunks = chunkPoints(opts.points, OSM_CHUNK_POINTS)
      // Bound total Overpass work for long GPX tracks.
      const limited = chunks.slice(0, 6)
      const collected: OverpassElement[] = []
      const seen = new Set<string>()
      let overpassError: string | null = null
      try {
        for (const chunk of limited) {
          const query = buildOverpassQuery(chunk)
          const part = await fetchOverpassChunk(query, {
            fetchImpl: opts.fetchImpl,
            timeoutMs: opts.timeoutMs,
            endpoints: opts.endpoints,
          })
          for (const element of part) {
            const key = `${element.type}/${element.id}`
            if (seen.has(key)) continue
            seen.add(key)
            collected.push(element)
          }
        }
      } catch (error) {
        overpassError = error instanceof Error ? error.message : 'Overpass failed'
      }
      if (!collected.length) {
        try {
          // Public Overpass is often at capacity; OSM map API covers short corridor chunks.
          const fallback = await fetchOsmMapFallback(opts.points, {
            fetchImpl: opts.fetchImpl,
            timeoutMs: Math.min(opts.timeoutMs ?? OSM_OVERPASS_TIMEOUT_MS, 12_000),
          })
          for (const element of fallback) {
            const key = `${element.type}/${element.id}`
            if (seen.has(key)) continue
            seen.add(key)
            collected.push(element)
          }
        } catch (fallbackError) {
          if (overpassError) throw new Error(overpassError)
          // Overpass succeeded with an empty set — that is a valid "nothing nearby" result.
          void fallbackError
        }
      }
      elements = collected
    }

    const hits = elements
      .map(element => elementToHit(element, corridor))
      .filter((item): item is OsmRestrictionHit => Boolean(item))

    const built = buildOsmClearanceEvidence(hits, opts.vehicle, retrievedAt)
    return { ok: true, ...built }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Overpass failed'
    return {
      ok: false,
      error: message,
      retrievedAt,
      hits: [],
      conflicts: [],
      unknownStructures: [],
      checkedOk: 0,
      evidence: [summaryEvidence({ retrievedAt, checkedOk: 0, conflictCount: 0, unknownCount: 0, failed: true, error: message })],
    }
  }
}
