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
import { BookOpen } from 'lucide-react'
import {
  TOUR_SECTIONS,
  TOUR_STEPS,
  acknowledgeWelcome,
  dismissWelcome,
  markSectionComplete,
  readTourProgress,
  resetTourProgress,
  sectionLabel,
  sectionsCompletedByAdvance,
  stepsForSection,
  writeTourProgress,
  type DemoTourProgress,
  type TourSectionId,
  type TourStepDef,
} from '../../lib/demoTour'
import {
  afterScrollFrames,
  clickAppDialogDismiss,
  clickSelector,
  clampSpotlightRect,
  expandRect,
  isAppDialogOpen,
  isNarrowViewport,
  isUsableSpotlightRect,
  measureTooltipSize,
  placeTooltip,
  prefersReducedMotion,
  readVerdictFromDom,
  scrollTargetIntoView,
  targetFitsAboveSheet,
  verdictCtaBody,
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

const SHEET_FALLBACK_H = 280

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
  const [appDialogOpen, setAppDialogOpen] = useState(false)
  const [dynamicBody, setDynamicBody] = useState<string | null>(null)
  const waitingRef = useRef(false)
  const skipGuardRef = useRef<string | null>(null)
  const panelSeenOpenRef = useRef(false)
  const modeRef = useRef(mode)
  modeRef.current = mode

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

  const markSectionsLeaving = useCallback(
    (steps: TourStepDef[], fromIndex: number, toIndex: number) => {
      const leaving = sectionsCompletedByAdvance(steps, fromIndex, toIndex)
      if (!leaving.length) return
      let next = readTourProgress()
      for (const section of leaving) {
        next = markSectionComplete(section)
      }
      persist(next)
    },
    [persist],
  )

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
      const current = modeRef.current
      if (current.kind !== 'tour') return
      if (nextIndex < 0) return
      markSectionsLeaving(current.steps, current.index, nextIndex)
      if (nextIndex >= current.steps.length) {
        const section = current.steps[current.index]?.section
        if (section) {
          const next = markSectionComplete(section)
          if (current.full) {
            const remaining = TOUR_SECTIONS.filter(s => !next.completedSections.includes(s.id))
            persist(
              remaining.length === 0
                ? { ...next, tourDismissed: true, welcomeSeen: true }
                : next,
            )
          } else {
            persist(next)
          }
        }
        closeTour()
        return
      }
      const step = current.steps[nextIndex]
      if (step.route && location.pathname !== step.route) {
        navigate(step.route)
      }
      waitingRef.current = false
      setMode({ ...current, index: nextIndex })
    },
    [closeTour, location.pathname, markSectionsLeaving, navigate, persist],
  )

  const goNext = useCallback(() => {
    const current = modeRef.current
    if (current.kind !== 'tour') return
    goToIndex(current.index + 1)
  }, [goToIndex])

  const goBack = useCallback(() => {
    const current = modeRef.current
    if (current.kind !== 'tour') return
    goToIndex(current.index - 1)
  }, [goToIndex])

  // Watch app dialogs so the tour can yield focus.
  useEffect(() => {
    if (mode.kind !== 'tour') {
      setAppDialogOpen(false)
      return
    }
    const check = () => setAppDialogOpen(isAppDialogOpen())
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
    const timer = window.setInterval(check, 250)
    return () => {
      observer.disconnect()
      window.clearInterval(timer)
    }
  }, [mode.kind, currentStep?.id])

  // Resolve dynamic copy for the verdict CTA step.
  useEffect(() => {
    if (mode.kind !== 'tour' || !currentStep) {
      setDynamicBody(null)
      return
    }
    if (currentStep.id === 'route-cta') {
      setDynamicBody(verdictCtaBody(readVerdictFromDom()))
      return
    }
    if (currentStep.id === 'route-cta-panel') {
      const verdict = readVerdictFromDom()
      if (verdict === 'HOLD') {
        setDynamicBody(
          'The Take action sheet lists review, escalate, hold departure, and on-site check. Cancel closes it — then continue the tour.',
        )
      } else if (verdict === 'VERIFY') {
        setDynamicBody(
          'The on-site check dialog saves a field note to your account history (nothing is sent externally). Cancel or Log check request closes it — then continue.',
        )
      } else {
        setDynamicBody(currentStep.body)
      }
      return
    }
    setDynamicBody(null)
  }, [mode, currentStep, appDialogOpen])

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
      // Panel step is only meaningful with an open sheet/dialog — skip ghosts
      // (READY never opens one; user Cancel/"Close it and continue" already closed it).
      if (step.id === 'route-cta-panel' && !isAppDialogOpen()) {
        if (!cancelled && skipGuardRef.current !== step.id) {
          skipGuardRef.current = step.id
          goToIndex(stepIndex + 1)
        }
        return
      }
      // On verdict CTA for READY, don't wait for a dialog that will never open.
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

      const tipEl = tooltipRef.current
      const tipRect = tipEl && isNarrowViewport() ? tipEl.getBoundingClientRect() : null
      const sheetH = tipRect
        ? tipRect.height || SHEET_FALLBACK_H
        : isNarrowViewport()
          ? SHEET_FALLBACK_H
          : 0
      scrollTargetIntoView(found, {
        sheetHeight: sheetH,
        sheetTop: tipRect && tipRect.top > 0 ? tipRect.top : undefined,
      })
      // Re-measure after scroll (two frames); allow smooth scroll to settle.
      await afterScrollFrames()
      if (!prefersReducedMotion()) {
        await new Promise(r => setTimeout(r, 280))
        await afterScrollFrames()
      }
      if (cancelled) return
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
      const narrow = isNarrowViewport(viewport.width)
      const sheetH = narrow ? tipSize.height || SHEET_FALLBACK_H : 0

      if (anchorEl) {
        const raw = expandRect(anchorEl.getBoundingClientRect())
        const rect = clampSpotlightRect(raw, viewport)
        // Closing sheets can leave a ~12×12 ghost rect — never spotlight that.
        if (!isUsableSpotlightRect(rect)) {
          setSpot(null)
          setTipPos(placeTooltip(null, tipSize, viewport))
        } else {
          setSpot(rect)

          let preferSheetTop = false
          if (narrow && sheetH > 0) {
            preferSheetTop = !targetFitsAboveSheet(rect, viewport, sheetH)
          }
          setTipPos(placeTooltip(rect, tipSize, viewport, { sheetHeight: sheetH, preferSheetTop }))
        }
      } else {
        setSpot(null)
        setTipPos(placeTooltip(null, tipSize, viewport))
      }
    }

    update()
    // Second pass after layout so tip size is accurate (then clamp again).
    const raf = window.requestAnimationFrame(update)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (anchorEl) ro?.observe(anchorEl)
    if (tooltipRef.current) ro?.observe(tooltipRef.current)
    const onScroll = () => update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [anchorEl, mode, currentStep?.id, tipPos.placement])

  // Focus tooltip when step changes (yield while app dialog owns focus).
  useEffect(() => {
    if (mode.kind === 'tour' && currentStep) {
      const label = sectionLabel(currentStep.section)
      const body = dynamicBody ?? currentStep.body
      setLiveMessage(`${currentStep.title}. ${body} Step ${mode.index + 1} of ${mode.steps.length}. ${label}.`)
      if (!appDialogOpen) {
        queueMicrotask(() => tooltipRef.current?.focus())
      }
    } else if (mode.kind === 'welcome') {
      queueMicrotask(() => welcomeRef.current?.focus())
    } else if (mode.kind === 'menu') {
      queueMicrotask(() => menuRef.current?.focus())
    }
  }, [mode, currentStep, dynamicBody, appDialogOpen])

  // Interactive advance watchers.
  useEffect(() => {
    if (mode.kind !== 'tour' || !currentStep) return
    const advance = currentStep.advance
    // READY verdict CTA: treat as plain next (no dialog to wait for).
    if (
      currentStep.id === 'route-cta' &&
      readVerdictFromDom() === 'READY'
    ) {
      return
    }
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

  // Auto-advance when the user closes the verdict panel themselves.
  useEffect(() => {
    if (mode.kind !== 'tour' || currentStep?.id !== 'route-cta-panel') {
      panelSeenOpenRef.current = false
      return
    }
    if (appDialogOpen) {
      panelSeenOpenRef.current = true
      return
    }
    if (panelSeenOpenRef.current) {
      panelSeenOpenRef.current = false
      goNext()
    }
  }, [mode, currentStep?.id, appDialogOpen, goNext])

  // Keyboard: Esc / arrows while tour or welcome/menu open.
  useEffect(() => {
    if (mode.kind === 'idle') return
    const onKey = (event: KeyboardEvent) => {
      // Yield Esc to the app dialog while it is open.
      if (appDialogOpen && mode.kind === 'tour') return
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
      if (mode.kind !== 'tour' || appDialogOpen) return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        const step = currentStep
        const readyCta = step?.id === 'route-cta' && readVerdictFromDom() === 'READY'
        if (!step?.advance || step.advance.type === 'next' || readyCta) goNext()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goBack()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mode, currentStep, closeTour, goBack, goNext, persist, appDialogOpen])

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

  const onClosePanelAndContinue = () => {
    const dismissed = clickAppDialogDismiss()
    if (!dismissed) {
      goNext()
      return
    }
    // Auto-advance watcher fires once the dialog leaves the DOM.
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

  const verdict = currentStep?.id === 'route-cta' || currentStep?.id === 'route-cta-panel'
    ? readVerdictFromDom()
    : null
  const showDoIt =
    Boolean(currentStep?.doItLabel) &&
    !(currentStep?.id === 'route-cta' && verdict === 'READY')
  const readyCtaNext =
    currentStep?.id === 'route-cta' && verdict === 'READY'
  const waitingAdvance =
    Boolean(currentStep?.advance && currentStep.advance.type !== 'next') && !readyCtaNext
  const tipBody = dynamicBody ?? currentStep?.body ?? ''
  const yieldToDialog = appDialogOpen && currentStep?.id === 'route-cta-panel'

  // Entire tour chrome portals to body so z-index vars apply (not under main/map stacking).
  return createPortal(
    <div className="demo-tour-root" data-demo-tour-root="">
      <div className="demo-tour-sr-live" aria-live="polite">
        {liveMessage}
      </div>

      {guideSlot
        ? createPortal(launcher, guideSlot)
        : (
            <div style={{ position: 'fixed', top: 6, right: 120, zIndex: 40, pointerEvents: 'auto' }}>
              {launcher}
            </div>
          )}

      {mode.kind === 'welcome' && (
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
        </div>
      )}

      {mode.kind === 'menu' && (
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
        </>
      )}

      {mode.kind === 'tour' && currentStep && (
        <>
          {/* Yield shields/dim while an app dialog is open so Esc/focus stay with the app. */}
          {!yieldToDialog && (
            <>
              {!spot && <div className="demo-tour-overlay" aria-hidden="true" />}
              {spot && (
                <>
                  <div
                    className="demo-tour-clickshield"
                    style={{ top: 0, left: 0, width: '100%', height: Math.max(0, spot.top) }}
                    aria-hidden="true"
                  />
                  <div
                    className="demo-tour-clickshield"
                    style={{
                      top: spot.top + spot.height,
                      left: 0,
                      width: '100%',
                      height: Math.max(0, window.innerHeight - spot.top - spot.height),
                    }}
                    aria-hidden="true"
                  />
                  <div
                    className="demo-tour-clickshield"
                    style={{ top: spot.top, left: 0, width: Math.max(0, spot.left), height: spot.height }}
                    aria-hidden="true"
                  />
                  <div
                    className="demo-tour-clickshield"
                    style={{
                      top: spot.top,
                      left: spot.left + spot.width,
                      width: Math.max(0, window.innerWidth - spot.left - spot.width),
                      height: spot.height,
                    }}
                    aria-hidden="true"
                  />
                  <div
                    className="demo-tour-spotlight"
                    style={{
                      top: spot.top,
                      left: spot.left,
                      width: spot.width,
                      height: spot.height,
                    }}
                    aria-hidden="true"
                  />
                </>
              )}
            </>
          )}

          <div
            ref={tooltipRef}
            className={[
              'demo-tour-tooltip',
              tipPos.placement === 'sheet' || (isNarrowViewport() && tipPos.placement !== 'sheet-top')
                ? ' is-sheet'
                : '',
              tipPos.placement === 'sheet-top' ? ' is-sheet-top' : '',
              yieldToDialog ? ' is-yielding' : '',
            ].join('')}
            role="dialog"
            aria-modal={yieldToDialog ? 'false' : 'true'}
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            tabIndex={-1}
            data-tour-yield={yieldToDialog ? 'app-dialog' : undefined}
            style={
              tipPos.placement === 'sheet' || tipPos.placement === 'sheet-top' || isNarrowViewport()
                ? undefined
                : yieldToDialog
                  ? { top: 12, left: 12 }
                  : { top: tipPos.top, left: tipPos.left }
            }
          >
            <span className="demo-tour-eyebrow">{sectionLabel(currentStep.section)}</span>
            <h2 id={titleId} className="demo-tour-title">{currentStep.title}</h2>
            <p id={bodyId} className="demo-tour-body">{tipBody}</p>
            <div className="demo-tour-meta-row">
              <p className="demo-tour-meta">
                Step {mode.index + 1} of {mode.steps.length}
                {sectionTotal > 0 ? ` · ${sectionLabel(currentStep.section)} ${sectionIndex}/${sectionTotal}` : ''}
              </p>
              <div className="demo-tour-text-links">
                <button type="button" className="demo-tour-text-link" onClick={() => finishCurrentGuide()}>
                  Skip guide
                </button>
                <button type="button" className="demo-tour-text-link" onClick={() => closeTour()} aria-label="Exit tour">
                  Exit
                </button>
              </div>
            </div>
            {yieldToDialog ? (
              <div className="demo-tour-actions">
                <button type="button" className="demo-tour-btn" onClick={goBack} disabled={mode.index === 0}>
                  Back
                </button>
                <span className="demo-tour-actions-spacer" />
                <button
                  type="button"
                  className="demo-tour-btn is-primary"
                  onClick={onClosePanelAndContinue}
                >
                  Close it and continue
                </button>
              </div>
            ) : (
              <div className="demo-tour-actions">
                <button type="button" className="demo-tour-btn" onClick={goBack} disabled={mode.index === 0}>
                  Back
                </button>
                <span className="demo-tour-actions-spacer" />
                {showDoIt && (
                  <button type="button" className="demo-tour-btn" onClick={onDoItForMe}>
                    {currentStep.doItLabel}
                  </button>
                )}
                <button type="button" className="demo-tour-btn is-primary" onClick={goNext}>
                  {mode.index >= mode.steps.length - 1
                    ? 'Finish'
                    : waitingAdvance
                      ? 'Continue'
                      : 'Next'}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
