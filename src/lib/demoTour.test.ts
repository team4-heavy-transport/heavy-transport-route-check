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
  TOUR_SECTIONS,
  TOUR_STEPS,
  acknowledgeWelcome,
  completedSectionsAfterFullWalk,
  dismissWelcome,
  flowAccessibleName,
  isFlowDone,
  isFullTourDone,
  lastStepIdForSection,
  markSectionComplete,
  nextIncompleteFlowId,
  nonDemoUserIds,
  readTourProgress,
  resetTourProgress,
  sectionsCompletedByAdvance,
  stepsForFullTour,
  stepsForSection,
  tourFlowEntries,
  writeTourProgress,
  TOUR_FLOW_DESCRIPTIONS,
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

test('tour root portals to body with a top-most stacking layer', () => {
  const tourModule = readFileSync(new URL('../components/demoTour/DemoTour.tsx', import.meta.url), 'utf8')
  assert.match(tourModule, /createPortal\(\s*<div className="demo-tour-root"/)
  assert.match(tourModule, /document\.body/)
  const tourCss = readFileSync(new URL('../components/demoTour/demoTour.css', import.meta.url), 'utf8')
  assert.match(tourCss, /z-index:\s*2147483000/)
  assert.match(tourCss, /--demo-tour-z-overlay:\s*2147483000/)
  assert.match(tourCss, /--demo-tour-z-tooltip:\s*2147483010/)
})

test('full tour walk marks every section complete', () => {
  const fullSteps = stepsForFullTour()
  const done = completedSectionsAfterFullWalk(fullSteps)
  assert.deepEqual(done, [...TOUR_SECTION_ORDER])

  const storage = fakeStorage()
  for (let i = 0; i < fullSteps.length; i++) {
    for (const section of sectionsCompletedByAdvance(fullSteps, i, i + 1)) {
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
  assert.ok(anchors.includes('[data-tour="overview-workflow"]'))
  assert.ok(anchors.includes('[data-tour="overview-check-new"]'))
  assert.ok(anchors.includes('[data-tour="route-vehicle-heading"]'))
  assert.ok(anchors.includes('[data-tour="route-evidence-heading"]'))
  assert.ok(anchors.includes('[data-tour="route-open-fullmap"]'))
  assert.ok(anchors.includes('[data-tour="activity-history-heading"]'))
})

test('sample permit copy does not hard-promise VERIFY', () => {
  const pick = TOUR_STEPS.find(s => s.id === 'route-pick-sample')
  assert.ok(pick)
  assert.match(pick.body, /Usually VERIFY/i)
  assert.match(pick.body, /live data can change/i)
  assert.doesNotMatch(pick.body, /expects VERIFY/i)
})

test('chrome-switch has mobile copy pointing at the header initials chip', () => {
  const step = TOUR_STEPS.find(s => s.id === 'chrome-switch')
  assert.ok(step)
  assert.equal(step.anchor, '[data-tour="switch-user"]')
  assert.ok(step.bodyNarrow)
  assert.match(step.bodyNarrow, /Tap your initials at the top to switch user/i)
})

test('flow picker list order and step counts derive from step definitions', () => {
  const flows = tourFlowEntries()
  assert.equal(flows.length, 1 + TOUR_SECTIONS.length)
  assert.equal(flows[0].id, 'full')
  assert.equal(flows[0].label, 'Full tour')
  assert.equal(flows[0].stepCount, stepsForFullTour().length)
  assert.ok(flows[0].description.trim().length > 0)

  const sectionFlows = flows.slice(1)
  assert.deepEqual(
    sectionFlows.map(f => f.id),
    [...TOUR_SECTION_ORDER],
  )
  for (const entry of sectionFlows) {
    assert.equal(entry.stepCount, stepsForSection(entry.id as typeof TOUR_SECTION_ORDER[number]).length)
    assert.ok(entry.description.trim().length > 0)
    assert.match(entry.description, /[a-z]/i)
  }

  const jobs = flows.find(f => f.id === 'jobs')
  assert.ok(jobs)
  assert.equal(
    flowAccessibleName(jobs, false),
    `Jobs, ${jobs.stepCount} steps`,
  )
  assert.equal(
    flowAccessibleName(jobs, true),
    `Jobs, ${jobs.stepCount} steps, done`,
  )
})

test('Route check single flow ends on Job saved; full tour skips that closer', () => {
  const routeSteps = stepsForSection('route-check')
  assert.equal(routeSteps.length, 16)
  assert.equal(routeSteps[routeSteps.length - 1]?.id, 'route-job-saved')
  assert.equal(routeSteps[routeSteps.length - 2]?.id, 'route-save-submit')
  assert.ok(routeSteps.some(s => s.id === 'route-open-fullmap'))
  assert.ok(routeSteps[routeSteps.length - 2]?.doItLabel)
  assert.equal(routeSteps[routeSteps.length - 1]?.doItLabel, undefined)
  assert.equal(routeSteps[routeSteps.length - 1]?.nextFlowCta?.section, 'jobs')

  const fullSteps = stepsForFullTour()
  assert.ok(!fullSteps.some(s => s.id === 'route-job-saved'))
  assert.ok(!fullSteps.some(s => s.singleFlowOnly))
  const routeInFull = fullSteps.filter(s => s.section === 'route-check')
  assert.equal(routeInFull[routeInFull.length - 1]?.id, 'route-save-submit')
  const saveIdx = fullSteps.findIndex(s => s.id === 'route-save-submit')
  assert.ok(saveIdx >= 0)
  assert.equal(fullSteps[saveIdx + 1]?.section, 'jobs')
})

test('final step of every single flow has no do-it action', () => {
  for (const section of TOUR_SECTION_ORDER) {
    const steps = stepsForSection(section)
    const last = steps[steps.length - 1]
    assert.ok(last, section)
    assert.equal(
      last.doItLabel,
      undefined,
      `${section} last step ${last.id} must not carry a do-it action`,
    )
  }
})

test('picker and step copy avoid CTA jargon', () => {
  for (const [id, description] of Object.entries(TOUR_FLOW_DESCRIPTIONS)) {
    assert.doesNotMatch(description, /\bCTA\b/, `${id} description`)
  }
  for (const step of TOUR_STEPS) {
    assert.doesNotMatch(step.title, /\bCTA\b/, step.id)
    assert.doesNotMatch(step.body, /\bCTA\b/, step.id)
    if (step.bodyNarrow) assert.doesNotMatch(step.bodyNarrow, /\bCTA\b/, step.id)
  }
  assert.match(
    TOUR_FLOW_DESCRIPTIONS.overview,
    /Check new route/i,
  )
  assert.equal(stepsForSection('overview').length, 8)
})

test('completing a single flow marks only that flow; full tour done = all flows', () => {
  const storage = fakeStorage()
  assert.equal(isFlowDone('jobs', readTourProgress(storage)), false)
  assert.equal(isFullTourDone(readTourProgress(storage)), false)

  markSectionComplete('jobs', storage)
  const afterJobs = readTourProgress(storage)
  assert.deepEqual(afterJobs.completedSections, ['jobs'])
  assert.equal(isFlowDone('jobs', afterJobs), true)
  assert.equal(isFlowDone('overview', afterJobs), false)
  assert.equal(isFlowDone('full', afterJobs), false)
  assert.equal(isFullTourDone(afterJobs), false)
  assert.equal(nextIncompleteFlowId(afterJobs), 'overview')

  for (const id of TOUR_SECTION_ORDER) {
    markSectionComplete(id, storage)
  }
  const allDone = readTourProgress(storage)
  for (const id of TOUR_SECTION_ORDER) {
    assert.ok(allDone.completedSections.includes(id), `missing ${id}`)
  }
  assert.equal(allDone.completedSections.length, TOUR_SECTION_ORDER.length)
  assert.equal(isFullTourDone(allDone), true)
  assert.equal(isFlowDone('full', allDone), true)
  assert.equal(nextIncompleteFlowId(allDone), 'full')
})

test('reset clears completed flows; old stored shape still parses', () => {
  const storage = fakeStorage()
  markSectionComplete('alerts', storage)
  markSectionComplete('corridor', storage)
  assert.ok(readTourProgress(storage).completedSections.includes('alerts'))

  const reset = resetTourProgress(storage)
  assert.equal(reset.welcomeSeen, true)
  assert.equal(reset.tourDismissed, false)
  assert.deepEqual(reset.completedSections, [])
  assert.equal(isFullTourDone(reset), false)

  // Legacy / partial shape (missing fields, unknown section) still loads.
  storage.setItem(
    DEMO_TOUR_STORAGE_KEY,
    JSON.stringify({
      welcomeSeen: 1,
      completedSections: ['overview', 'not-a-section', 'jobs'],
      // tourDismissed omitted
    }),
  )
  const legacy = readTourProgress(storage)
  assert.equal(legacy.welcomeSeen, true)
  assert.equal(legacy.tourDismissed, false)
  assert.deepEqual(legacy.completedSections, ['overview', 'jobs'])
})

test('jobs-card has setup fallback when no saved jobs', () => {
  const step = TOUR_STEPS.find(s => s.id === 'jobs-card')
  assert.ok(step?.setupFallback)
  assert.match(step.setupFallback.ctaLabel, /Route check guide first/i)
  assert.equal(step.setupFallback.ctaSection, 'route-check')
})
