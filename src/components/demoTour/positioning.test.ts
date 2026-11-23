import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMPACT_SHEET_H,
  TALL_SPOT_VIEWPORT_RATIO,
  TALL_VIEWPORT_RATIO,
  clampSpotlightRect,
  computeScrollDelta,
  decideMobileSheetPlacement,
  isUsableSpotlightRect,
  isVisibleAnchorCandidate,
  pickFirstVisibleAnchor,
  placeTooltip,
  rectIntersectsViewport,
  rectsIntersect,
  targetFitsAboveSheet,
  verdictCtaBody,
} from './positioning.ts'

const viewport = { width: 1440, height: 900 }

test('placeTooltip keeps the tip fully inside the viewport', () => {
  const tip = { width: 360, height: 331 }
  // Target near the bottom — below would overflow.
  const target = { top: 763, left: 200, width: 400, height: 120 }
  const placed = placeTooltip(target, tip, viewport)
  assert.ok(placed.top >= 10, `top ${placed.top}`)
  assert.ok(placed.top + tip.height <= viewport.height - 10, `bottom ${placed.top + tip.height}`)
  assert.ok(placed.left >= 10)
  assert.ok(placed.left + tip.width <= viewport.width - 10)
})

test('placeTooltip pins to a corner when nothing beside the target fits', () => {
  const tip = { width: 360, height: 400 }
  // Huge target filling most of the viewport.
  const target = { top: 40, left: 40, width: 1360, height: 820 }
  const placed = placeTooltip(target, tip, viewport)
  assert.equal(placed.placement, 'corner')
  assert.ok(placed.top >= 10)
  assert.ok(placed.top + tip.height <= viewport.height - 10)
  assert.ok(placed.left + tip.width <= viewport.width - 10)
})

test('placeTooltip prefers above when below overflows', () => {
  const tip = { width: 360, height: 200 }
  const target = { top: 750, left: 100, width: 200, height: 80 }
  const placed = placeTooltip(target, tip, viewport)
  assert.ok(placed.placement === 'above' || placed.placement === 'corner')
  assert.ok(placed.top + tip.height <= viewport.height - 10)
})

test('clampSpotlightRect truncates tall targets to ~40vh', () => {
  const tall = { top: 100, left: 50, width: 400, height: 1478 }
  assert.ok(tall.height > viewport.height * TALL_VIEWPORT_RATIO)
  const clamped = clampSpotlightRect(tall, viewport)
  assert.ok(clamped.height <= Math.floor(viewport.height * TALL_SPOT_VIEWPORT_RATIO) + 1)
  assert.ok(clamped.top >= 0)
  assert.ok(clamped.top + clamped.height <= viewport.height)
})

test('clampSpotlightRect keeps normal targets intact (aside from pad clamp)', () => {
  const small = { top: 200, left: 100, width: 240, height: 80 }
  const clamped = clampSpotlightRect(small, viewport)
  assert.equal(clamped.width, 240)
  assert.equal(clamped.height, 80)
})

test('isUsableSpotlightRect rejects closing-dialog ghost rects', () => {
  assert.equal(isUsableSpotlightRect({ top: 0, left: 0, width: 12, height: 12 }), false)
  assert.equal(isUsableSpotlightRect({ top: 100, left: 50, width: 19, height: 40 }), false)
  assert.equal(isUsableSpotlightRect({ top: 100, left: 50, width: 240, height: 80 }), true)
})

test('targetFitsAboveSheet detects when the sheet would cover the target', () => {
  const mobile = { width: 390, height: 844 }
  const button = { top: 618, left: 24, width: 342, height: 48 }
  assert.equal(targetFitsAboveSheet(button, mobile, 306), true)
  const huge = { top: 100, left: 0, width: 390, height: 700 }
  assert.equal(targetFitsAboveSheet(huge, mobile, 300), false)
})

test('rectsIntersect is false when edges only touch', () => {
  const a = { top: 0, left: 0, width: 100, height: 100 }
  const b = { top: 100, left: 0, width: 100, height: 50 }
  assert.equal(rectsIntersect(a, b), false)
  assert.equal(rectsIntersect(a, { ...b, top: 99 }), true)
})

