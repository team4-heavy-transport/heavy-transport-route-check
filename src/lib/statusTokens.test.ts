import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  STATUS_TOKENS_DARK,
  STATUS_TOKENS_LIGHT,
  STATUS_TONES,
  type StatusTokenPair,
} from './statusTokens.ts'

function parseHex(input: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(input.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function luminance({ r, g, b }: { r: number; g: number; b: number }) {
  const toLin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b)
}

function contrastRatio(fgHex: string, bgHex: string) {
  const fg = parseHex(fgHex)
  const bg = parseHex(bgHex)
  assert.ok(fg, `invalid fg ${fgHex}`)
  assert.ok(bg, `invalid bg ${bgHex}`)
  const L1 = luminance(fg)
  const L2 = luminance(bg)
  const lighter = Math.max(L1, L2)
  const darker = Math.min(L1, L2)
  return (lighter + 0.05) / (darker + 0.05)
}

function assertStatusPairs(label: string, pairs: Record<string, StatusTokenPair>) {
  for (const tone of STATUS_TONES) {
    const { fg, bg } = pairs[tone]
    const ratio = contrastRatio(fg, bg)
    assert.ok(
      ratio >= 4.5,
      `${label} ${tone}: ${fg} on ${bg} contrast ${ratio.toFixed(2)} < 4.5`,
    )
  }
}

test('status token fg/bg pairs meet WCAG AA (≥4.5:1) in light and dark', () => {
  // Values duplicated from CSS `--status-*-fg|bg` — see statusTokens.ts header.
  assertStatusPairs('light', STATUS_TOKENS_LIGHT)
  assertStatusPairs('dark', STATUS_TOKENS_DARK)
})

test('status tones use distinct fg colours (not shared white/black defaults)', () => {
  for (const theme of [STATUS_TOKENS_LIGHT, STATUS_TOKENS_DARK]) {
    const fgs = STATUS_TONES.map(t => theme[t].fg.toLowerCase())
    assert.equal(new Set(fgs).size, 3, `expected 3 distinct status fgs, got ${fgs.join(',')}`)
    for (const fg of fgs) {
      assert.notEqual(fg, '#ffffff')
      assert.notEqual(fg, '#000000')
      assert.notEqual(fg, '#f5f5f7')
      assert.notEqual(fg, '#1c1c1e')
    }
  }
})
