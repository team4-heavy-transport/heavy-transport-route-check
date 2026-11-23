/**
 * READY / VERIFY / HOLD surface tokens for Overview route cards, list rows, and pills.
 * Keep hex values in sync with `--status-*-fg|bg|border` in `src/index.css` (light + dark).
 */
export type StatusTone = 'ready' | 'verify' | 'hold'

export type StatusTokenPair = {
  fg: string
  bg: string
  border: string
}

/** Light-mode status fg/bg/border (WCAG AA text ≥4.5:1 on bg). */
export const STATUS_TOKENS_LIGHT: Record<StatusTone, StatusTokenPair> = {
  ready: { fg: '#0b6b3a', bg: '#e8f8ef', border: '#34c759' },
  verify: { fg: '#9a5b00', bg: '#fff6e5', border: '#ff9f0a' },
  hold: { fg: '#c41e16', bg: '#ffefee', border: '#ff3b30' },
}

/** Dark-mode status fg/bg/border (WCAG AA text ≥4.5:1 on bg). */
export const STATUS_TOKENS_DARK: Record<StatusTone, StatusTokenPair> = {
  ready: { fg: '#6fde92', bg: '#143528', border: '#30d158' },
  verify: { fg: '#ffd60a', bg: '#3d2e12', border: '#ff9f0a' },
  hold: { fg: '#ffb4ae', bg: '#3b1210', border: '#ff453a' },
}

export const STATUS_TONES: StatusTone[] = ['ready', 'verify', 'hold']