test('decideMobileSheetPlacement flips to top when target sits under the bottom sheet', () => {
  const mobile = { width: 390, height: 844 }
  const sheetH = 280 // → bottom sheet top at 844-56-280 = 508
  // Route check "Run the check" — y 618–674 under the sheet.
  const runCheck = { top: 618, left: 24, width: 342, height: 56 }
  assert.equal(decideMobileSheetPlacement(runCheck, mobile, { sheetHeight: sheetH }), 'sheet-top')
  // "Show sample permits" — y 496–552 overlaps sheet top at 508.
  const samples = { top: 496, left: 24, width: 342, height: 56 }
  assert.equal(decideMobileSheetPlacement(samples, mobile, { sheetHeight: sheetH }), 'sheet-top')
  // Settings "Save changes" — y 691–741.
  const save = { top: 691, left: 24, width: 342, height: 50 }
  assert.equal(decideMobileSheetPlacement(save, mobile, { sheetHeight: sheetH }), 'sheet-top')
})

test('decideMobileSheetPlacement keeps bottom sheet when the target clears it', () => {
  const mobile = { width: 390, height: 844 }
  const clear = { top: 120, left: 24, width: 342, height: 48 }
  assert.equal(decideMobileSheetPlacement(clear, mobile, { sheetHeight: 280 }), 'sheet')
})

test('decideMobileSheetPlacement uses compact when neither full edge clears the target', () => {
  const mobile = { width: 390, height: 844 }
  // Tall corridor panel spanning most of the viewport below the header.
  const tall = { top: 70, left: 0, width: 390, height: 700 }
  const placement = decideMobileSheetPlacement(tall, mobile, {
    sheetHeight: 280,
    compactHeight: COMPACT_SHEET_H,
  })
  assert.ok(
    placement === 'sheet-compact' || placement === 'sheet-compact-top',
    `expected compact, got ${placement}`,
  )
})

test('placeTooltip on mobile returns sheet-top for under-sheet targets', () => {
  const mobile = { width: 390, height: 844 }
  const tip = { width: 366, height: 280 }
  const runCheck = { top: 618, left: 24, width: 342, height: 56 }
  const placed = placeTooltip(runCheck, tip, mobile, {
    sheetHeight: 280,
    decisionSheetHeight: 280,
  })
  assert.equal(placed.placement, 'sheet-top')
})

test('verdictCtaBody mirrors the live verdict label', () => {
  assert.match(verdictCtaBody('HOLD'), /HOLD/)
  assert.match(verdictCtaBody('HOLD'), /Take action/)
  assert.match(verdictCtaBody('VERIFY'), /VERIFY/)
  assert.match(verdictCtaBody('VERIFY'), /Verify before departure/)
  assert.match(verdictCtaBody('READY'), /READY/)
  assert.match(verdictCtaBody('READY'), /Proceed with departure/)
})

test('computeScrollDelta scrolls below-fold targets into the band above the sheet', () => {
  // 390×844 mobile: header 56, sheet from y=508, target clamped at bottom edge.
  const container = { top: 56, height: 732 }
  const headerBottom = 56
  const sheetTop = 508
  const target = { top: 840, height: 48 }
  const delta = computeScrollDelta(target, container, headerBottom, sheetTop)
  // visibleTop = max(56+12, 56+12) = 68 → delta = 840 - 68 = 772
  assert.equal(delta, 840 - 68)
  assert.ok(delta > 0, 'must scroll content up')
})

test('computeScrollDelta is zero when the target already sits in the band', () => {
  const container = { top: 56, height: 732 }
  const target = { top: 120, height: 48 }
  const delta = computeScrollDelta(target, container, 56, 508)
  assert.equal(delta, 0)
})

test('computeScrollDelta pulls a target above the band back down', () => {
  const container = { top: 56, height: 732 }
  const target = { top: 20, height: 40 }
  const delta = computeScrollDelta(target, container, 56, 508)
  // visibleTop = 68 → delta = 20 - 68 = -48 (scroll content down)
  assert.equal(delta, 20 - 68)
  assert.ok(delta < 0)
})

