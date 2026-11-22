import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { BookOpen, X } from 'lucide-react'
import {
  TOUR_SECTIONS,
  TOUR_STEPS,
  acknowledgeWelcome,
  dismissWelcome,
  markSectionComplete,
  readTourProgress,
  resetTourProgress,
  sectionLabel,
  stepsForSection,
  writeTourProgress,
  type DemoTourProgress,
  type TourSectionId,
  type TourStepDef,
} from '../../lib/demoTour'
import {
  clickSelector,
  expandRect,
  isNarrowViewport,
  measureTooltipSize,
  placeTooltip,
  prefersReducedMotion,
  scrollTargetIntoView,
  waitForSelector,
  type Rect,
} from './positioning'
import './demoTour.css'

type Mode =
  | { kind: 'idle' }
  | { kind: 'welcome' }
  | { kind: 'menu' }
  | { kind: 'tour'; steps: TourStepDef[]; index: number; full: boolean }

function stepsForFullTour(): TourStepDef[] {
  return [...TOUR_STEPS]
}

export default function DemoTour() {
  const navigate = useNavigate()
  const location = useLocation()
  const launcherRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const welcomeRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const bodyId = useId()
  const [progress, setProgress] = useState<DemoTourProgress>(() => readTourProgress())
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [anchorEl, setAnchorEl] = useState<Element | null>(null)
  const [spot, setSpot] = useState<Rect | null>(null)
  const [tipPos, setTipPos] = useState<{ top: number; left: number; placement: string }>({
    top: 80,
    left: 24,
    placement: 'center',
  })
  const [liveMessage, setLiveMessage] = useState('')
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 60, left: 16 })
  const [guideSlot, setGuideSlot] = useState<Element | null>(null)
  const waitingRef = useRef(false)
  const skipGuardRef = useRef<string | null>(null)

  // Auto-open welcome on first Demo visit.
  useEffect(() => {
    const stored = readTourProgress()
    setProgress(stored)
    if (!stored.welcomeSeen && !stored.tourDismissed) {
      setMode({ kind: 'welcome' })
    }
  }, [])

  useEffect(() => {
    setGuideSlot(document.querySelector('[data-tour="demo-guide-anchor"]'))
  }, [location.pathname])

  const currentStep =
    mode.kind === 'tour' ? mode.steps[mode.index] ?? null : null

  const closeTour = useCallback((opts?: { focusLauncher?: boolean }) => {
    setMode({ kind: 'idle' })
    setAnchorEl(null)
    setSpot(null)
    waitingRef.current = false
    if (opts?.focusLauncher !== false) {
      queueMicrotask(() => launcherRef.current?.focus())
    }
  }, [])

  const persist = useCallback((next: DemoTourProgress) => {
    writeTourProgress(next)
    setProgress(next)
  }, [])

  const startSteps = useCallback(
    (steps: TourStepDef[], full: boolean) => {
      if (!steps.length) return
      const first = steps[0]
      if (first.route && location.pathname !== first.route) {
        navigate(first.route)
      }
      setMode({ kind: 'tour', steps, index: 0, full })
    },
    [location.pathname, navigate],
  )

  const startFullTour = useCallback(() => {
    const next = acknowledgeWelcome()
    persist(next)
    startSteps(stepsForFullTour(), true)
  }, [persist, startSteps])

  const startSection = useCallback(
    (section: TourSectionId) => {
      const steps = stepsForSection(section)
      const meta = TOUR_SECTIONS.find(item => item.id === section)
      if (meta && location.pathname !== meta.route) {
        navigate(meta.route)
      }
      startSteps(steps, false)
    },
    [location.pathname, navigate, startSteps],
  )

  const finishCurrentGuide = useCallback(() => {
    if (mode.kind !== 'tour' || !currentStep) {
      closeTour()
      return
    }
    const section = currentStep.section
    const next = markSectionComplete(section)
    if (mode.full) {
      const remaining = TOUR_SECTIONS.filter(s => !next.completedSections.includes(s.id))
      if (remaining.length === 0) {
        persist({ ...next, tourDismissed: true, welcomeSeen: true })
      } else {
        persist(next)
      }
    } else {
      persist(next)
    }
    closeTour()
  }, [closeTour, currentStep, mode, persist])

  const goToIndex = useCallback(
    (nextIndex: number) => {
      if (mode.kind !== 'tour') return
      if (nextIndex < 0) return
      if (nextIndex >= mode.steps.length) {
        finishCurrentGuide()
        return
      }
      const step = mode.steps[nextIndex]
      if (step.route && location.pathname !== step.route) {
        navigate(step.route)
      }
      waitingRef.current = false
      setMode({ ...mode, index: nextIndex })
    },
    [finishCurrentGuide, location.pathname, mode, navigate],
  )

  const goNext = useCallback(() => goToIndex(mode.kind === 'tour' ? mode.index + 1 : 0), [goToIndex, mode])
  const goBack = useCallback(() => goToIndex(mode.kind === 'tour' ? mode.index - 1 : 0), [goToIndex, mode])

  // Resolve anchor for current step.
  useEffect(() => {
    if (mode.kind !== 'tour' || !currentStep) {
      setAnchorEl(null)
      setSpot(null)
      return
    }

    let cancelled = false
    const step = currentStep
    const stepIndex = mode.index

    async function resolve() {
      if (step.route && location.pathname !== step.route) {
        navigate(step.route)
        await new Promise(r => setTimeout(r, 80))
      }
      // Interactive "show samples": if list already open, treat as done.
      if (step.id === 'route-show-samples' && document.querySelector('[data-tour="route-permit-hamburg-hannover"]')) {
        if (!cancelled) goToIndex(stepIndex + 1)
        return
      }
      if (!step.anchor) {
        if (!cancelled) {
          setAnchorEl(null)
          setSpot(null)
        }
        return
      }
      const found = await waitForSelector(step.anchor, {
        timeoutMs: step.optional ? 1800 : 4500,
      })
      if (cancelled) return
      if (!found) {
        if (step.optional && skipGuardRef.current !== step.id) {
          skipGuardRef.current = step.id
          goToIndex(stepIndex + 1)
          return
        }
        setAnchorEl(null)
        setSpot(null)
        return
      }
      skipGuardRef.current = null
      scrollTargetIntoView(found)
      setAnchorEl(found)
    }

    void resolve()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when step identity changes
  }, [mode.kind, mode.kind === 'tour' ? mode.index : -1, currentStep?.id, location.pathname])

  // Reposition spotlight + tooltip.
  useLayoutEffect(() => {
    if (mode.kind !== 'tour') return

    const update = () => {
      const tipSize = measureTooltipSize(tooltipRef.current)
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      if (anchorEl) {
        const rect = expandRect(anchorEl.getBoundingClientRect())
        setSpot(rect)
        setTipPos(placeTooltip(rect, tipSize, viewport))
      } else {
        setSpot(null)
        setTipPos(placeTooltip(null, tipSize, viewport))
      }
    }

    update()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (anchorEl) ro?.observe(anchorEl)
    if (tooltipRef.current) ro?.observe(tooltipRef.current)
    const onScroll = () => update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [anchorEl, mode, currentStep?.id, tipPos.placement])

  // Focus tooltip when step changes.
  useEffect(() => {
    if (mode.kind === 'tour' && currentStep) {
      const label = sectionLabel(currentStep.section)
      setLiveMessage(`${currentStep.title}. ${currentStep.body} Step ${mode.index + 1} of ${mode.steps.length}. ${label}.`)
      queueMicrotask(() => tooltipRef.current?.focus())
    } else if (mode.kind === 'welcome') {
      queueMicrotask(() => welcomeRef.current?.focus())
    } else if (mode.kind === 'menu') {
      queueMicrotask(() => menuRef.current?.focus())
    }
  }, [mode, currentStep])

  // Interactive advance watchers.
  useEffect(() => {
    if (mode.kind !== 'tour' || !currentStep) return
    const advance = currentStep.advance
    if (!advance || advance.type === 'next') return

    waitingRef.current = true
    let cancelled = false

    if (advance.type === 'click') {
      const selector = currentStep.doItSelector || currentStep.anchor
      if (!selector) return
      const onClick = (event: MouseEvent) => {
        const target = event.target as Element | null
        if (!target) return
        const hit = target.closest(selector)
        if (hit) {
          waitingRef.current = false
          window.setTimeout(() => {
            if (!cancelled) goNext()
          }, prefersReducedMotion() ? 0 : 180)
        }
      }
      document.addEventListener('click', onClick, true)
      return () => {
        cancelled = true
        document.removeEventListener('click', onClick, true)
      }
    }

    if (advance.type === 'present') {
      const timer = window.setInterval(() => {
        if (document.querySelector(advance.selector)) {
          waitingRef.current = false
          window.clearInterval(timer)
          goNext()
        }
      }, 200)
      return () => {
        cancelled = true
        window.clearInterval(timer)
      }
    }

    if (advance.type === 'route') {
      if (location.pathname === advance.path) {
        goNext()
      }
    }
  }, [mode, currentStep, goNext, location.pathname])

  // Keyboard: Esc / arrows while tour or welcome/menu open.
  useEffect(() => {
    if (mode.kind === 'idle') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (mode.kind === 'welcome') {
          persist(dismissWelcome())
          closeTour()
          return
        }
        if (mode.kind === 'menu') {
          setMode({ kind: 'idle' })
          launcherRef.current?.focus()
          return
        }
        closeTour()
        return
      }
      if (mode.kind !== 'tour') return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (!currentStep?.advance || currentStep.advance.type === 'next') goNext()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goBack()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mode, currentStep, closeTour, goBack, goNext, persist])

  const onDoItForMe = () => {
    if (!currentStep) return
    if (currentStep.id === 'route-show-samples') {
      if (document.querySelector('[data-tour="route-permit-hamburg-hannover"]')) {
        goNext()
        return
      }
    }
    if (currentStep.id === 'route-pick-sample') {
      if (!document.querySelector('[data-tour="route-permit-hamburg-hannover"]')) {
        clickSelector('[data-tour="route-sample-toggle"]')
      }
    }
    const selector = currentStep.doItSelector || currentStep.anchor
    if (!selector) return
    window.setTimeout(() => clickSelector(selector), currentStep.id === 'route-pick-sample' ? 200 : 0)
  }

  const openMenu = () => {
    const btn = launcherRef.current
    if (btn) {
      const rect = btn.getBoundingClientRect()
      const width = 320
      const left = Math.min(
        Math.max(12, rect.right - width),
        window.innerWidth - width - 12,
      )
      setMenuPos({ top: rect.bottom + 8, left })
    }
    setMode({ kind: 'menu' })
  }

  const launcher = (
    <button
      ref={launcherRef}
      type="button"
      className="demo-tour-launcher"
      aria-label="Guide"
      aria-expanded={mode.kind === 'menu'}
      aria-haspopup="dialog"
      onClick={() => (mode.kind === 'menu' ? setMode({ kind: 'idle' }) : openMenu())}
    >
      <BookOpen size={18} strokeWidth={1.75} aria-hidden />
      <span className="demo-tour-launcher-label">Guide</span>
    </button>
  )

  const sectionIndex = currentStep
    ? stepsForSection(currentStep.section).findIndex(s => s.id === currentStep.id) + 1
    : 0
  const sectionTotal = currentStep ? stepsForSection(currentStep.section).length : 0

  return (
    <div className="demo-tour-root" data-demo-tour-root="">
      <div className="demo-tour-sr-live" aria-live="polite">
        {liveMessage}
      </div>

      {guideSlot
        ? createPortal(launcher, guideSlot)
        : createPortal(
            <div style={{ position: 'fixed', top: 6, right: 120, zIndex: 40, pointerEvents: 'auto' }}>
              {launcher}
            </div>,
            document.body,
          )}

      {mode.kind === 'welcome' &&
        createPortal(
          <div className="demo-tour-welcome-backdrop" role="presentation">
            <div
              ref={welcomeRef}
              className="demo-tour-welcome"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={bodyId}
              tabIndex={-1}
            >
              <span className="demo-tour-eyebrow">Demo guide</span>
              <h2 id={titleId} className="demo-tour-title">
                Walk through a live route check
              </h2>
              <p id={bodyId} className="demo-tour-body">
                This app checks whether a permitted heavy-transport route is usable against live Autobahn conditions.
                The guide covers Overview, a full Route check, Jobs, Alerts, Corridor monitor, Settings, and Switch user — Demo account only.
              </p>
              <div className="demo-tour-actions">
                <button type="button" className="demo-tour-btn is-ghost" onClick={() => { persist(dismissWelcome()); closeTour() }}>
                  Not now
                </button>
                <span className="demo-tour-actions-spacer" />
                <button type="button" className="demo-tour-btn is-primary" onClick={startFullTour}>
                  Start the tour
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {mode.kind === 'menu' &&
        createPortal(
          <>
            <button type="button" className="demo-tour-menu-backdrop" aria-label="Close guide menu" onClick={() => setMode({ kind: 'idle' })} />
            <div
              ref={menuRef}
              className="demo-tour-menu"
              role="dialog"
              aria-label="Guide menu"
              tabIndex={-1}
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              <h2 className="demo-tour-menu-title">Guides</h2>
              <ul className="demo-tour-menu-list">
                {TOUR_SECTIONS.map(section => {
                  const done = progress.completedSections.includes(section.id)
                  return (
                    <li key={section.id}>
                      <button type="button" className="demo-tour-menu-item" onClick={() => startSection(section.id)}>
                        {section.label}
                        <span className={`demo-tour-menu-status${done ? ' is-done' : ''}`}>
                          {done ? 'Done' : 'Not started'}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
              <div className="demo-tour-menu-footer">
                <button
                  type="button"
                  className="demo-tour-btn"
                  style={{ width: '100%' }}
                  onClick={() => {
                    persist(resetTourProgress())
                    startFullTour()
                  }}
                >
                  Restart full tour
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}

      {mode.kind === 'tour' && currentStep &&
        createPortal(
          <>
            {/* Dim overlay with cut-out via spotlight box-shadow; keep target clickable */}
            {!spot && <div className="demo-tour-overlay" aria-hidden="true" />}
            {spot && (
              <>
                {/* Four shields around the spotlight so the target stays clickable */}
                <div className="demo-tour-clickshield" style={{ top: 0, left: 0, width: '100%', height: Math.max(0, spot.top) }} aria-hidden="true" />
                <div className="demo-tour-clickshield" style={{ top: spot.top + spot.height, left: 0, width: '100%', height: Math.max(0, window.innerHeight - spot.top - spot.height) }} aria-hidden="true" />
                <div className="demo-tour-clickshield" style={{ top: spot.top, left: 0, width: Math.max(0, spot.left), height: spot.height }} aria-hidden="true" />
                <div className="demo-tour-clickshield" style={{ top: spot.top, left: spot.left + spot.width, width: Math.max(0, window.innerWidth - spot.left - spot.width), height: spot.height }} aria-hidden="true" />
                <div
                  className="demo-tour-spotlight"
                  style={{
                    top: spot.top,
                    left: spot.left,
                    width: spot.width,
                    height: spot.height,
                    boxShadow: 'none',
                    outline: '2px solid var(--accent)',
                    outlineOffset: 0,
                  }}
                  aria-hidden="true"
                />
              </>
            )}

            <div
              ref={tooltipRef}
              className={`demo-tour-tooltip${tipPos.placement === 'sheet' || isNarrowViewport() ? ' is-sheet' : ''}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={bodyId}
              tabIndex={-1}
              style={
                tipPos.placement === 'sheet' || isNarrowViewport()
                  ? undefined
                  : { top: tipPos.top, left: tipPos.left }
              }
            >
              <span className="demo-tour-eyebrow">{sectionLabel(currentStep.section)}</span>
              <h2 id={titleId} className="demo-tour-title">{currentStep.title}</h2>
              <p id={bodyId} className="demo-tour-body">{currentStep.body}</p>
              <p className="demo-tour-meta">
                Step {mode.index + 1} of {mode.steps.length}
                {sectionTotal > 0 ? ` · ${sectionLabel(currentStep.section)} ${sectionIndex}/${sectionTotal}` : ''}
              </p>
              <div className="demo-tour-actions">
                <button type="button" className="demo-tour-btn is-ghost" onClick={() => finishCurrentGuide()}>
                  Skip guide
                </button>
                <button type="button" className="demo-tour-btn is-ghost" onClick={() => closeTour()} aria-label="Exit tour">
                  <X size={16} aria-hidden />
                  Exit
                </button>
                <span className="demo-tour-actions-spacer" />
                <button type="button" className="demo-tour-btn" onClick={goBack} disabled={mode.index === 0}>
                  Back
                </button>
                {currentStep.doItLabel && (
                  <button type="button" className="demo-tour-btn" onClick={onDoItForMe}>
                    {currentStep.doItLabel}
                  </button>
                )}
                {(!currentStep.advance || currentStep.advance.type === 'next') && (
                  <button type="button" className="demo-tour-btn is-primary" onClick={goNext}>
                    {mode.index >= mode.steps.length - 1 ? 'Finish' : 'Next'}
                  </button>
                )}
                {currentStep.advance && currentStep.advance.type !== 'next' && (
                  <button type="button" className="demo-tour-btn is-primary" onClick={goNext}>
                    Continue
                  </button>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}
