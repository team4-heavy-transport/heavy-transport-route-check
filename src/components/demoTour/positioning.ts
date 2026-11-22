export type Rect = { top: number; left: number; width: number; height: number }

export type TooltipPlacement = 'below' | 'above' | 'left' | 'right' | 'corner' | 'center' | 'sheet' | 'sheet-top'

const PAD = 10
const GAP = 10
const SPOT_PAD = 6
const HEADER_H = 56
/** Target taller than this fraction of the viewport is truncated for the spotlight. */
export const TALL_VIEWPORT_RATIO = 0.6
/** Spotlight shows at most this fraction of the viewport height for tall targets. */
export const TALL_SPOT_VIEWPORT_RATIO = 0.4

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function isNarrowViewport(width = typeof window !== 'undefined' ? window.innerWidth : 1440): boolean {
  return width <= 720
}

export function expandRect(rect: DOMRect | Rect, pad = SPOT_PAD): Rect {
  return {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Keep the spotlight inside the viewport; optionally truncate tall targets from the top. */
export function clampSpotlightRect(
  rect: Rect,
  viewport: { width: number; height: number },
): Rect {
  let { top, left, width, height } = rect

  const maxSpotH = Math.floor(viewport.height * TALL_SPOT_VIEWPORT_RATIO)
  if (height > viewport.height * TALL_VIEWPORT_RATIO) {
    height = Math.min(height, maxSpotH)
  }

  // Clamp into viewport with a small inset so the outline stays visible.
  left = clamp(left, 0, Math.max(0, viewport.width - 4))
  top = clamp(top, 0, Math.max(0, viewport.height - 4))
  width = Math.min(width, viewport.width - left)
  height = Math.min(height, viewport.height - top)
  width = Math.max(4, width)
  height = Math.max(4, height)

  return { top, left, width, height }
}

export function measureTooltipSize(el: HTMLElement | null): { width: number; height: number } {
  if (!el) return { width: 360, height: 200 }
  const rect = el.getBoundingClientRect()
  return { width: rect.width || 360, height: rect.height || 200 }
}

function fitsVertically(top: number, height: number, viewportH: number): boolean {
  return top >= PAD && top + height + PAD <= viewportH
}

function fitsHorizontally(left: number, width: number, viewportW: number): boolean {
  return left >= PAD && left + width + PAD <= viewportW
}

/**
 * Place the tip fully inside the viewport (PAD margin). Prefers below → above →
 * right → left; if nothing fits beside the target, pins to a viewport corner.
 */
export function placeTooltip(
  target: Rect | null,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { sheetHeight?: number; preferSheetTop?: boolean } = {},
): { top: number; left: number; placement: TooltipPlacement } {
  const tipW = Math.min(tooltip.width, viewport.width - PAD * 2)
  const tipH = Math.min(tooltip.height, viewport.height - PAD * 2)

  if (!target) {
    return {
      top: Math.max(PAD, (viewport.height - tipH) / 2),
      left: Math.max(PAD, (viewport.width - tipW) / 2),
      placement: 'center',
    }
  }

  if (isNarrowViewport(viewport.width)) {
    const sheetH = opts.sheetHeight ?? tipH
    if (opts.preferSheetTop) {
      return { top: HEADER_H + PAD, left: PAD, placement: 'sheet-top' }
    }
    return {
      top: Math.max(PAD, viewport.height - sheetH - 72),
      left: PAD,
      placement: 'sheet',
    }
  }

  const belowTop = target.top + target.height + GAP
  const aboveTop = target.top - tipH - GAP
  const rightLeft = target.left + target.width + GAP
  const leftLeft = target.left - tipW - GAP

  const candidates: Array<{ top: number; left: number; placement: TooltipPlacement }> = [
    {
      top: belowTop,
      left: clamp(target.left + target.width / 2 - tipW / 2, PAD, viewport.width - tipW - PAD),
      placement: 'below',
    },
    {
      top: aboveTop,
      left: clamp(target.left + target.width / 2 - tipW / 2, PAD, viewport.width - tipW - PAD),
      placement: 'above',
    },
    {
      top: clamp(target.top + target.height / 2 - tipH / 2, PAD, viewport.height - tipH - PAD),
      left: rightLeft,
      placement: 'right',
    },
    {
      top: clamp(target.top + target.height / 2 - tipH / 2, PAD, viewport.height - tipH - PAD),
      left: leftLeft,
      placement: 'left',
    },
  ]

  for (const c of candidates) {
    if (fitsVertically(c.top, tipH, viewport.height) && fitsHorizontally(c.left, tipW, viewport.width)) {
      return c
    }
  }

  // Nothing fits beside the target — pin fully inside a viewport corner (prefer bottom-right).
  const cornerLeft = viewport.width - tipW - PAD
  const cornerTop = viewport.height - tipH - PAD
  return {
    top: clamp(cornerTop, PAD, Math.max(PAD, viewport.height - tipH - PAD)),
    left: clamp(cornerLeft, PAD, Math.max(PAD, viewport.width - tipW - PAD)),
    placement: 'corner',
  }
}

/** Whether the target can sit fully in the band above a bottom sheet. */
export function targetFitsAboveSheet(
  target: Rect,
  viewport: { width: number; height: number },
  sheetHeight: number,
): boolean {
  const available = viewport.height - HEADER_H - sheetHeight - PAD * 2
  return target.height <= available
}

const SCROLL_MARGIN = 12

/**
 * Pure scroll math: how much to change scrollTop so the target's top lands in the
 * visible band between headerBottom+margin and sheetTop−margin (viewport coords).
 * Positive delta → scroll content up (increase scrollTop).
 */
export function computeScrollDelta(
  targetRect: { top: number; height: number },
  containerRect: { top: number; height: number },
  headerBottom: number,
  sheetTop: number,
  margin = SCROLL_MARGIN,
): number {
  const visibleTop = Math.max(headerBottom + margin, containerRect.top + margin)
  const visibleBottom = Math.min(sheetTop - margin, containerRect.top + containerRect.height - margin)
  const bandH = visibleBottom - visibleTop
  if (bandH <= 0) {
    return targetRect.top - (headerBottom + margin)
  }

  const targetBottom = targetRect.top + targetRect.height

  // Tall target: pin its top just under the header band.
  if (targetRect.height > bandH) {
    return targetRect.top - visibleTop
  }

  // Fully inside the band — no scroll.
  if (targetRect.top >= visibleTop && targetBottom <= visibleBottom) {
    return 0
  }

  // Above the band: bring top down to visibleTop.
  if (targetRect.top < visibleTop) {
    return targetRect.top - visibleTop
  }

  // Below the band: place top at visibleTop (fits by definition when height ≤ bandH).
  return targetRect.top - visibleTop
}

/** Nearest ancestor that actually scrolls (overflow-y auto/scroll and overflow content). */
export function findScrollableAncestor(el: Element): HTMLElement | null {
  let parent = el.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    const overflowY = style.overflowY
    const scrollableY =
      overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
    if (scrollableY && parent.scrollHeight > parent.clientHeight + 1) {
      return parent
    }
    parent = parent.parentElement
  }
  return null
}

/** Wait two animation frames so layout/scroll settle before re-measure. */
export function afterScrollFrames(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'undefined') {
      resolve()
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

/**
 * Scroll so the target sits in the visible band (above a bottom sheet on mobile).
 * Prefers the nearest scrollable ancestor (e.g. `.app-page-host`); falls back to window.
 */
export function scrollTargetIntoView(
  el: Element,
  opts: {
    sheetHeight?: number
    headerHeight?: number
    /** Absolute viewport Y of the sheet top when known (preferred over sheetHeight). */
    sheetTop?: number
  } = {},
): void {
  const behavior = prefersReducedMotion() ? 'instant' : 'smooth'
  const headerBottom = opts.headerHeight ?? HEADER_H
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800
  const sheetTop =
    opts.sheetTop ??
    (opts.sheetHeight && opts.sheetHeight > 0 ? viewportH - opts.sheetHeight : viewportH)

  try {
    const targetRect = el.getBoundingClientRect()
    const scrollParent = findScrollableAncestor(el)

    if (scrollParent) {
      const containerRect = scrollParent.getBoundingClientRect()
      const delta = computeScrollDelta(targetRect, containerRect, headerBottom, sheetTop)
      if (Math.abs(delta) > 2) {
        const maxScroll = scrollParent.scrollHeight - scrollParent.clientHeight
        const next = clamp(scrollParent.scrollTop + delta, 0, Math.max(0, maxScroll))
        if (typeof scrollParent.scrollTo === 'function') {
          scrollParent.scrollTo({ top: next, behavior: behavior as ScrollBehavior })
        } else {
          scrollParent.scrollTop = next
        }
      }
      return
    }

    // Fall back to window / document scrolling element.
    const containerRect = { top: 0, height: viewportH }
    const delta = computeScrollDelta(targetRect, containerRect, headerBottom, sheetTop)
    if (Math.abs(delta) > 2) {
      window.scrollBy({ top: delta, behavior: behavior as ScrollBehavior })
      return
    }

    const narrow = isNarrowViewport(window.innerWidth)
    el.scrollIntoView({
      block: narrow ? 'start' : 'center',
      inline: 'nearest',
      behavior: behavior as ScrollBehavior,
    })
  } catch {
    el.scrollIntoView(true)
  }
}

/** Poll / MutationObserver until selector matches or timeout. */
export function waitForSelector(
  selector: string,
  opts: { timeoutMs?: number; root?: ParentNode } = {},
): Promise<Element | null> {
  const { timeoutMs = 4000, root = document } = opts
  const existing = root.querySelector(selector)
  if (existing) return Promise.resolve(existing)

  return new Promise(resolve => {
    const started = Date.now()
    const observer = new MutationObserver(() => {
      const found = root.querySelector(selector)
      if (found) {
        cleanup()
        resolve(found)
      } else if (Date.now() - started >= timeoutMs) {
        cleanup()
        resolve(null)
      }
    })
    const timer = window.setInterval(() => {
      const found = root.querySelector(selector)
      if (found) {
        cleanup()
        resolve(found)
      } else if (Date.now() - started >= timeoutMs) {
        cleanup()
        resolve(null)
      }
    }, 120)
    const cleanup = () => {
      observer.disconnect()
      window.clearInterval(timer)
    }
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
  })
}

export function clickSelector(selector: string): boolean {
  const el = document.querySelector(selector)
  if (!el) return false
  if (el instanceof HTMLElement) {
    el.click()
    return true
  }
  return false
}

/** App dialogs/sheets that should take focus over the tour. */
export const APP_DIALOG_SELECTOR =
  '.action-sheet-overlay[role="dialog"], .dialog-overlay[role="dialog"]'

/** Click Cancel / close inside the open app dialog or sheet. */
export function clickAppDialogDismiss(root: ParentNode = document): boolean {
  const dialog = root.querySelector(APP_DIALOG_SELECTOR)
  if (!dialog) return false
  const buttons = Array.from(dialog.querySelectorAll('button'))
  const cancel =
    buttons.find(btn => /^\s*cancel\s*$/i.test(btn.textContent || '')) ||
    buttons.find(btn => /cancel/i.test(btn.textContent || '')) ||
    dialog.querySelector('button.btn-secondary')
  if (cancel instanceof HTMLElement) {
    cancel.click()
    return true
  }
  return false
}

export function isAppDialogOpen(root: ParentNode = document): boolean {
  return Boolean(root.querySelector(APP_DIALOG_SELECTOR))
}

export function readVerdictFromDom(root: ParentNode = document): 'READY' | 'VERIFY' | 'HOLD' | null {
  const banner = root.querySelector('[data-tour="route-verdict-banner"]')
  if (!banner) return null
  const cls = typeof banner.className === 'string' ? banner.className : ''
  if (/\bverdict-hold\b/i.test(cls) || /\bverdict-red\b/i.test(cls)) return 'HOLD'
  if (/\bverdict-verify\b/i.test(cls) || /\bverdict-amber\b/i.test(cls) || /\bverdict-yellow\b/i.test(cls)) {
    return 'VERIFY'
  }
  if (/\bverdict-ready\b/i.test(cls) || /\bverdict-green\b/i.test(cls)) return 'READY'
  const label = banner.querySelector('.verdict-label')?.textContent?.trim().toUpperCase()
  if (label === 'READY' || label === 'VERIFY' || label === 'HOLD') return label
  const cta = root.querySelector('[data-tour="route-verdict-cta"]')?.textContent?.trim() ?? ''
  if (/take action/i.test(cta)) return 'HOLD'
  if (/verify before/i.test(cta)) return 'VERIFY'
  if (/proceed/i.test(cta)) return 'READY'
  return null
}

export function verdictCtaBody(verdict: 'READY' | 'VERIFY' | 'HOLD' | null): string {
  if (verdict === 'HOLD') {
    return 'Your result is HOLD, so the button is Take action — it lists what you can do next (review, escalate, hold departure, or request an on-site check).'
  }
  if (verdict === 'VERIFY') {
    return 'Your result is VERIFY, so the button is Verify before departure — it opens a dialog to log an on-site check request.'
  }
  if (verdict === 'READY') {
    return 'Your result is READY, so the button is Proceed with departure — use it when the live feeds look clear for this permit.'
  }
  return 'The button matches the verdict: Proceed with departure (READY), Verify before departure (on-site request), or Take action (HOLD options).'
}
