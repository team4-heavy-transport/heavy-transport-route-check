export default function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  tourId,
}: {
  eyebrow?: string
  title: string
  description: string
  actions?: React.ReactNode
  /** Optional tour anchor — attribute-only; undefined omits the attr. */
  tourId?: string
}) {
  return (
    <header className="market-page-header" data-tour={tourId}>
      <div>
        {eyebrow && <span className="market-eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="market-page-actions">{actions}</div>}
    </header>
  )
}
