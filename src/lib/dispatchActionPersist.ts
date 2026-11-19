/** Account-save outcome messaging for dispatch decisions and other writes. */

export const DISPATCH_SAVED_NO_NOTIFY =
  'Decision saved – no external notification sent'

export const ACCOUNT_SAVE_FAILED = "Couldn't save to your account"

export type DispatchPersistOutcome = 'synced' | 'failed'

/**
 * History line for a dispatch decision — action label only.
 * Never embed toast/status text (that caused stale "Couldn't save" lines in Redis).
 */
export function dispatchActionLogLine(label: string): string {
  return label.trim()
}

export function dispatchActionToast(outcome: DispatchPersistOutcome): string {
  return outcome === 'synced' ? DISPATCH_SAVED_NO_NOTIFY : ACCOUNT_SAVE_FAILED
}

/** After waitForSyncIdle: account write succeeded when status is ok and nothing is still queued. */
export function resolveDispatchPersistOutcome(status: {
  saveStatus: 'ok' | 'pending' | 'error'
  hasPending: boolean
}): DispatchPersistOutcome {
  if (status.saveStatus === 'ok' && !hasPendingSafe(status)) return 'synced'
  return 'failed'
}

function hasPendingSafe(status: { hasPending: boolean }) {
  return Boolean(status.hasPending)
}

/** Generic account-save toast for profile / job / clearance writes. */
export function accountSaveToast(ok: boolean, successMessage: string): string {
  return ok ? successMessage : ACCOUNT_SAVE_FAILED
}
