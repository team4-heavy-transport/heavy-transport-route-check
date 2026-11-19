import { useEffect, useRef } from 'react'

interface EscalateDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  routeName?: string
}

export default function EscalateDialog({ open, onClose, onConfirm, routeName }: EscalateDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    confirmRef.current?.focus()

    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="escalate-dialog-title">
      <div ref={dialogRef} className="dialog-content">
        <header>
          <h2 id="escalate-dialog-title">Log an escalation?</h2>
          <p>
            This saves the escalation on{' '}
            {routeName ? `the ${routeName} route` : 'the route'} to your account history. No external
            notification is sent to a manager, driver, or authority.
          </p>
        </header>
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" className="btn-primary" onClick={onConfirm}>
            Confirm escalation
          </button>
        </div>
      </div>
    </div>
  )
}
