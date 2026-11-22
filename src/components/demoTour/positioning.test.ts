import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TALL_SPOT_VIEWPORT_RATIO,
  TALL_VIEWPORT_RATIO,
  clampSpotlightRect,
  computeScrollDelta,
  placeTooltip,
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

test('targetFitsAboveSheet detects when the sheet would cover the target', () => {
  const mobile = { width: 390, height: 844 }
  const button = { top: 618, left: 24, width: 342, height: 48 }
  assert.equal(targetFitsAboveSheet(button, mobile, 306), true)
  const huge = { top: 100, left: 0, width: 390, height: 700 }
  assert.equal(targetFitsAboveSheet(huge, mobile, 300), false)
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
