export type Rect = { top: number; left: number; width: number; height: number }

export type TooltipPlacement = 'below' | 'above' | 'center' | 'sheet'

const PAD = 12
const GAP = 10
const SPOT_PAD = 6

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
    top: Math.max(0, rect.top - pad),
    left: Math.max(0, rect.left - pad),
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function measureTooltipSize(el: HTMLElement | null): { width: number; height: number } {
  if (!el) return { width: 360, height: 200 }
  const rect = el.getBoundingClientRect()
  return { width: rect.width || 360, height: rect.height || 200 }
}

export function placeTooltip(
  target: Rect | null,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; placement: TooltipPlacement } {
  if (!target) {
    return {
      top: Math.max(PAD, (viewport.height - tooltip.height) / 2),
      left: Math.max(PAD, (viewport.width - tooltip.width) / 2),
      placement: 'center',
    }
  }

  if (isNarrowViewport(viewport.width)) {
    return {
      top: viewport.height - tooltip.height - 72,
      left: PAD,
      placement: 'sheet',
    }
  }

  const belowTop = target.top + target.height + GAP
  const aboveTop = target.top - tooltip.height - GAP
  const fitsBelow = belowTop + tooltip.height + PAD <= viewport.height
  const fitsAbove = aboveTop >= PAD

  let top: number
  let placement: TooltipPlacement
  if (fitsBelow || (!fitsAbove && belowTop < viewport.height)) {
    top = belowTop
    placement = 'below'
  } else if (fitsAbove) {
    top = aboveTop
    placement = 'above'
  } else {
    top = clamp(target.top, PAD, viewport.height - tooltip.height - PAD)
    placement = 'center'
  }

  const idealLeft = target.left + target.width / 2 - tooltip.width / 2
  const left = clamp(idealLeft, PAD, viewport.width - tooltip.width - PAD)

  return { top, left, placement }
}

export function scrollTargetIntoView(el: Element): void {
  const behavior = prefersReducedMotion() ? 'instant' : 'smooth'
  try {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: behavior as ScrollBehavior })
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
