import { formatBerlinDateTime } from './formatTime'

/** Banner line near Re-check: last checked (Europe/Berlin) and data sources. */
export function formatVerdictCheckedMeta(
  retrievedAt?: string | null,
  source?: string | null,
): string {
  const when = formatBerlinDateTime(retrievedAt)
  const src = (source || '').trim()
  if (when && src) return `Last checked ${when} · ${src}`
  if (when) return `Last checked ${when}`
  if (src) return src
  return ''
}
