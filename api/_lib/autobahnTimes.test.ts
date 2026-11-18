import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitConcatenatedPlaces } from './autobahnTimes.ts'

test('splits concatenated German place names', () => {
  assert.equal(splitConcatenatedPlaces('BayreuthKulmbach'), 'Bayreuth – Kulmbach')
})

test('preserves OpenStreetMap and ODbL in OSM clearance attribution', () => {
  const detail =
    'OpenStreetMap restriction tags fit. © OpenStreetMap contributors. Data available under the Open Database License (ODbL).'
  assert.equal(splitConcatenatedPlaces(detail), detail)
  assert.doesNotMatch(splitConcatenatedPlaces(detail), /Open – Street – Map/)
  assert.doesNotMatch(splitConcatenatedPlaces(detail), /ODb – L/)
})
