import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { APP_USERS } from './users.ts'
import { DEMO_TOUR_USER_ID, isDemoTourUser } from './demoTourGate.ts'
import {
  DEMO_TOUR_STORAGE_KEY,
  EMPTY_TOUR_PROGRESS,
  TALL_TOUR_ANCHOR_SELECTORS,
  TOUR_SECTION_ORDER,
  TOUR_STEPS,
  acknowledgeWelcome,
  completedSectionsAfterFullWalk,
  dismissWelcome,
  lastStepIdForSection,
  markSectionComplete,
  nonDemoUserIds,
  readTourProgress,
  resetTourProgress,
  sectionsCompletedByAdvance,
  stepsForSection,
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
  assert.match(source, /from ['"]\.\.\/lib\/demoTourGate['"]/)
  assert.match(source, /isDemoTourUser\(user\?\.id\)/)
  assert.match(source, /showDemoTour &&/)
  assert.match(source, /<DemoTour\s*\/>/)
  // Gate only — step defs in lib/demoTour must stay out of the main chunk.
  assert.doesNotMatch(source, /from ['"]\.\.\/lib\/demoTour['"]/)
})

test('tour CSS is not imported from the global stylesheet', () => {
  const indexCss = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  assert.doesNotMatch(indexCss, /demoTour\.css/)
  const tourModule = readFileSync(new URL('../components/demoTour/DemoTour.tsx', import.meta.url), 'utf8')
  assert.match(tourModule, /import '\.\/demoTour\.css'/)
})

test('full tour walk marks every section complete', () => {
  const done = completedSectionsAfterFullWalk(TOUR_STEPS)
  assert.deepEqual(done, [...TOUR_SECTION_ORDER])

  const storage = fakeStorage()
  for (let i = 0; i < TOUR_STEPS.length; i++) {
    for (const section of sectionsCompletedByAdvance(TOUR_STEPS, i, i + 1)) {
      markSectionComplete(section, storage)
    }
  }
  const progress = readTourProgress(storage)
  assert.deepEqual(progress.completedSections, [...TOUR_SECTION_ORDER])
})

test('leaving the last step of a section marks that section', () => {
  const overviewLast = lastStepIdForSection('overview')
  assert.ok(overviewLast)
  const fromIndex = TOUR_STEPS.findIndex(s => s.id === overviewLast)
  const toIndex = fromIndex + 1
  assert.ok(toIndex < TOUR_STEPS.length)
  assert.notEqual(TOUR_STEPS[fromIndex].section, TOUR_STEPS[toIndex].section)
  assert.deepEqual(sectionsCompletedByAdvance(TOUR_STEPS, fromIndex, toIndex), ['overview'])

  // Mid-section advance does not mark complete.
  const firstOverview = TOUR_STEPS.findIndex(s => s.section === 'overview')
  assert.deepEqual(sectionsCompletedByAdvance(TOUR_STEPS, firstOverview, firstOverview + 1), [])

  // Finishing a single-section guide marks that section.
  const jobs = stepsForSection('jobs')
  assert.deepEqual(
    sectionsCompletedByAdvance(jobs, jobs.length - 1, jobs.length),
    ['jobs'],
  )
})

test('no tour step anchors a known-tall page/section container', () => {
  const tall = new Set<string>(TALL_TOUR_ANCHOR_SELECTORS)
  for (const step of TOUR_STEPS) {
    if (!step.anchor) continue
    // Exact match against the denylist (compact child selectors are fine).
    assert.equal(
      tall.has(step.anchor),
      false,
      `${step.id} still anchors tall container ${step.anchor}`,
    )
  }
  // Compact replacements we expect to be in use.
  const anchors = TOUR_STEPS.map(s => s.anchor).filter(Boolean)
  assert.ok(anchors.includes('[data-tour="overview-mode-banner"]'))
  assert.ok(anchors.includes('[data-tour="route-vehicle-heading"]'))
  assert.ok(anchors.includes('[data-tour="route-evidence-heading"]'))
  assert.ok(anchors.includes('[data-tour="activity-history-heading"]'))
})

test('sample permit copy does not hard-promise VERIFY', () => {
  const pick = TOUR_STEPS.find(s => s.id === 'route-pick-sample')
  assert.ok(pick)
  assert.match(pick.body, /Usually VERIFY/i)
  assert.match(pick.body, /live data can change/i)
  assert.doesNotMatch(pick.body, /expects VERIFY/i)
})
