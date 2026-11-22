import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { APP_USERS } from './users.ts'
import {
  DEMO_TOUR_STORAGE_KEY,
  DEMO_TOUR_USER_ID,
  EMPTY_TOUR_PROGRESS,
  TOUR_SECTION_ORDER,
  TOUR_STEPS,
  acknowledgeWelcome,
  dismissWelcome,
  isDemoTourUser,
  markSectionComplete,
  nonDemoUserIds,
  readTourProgress,
  resetTourProgress,
  writeTourProgress,
} from './demoTour.ts'

function fakeStorage() {
  const memory = new Map<string, string>()
  return {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value) },
    removeItem: (key: string) => { memory.delete(key) },
    memory,
  }
}

test('isDemoTourUser is true only for demo', () => {
  assert.equal(isDemoTourUser('demo'), true)
  assert.equal(isDemoTourUser(DEMO_TOUR_USER_ID), true)
  assert.equal(isDemoTourUser('Demo'), false)
  assert.equal(isDemoTourUser(''), false)
  assert.equal(isDemoTourUser(null), false)
  assert.equal(isDemoTourUser(undefined), false)
  for (const id of nonDemoUserIds()) {
    assert.equal(isDemoTourUser(id), false, `expected false for ${id}`)
  }
  for (const user of APP_USERS) {
    assert.equal(isDemoTourUser(user.id), user.id === 'demo')
  }
})

test('every tour step has section, title, and body', () => {
  assert.ok(TOUR_STEPS.length > 10)
  for (const step of TOUR_STEPS) {
    assert.ok(step.id, 'step id')
    assert.ok(TOUR_SECTION_ORDER.includes(step.section), `section ${step.section}`)
    assert.ok(step.title.trim().length > 0, step.id)
    assert.ok(step.body.trim().length > 0, step.id)
  }
})

test('tour section order matches TOUR_SECTION_ORDER', () => {
  const seen: string[] = []
  for (const step of TOUR_STEPS) {
    if (seen[seen.length - 1] !== step.section) seen.push(step.section)
  }
  assert.deepEqual(seen, [...TOUR_SECTION_ORDER])
})

test('progress helpers read/write only the Demo-scoped key', () => {
  const storage = fakeStorage()
  assert.deepEqual(readTourProgress(storage), EMPTY_TOUR_PROGRESS)

  writeTourProgress({
    welcomeSeen: true,
    completedSections: ['overview'],
    tourDismissed: false,
  }, storage)

  assert.equal(storage.memory.size, 1)
  assert.ok(storage.memory.has(DEMO_TOUR_STORAGE_KEY))
  assert.equal(storage.memory.has('htr-current-user'), false)

  const loaded = readTourProgress(storage)
  assert.equal(loaded.welcomeSeen, true)
  assert.deepEqual(loaded.completedSections, ['overview'])

  const afterSection = markSectionComplete('jobs', storage)
  assert.ok(afterSection.completedSections.includes('overview'))
  assert.ok(afterSection.completedSections.includes('jobs'))

  const dismissed = dismissWelcome(storage)
  assert.equal(dismissed.welcomeSeen, true)
  assert.equal(dismissed.tourDismissed, true)

  const ack = acknowledgeWelcome(storage)
  assert.equal(ack.welcomeSeen, true)

  const reset = resetTourProgress(storage)
  assert.equal(reset.welcomeSeen, true)
  assert.equal(reset.tourDismissed, false)
  assert.deepEqual(reset.completedSections, [])

  // Never touch unrelated keys
  storage.setItem('htr-current-user', 'demo')
  writeTourProgress(EMPTY_TOUR_PROGRESS, storage)
  assert.equal(storage.getItem('htr-current-user'), 'demo')
  assert.ok(storage.getItem(DEMO_TOUR_STORAGE_KEY))
})

test('Layout gates DemoTour behind isDemoTourUser and lazy import', () => {
  const source = readFileSync(new URL('../components/Layout.tsx', import.meta.url), 'utf8')
  assert.match(source, /lazy\(\(\)\s*=>\s*import\('\.\/demoTour\/DemoTour'\)\)/)
  assert.match(source, /isDemoTourUser\(user\?\.id\)/)
  assert.match(source, /showDemoTour &&/)
  assert.match(source, /<DemoTour\s*\/>/)
})

test('tour CSS is not imported from the global stylesheet', () => {
  const indexCss = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  assert.doesNotMatch(indexCss, /demoTour\.css/)
  const tourModule = readFileSync(new URL('../components/demoTour/DemoTour.tsx', import.meta.url), 'utf8')
  assert.match(tourModule, /import '\.\/demoTour\.css'/)
})
