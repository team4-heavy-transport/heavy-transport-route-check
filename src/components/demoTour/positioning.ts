export type Rect = { top: number; left: number; width: number; height: number }

export type TooltipPlacement =
  | 'below'
  | 'above'
  | 'left'
  | 'right'
  | 'corner'
  | 'center'
  | 'sheet'
  | 'sheet-top'
  | 'sheet-compact'
  | 'sheet-compact-top'

export type MobileSheetPlacement = 'sheet' | 'sheet-top' | 'sheet-compact' | 'sheet-compact-top'

const PAD = 10
const GAP = 10
const SPOT_PAD = 6
const HEADER_H = 56
/** Mobile tab bar clearance under the bottom sheet (matches `.is-sheet` CSS). */
const TAB_BAR_H = 56
/** Gap below the header for a top sheet (matches `.is-sheet-top` CSS). */
const SHEET_TOP_GAP = 8
/** One-line compact sheet (title + Next), including padding. */
export const COMPACT_SHEET_H = 64
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

/** True when a clamped spotlight is large enough to be a real target (not a closing dialog ghost). */
export function isUsableSpotlightRect(rect: Rect): boolean {
  return rect.width >= 20 && rect.height >= 20
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

/** Axis-aligned rectangle intersection (edges touching count as no overlap). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  )
}

function sheetRectAtBottom(
  viewport: { width: number; height: number },
  sheetHeight: number,
  tabBarHeight = TAB_BAR_H,
): Rect {
  return {
    top: viewport.height - tabBarHeight - sheetHeight,
    left: 0,
    width: viewport.width,
    height: sheetHeight,
  }
}

function sheetRectAtTop(
  viewport: { width: number; height: number },
  sheetHeight: number,
  headerBottom = HEADER_H,
  gap = SHEET_TOP_GAP,
): Rect {
  return {
    top: headerBottom + gap,
    left: 0,
    width: viewport.width,
    height: sheetHeight,
  }
}

/**
 * After scroll/remeasure: pick bottom sheet, top sheet, or a compact one-line
 * variant so the tip does not cover the spotlight target.
 */
export function decideMobileSheetPlacement(
  target: Rect,
  viewport: { width: number; height: number },
  opts: {
    sheetHeight: number
    compactHeight?: number
    headerBottom?: number
    tabBarHeight?: number
  },
): MobileSheetPlacement {
  const sheetH = opts.sheetHeight
  const compactH = opts.compactHeight ?? COMPACT_SHEET_H
  const headerBottom = opts.headerBottom ?? HEADER_H
  const tabBarHeight = opts.tabBarHeight ?? TAB_BAR_H

  const bottomFull = sheetRectAtBottom(viewport, sheetH, tabBarHeight)
  const topFull = sheetRectAtTop(viewport, sheetH, headerBottom)

  if (!rectsIntersect(target, bottomFull)) return 'sheet'
  if (!rectsIntersect(target, topFull)) return 'sheet-top'

  const bottomCompact = sheetRectAtBottom(viewport, compactH, tabBarHeight)
  const topCompact = sheetRectAtTop(viewport, compactH, headerBottom)

  if (!rectsIntersect(target, bottomCompact)) return 'sheet-compact'
  if (!rectsIntersect(target, topCompact)) return 'sheet-compact-top'

  // Tall target still overlaps both compact edges — pick the smaller overlap.
  const overlap = (sheet: Rect) => {
    const top = Math.max(target.top, sheet.top)
    const bottom = Math.min(target.top + target.height, sheet.top + sheet.height)
    return Math.max(0, bottom - top)
  }
  return overlap(bottomCompact) <= overlap(topCompact) ? 'sheet-compact' : 'sheet-compact-top'
}

/**
 * Place the tip fully inside the viewport (PAD margin). Prefers below → above →
 * right → left; if nothing fits beside the target, pins to a viewport corner.
 */
export function placeTooltip(
  target: Rect | null,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: {
    sheetHeight?: number
    /** Stable full-sheet height for collision (avoids compact↔full oscillation). */
    decisionSheetHeight?: number
    preferSheetTop?: boolean
    compactHeight?: number
  } = {},
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
    const decisionH =
      opts.decisionSheetHeight ??
      Math.max(sheetH, Math.min(280, Math.floor(viewport.height * 0.36)))
    const placement = opts.preferSheetTop
      ? ('sheet-top' as MobileSheetPlacement)
      : decideMobileSheetPlacement(target, viewport, {
          sheetHeight: decisionH,
          compactHeight: opts.compactHeight,
        })
    if (placement === 'sheet-top' || placement === 'sheet-compact-top') {
      return { top: HEADER_H + SHEET_TOP_GAP, left: PAD, placement }
    }
    if (placement === 'sheet-compact') {
      return {
        top: Math.max(PAD, viewport.height - COMPACT_SHEET_H - TAB_BAR_H),
        left: PAD,
        placement,
      }
    }
    return {
      top: Math.max(PAD, viewport.height - sheetH - TAB_BAR_H),
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

/** Snapshot used by the pure visible-anchor picker (unit-testable with fake rects). */
export type VisibleAnchorCandidate = {
  rect: Rect
  /** From getComputedStyle(el).display */
  display?: string
  /** From getComputedStyle(el).visibility */
  visibility?: string
  /** True when the element or an ancestor is inert / [hidden]. */
  inertOrHidden?: boolean
}

/** True when rect has size and overlaps the viewport (edges touching count as no overlap). */
export function rectIntersectsViewport(
  rect: Rect,
  viewport: { width: number; height: number },
): boolean {
  if (!(rect.width > 0 && rect.height > 0)) return false
  return rectsIntersect(rect, {
    top: 0,
    left: 0,
    width: viewport.width,
    height: viewport.height,
  })
}

/**
 * Pure visibility gate for tour anchors. Prefer this over querySelector so
 * off-screen / inert drawer duplicates (e.g. sidebar Switch user) lose to the
 * on-screen header chip.
 */
export function isVisibleAnchorCandidate(
  candidate: VisibleAnchorCandidate,
  viewport: { width: number; height: number },
): boolean {
  if (candidate.inertOrHidden) return false
  if (candidate.display === 'none') return false
  if (candidate.visibility === 'hidden' || candidate.visibility === 'collapse') return false
  return rectIntersectsViewport(candidate.rect, viewport)
}

/** First candidate that passes {@link isVisibleAnchorCandidate}, else null. */
export function pickFirstVisibleAnchor<T extends VisibleAnchorCandidate>(
  candidates: readonly T[],
  viewport: { width: number; height: number },
): T | null {
  for (const c of candidates) {
    if (isVisibleAnchorCandidate(c, viewport)) return c
  }
  return null
}

function hasInertOrHiddenAncestor(el: Element): boolean {
  let node: Element | null = el
  while (node) {
    if (node.hasAttribute('hidden')) return true
    if (node.hasAttribute('inert')) return true
    if (node instanceof HTMLElement && node.inert) return true
    node = node.parentElement
  }
  return false
}

function viewportSize(): { width: number; height: number } {
  return {
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  }
}

/** Live DOM check: non-zero rect, style ok, not inert/hidden, intersects viewport. */
export function isElementVisibleAnchor(
  el: Element,
  viewport: { width: number; height: number } = viewportSize(),
): boolean {
  if (hasInertOrHiddenAncestor(el)) return false
  let display: string | undefined
  let visibility: string | undefined
  try {
    const style = getComputedStyle(el)
    display = style.display
    visibility = style.visibility
  } catch {
    // Non-DOM / test stubs without getComputedStyle.
  }
  const box = el.getBoundingClientRect()
  return isVisibleAnchorCandidate(
    {
      rect: { top: box.top, left: box.left, width: box.width, height: box.height },
      display,
      visibility,
    },
    viewport,
  )
}

/** querySelectorAll + first visible match (DOM order). */
export function queryVisibleSelector(
  selector: string,
  opts: {
    root?: ParentNode
    viewport?: { width: number; height: number }
  } = {},
): Element | null {
  const root = opts.root ?? document
  const viewport = opts.viewport ?? viewportSize()
  const matches = root.querySelectorAll(selector)
  for (const el of matches) {
    if (isElementVisibleAnchor(el, viewport)) return el
  }
  return null
}

/** Poll / MutationObserver until a *visible* selector match appears or timeout. */
export function waitForSelector(
  selector: string,
  opts: { timeoutMs?: number; root?: ParentNode } = {},
): Promise<Element | null> {
  const { timeoutMs = 4000, root = document } = opts
  const existing = queryVisibleSelector(selector, { root })
  if (existing) return Promise.resolve(existing)

  return new Promise(resolve => {
    const started = Date.now()
    const check = () => {
      const found = queryVisibleSelector(selector, { root })
      if (found) {
        cleanup()
        resolve(found)
      } else if (Date.now() - started >= timeoutMs) {
        cleanup()
        resolve(null)
      }
    }
    const observer = new MutationObserver(check)
    const timer = window.setInterval(check, 120)
    const cleanup = () => {
      observer.disconnect()
      window.clearInterval(timer)
    }
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
  })
}

export function clickSelector(selector: string): boolean {
  const el = queryVisibleSelector(selector)
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
