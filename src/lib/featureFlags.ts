/**
 * Feature flags (Vite `VITE_*` env). Defaults are off unless set to the string `true`.
 * Safe under Node/tsx tests where `import.meta.env` may be undefined.
 */

function viteEnvFlag(name: string): boolean {
  try {
    const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    return env?.[name] === 'true'
  } catch {
    return false
  }
}

/** When true, Jobs (`/jobs`) and Alerts & history (`/activity`) appear in nav and are routable. */
export const FEATURE_JOBS_AND_ALERTS_PAGES = viteEnvFlag('VITE_FEATURE_JOBS_AND_ALERTS_PAGES')