test('computeScrollDelta pins tall targets to the header band', () => {
  const container = { top: 56, height: 732 }
  const target = { top: 200, height: 600 }
  const delta = computeScrollDelta(target, container, 56, 508)
  // bandH = 508-12 - 68 = 428; height 600 > 428 → pin top to 68
  assert.equal(delta, 200 - 68)
})

test('pickFirstVisibleAnchor skips inert/off-screen Switch user for the header chip', () => {
  const mobile = { width: 390, height: 844 }
  // Closed drawer chip: translated off-canvas (looks like Home tab after clamp).
  const sidebarChip = {
    id: 'sidebar-switch',
    rect: { top: 788, left: -200, width: 80, height: 40 },
    inertOrHidden: true,
  }
  const headerChip = {
    id: 'header-switch',
    rect: { top: 8, left: 48, width: 40, height: 40 },
  }
  const picked = pickFirstVisibleAnchor([sidebarChip, headerChip], mobile)
  assert.equal(picked?.id, 'header-switch')
  assert.equal(isVisibleAnchorCandidate(sidebarChip, mobile), false)
  assert.equal(isVisibleAnchorCandidate(headerChip, mobile), true)
  assert.equal(rectIntersectsViewport(sidebarChip.rect, mobile), false)
  assert.equal(rectIntersectsViewport(headerChip.rect, mobile), true)
})

test('pickFirstVisibleAnchor returns an off-screen-but-rendered element when it is the only match', () => {
  const desktop = { width: 1440, height: 900 }
  const belowFold = {
    id: 'below-fold',
    rect: { top: 1200, left: 100, width: 400, height: 80 },
  }
  assert.equal(isVisibleAnchorCandidate(belowFold, desktop), true)
  assert.equal(rectIntersectsViewport(belowFold.rect, desktop), false)
  assert.equal(pickFirstVisibleAnchor([belowFold], desktop)?.id, 'below-fold')
})

test('pickFirstVisibleAnchor prefers the in-viewport match when both are rendered', () => {
  const mobile = { width: 390, height: 844 }
  // Sidebar chip in a closed drawer: rendered size but inert — must lose.
  const sidebarChip = {
    id: 'sidebar-switch',
    rect: { top: 788, left: -200, width: 80, height: 40 },
    inertOrHidden: true,
  }
  const headerChip = {
    id: 'header-switch',
    rect: { top: 8, left: 48, width: 40, height: 40 },
  }
  // Both rendered (neither inert): prefer the one intersecting the viewport.
  const offScreen = {
    id: 'off-screen-copy',
    rect: { top: 1200, left: 24, width: 342, height: 48 },
  }
  const onScreen = {
    id: 'on-screen',
    rect: { top: 100, left: 24, width: 342, height: 48 },
  }
  assert.equal(pickFirstVisibleAnchor([sidebarChip, headerChip], mobile)?.id, 'header-switch')
  assert.equal(pickFirstVisibleAnchor([offScreen, onScreen], mobile)?.id, 'on-screen')
  assert.equal(pickFirstVisibleAnchor([onScreen, offScreen], mobile)?.id, 'on-screen')
})

test('pickFirstVisibleAnchor rejects zero-size, display:none, and visibility:hidden', () => {
  const viewport = { width: 390, height: 844 }
  const zero = { id: 'zero', rect: { top: 10, left: 10, width: 0, height: 40 } }
  const none = {
    id: 'none',
    rect: { top: 10, left: 10, width: 40, height: 40 },
    display: 'none',
  }
  const hidden = {
    id: 'hidden',
    rect: { top: 10, left: 10, width: 40, height: 40 },
    visibility: 'hidden',
  }
  const ok = { id: 'ok', rect: { top: 10, left: 10, width: 40, height: 40 } }
  assert.equal(pickFirstVisibleAnchor([zero, none, hidden, ok], viewport)?.id, 'ok')
  assert.equal(pickFirstVisibleAnchor([zero, none, hidden], viewport), null)
})
