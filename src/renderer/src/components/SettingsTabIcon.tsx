import { useId, type ReactElement } from 'react'

/** The gear's eight teeth, every 45°. */
const TEETH = [0, 45, 90, 135, 180, 225, 270, 315]

/**
 * The Library's Settings tab: a gear with a wrench across it (the user's picture, drawn anew in PlayOut's colours):
 * the gear in the tab's text colour, the wrench in the accent blue of PlayOut's buttons. The wrench's jaw is cut with
 * a mask of its own (useId), so two icons on one page never share one.
 */
export function SettingsTabIcon({ className }: { className?: string }): ReactElement {
  const id = `settings-tab-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        {/* The gear's hole, so the background shows through its middle. */}
        <mask id={`${id}-gear`}>
          <rect width="24" height="24" fill="#fff" />
          <circle cx="12.6" cy="11.4" r="4.4" fill="#000" />
        </mask>
        {/* The wrench's open jaw. */}
        <mask id={`${id}-jaw`}>
          <rect width="24" height="24" fill="#fff" />
          <rect
            x="14.9"
            y="5.2"
            width="2.6"
            height="4.4"
            rx="0.4"
            transform="rotate(45 16.2 7.4)"
            fill="#000"
          />
        </mask>
      </defs>
      <g fill="currentColor" mask={`url(#${id}-gear)`}>
        {TEETH.map((a) => (
          <rect
            key={a}
            x="10.85"
            y="1.4"
            width="3.5"
            height="4"
            rx="1"
            transform={`rotate(${a} 12.6 11.4)`}
          />
        ))}
        <circle cx="12.6" cy="11.4" r="7.4" />
      </g>
      <g className="settings-tab-icon__wrench" mask={`url(#${id}-jaw)`}>
        <line
          x1="4"
          y1="20"
          x2="12"
          y2="12"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle cx="14.4" cy="9.6" r="4" fill="currentColor" />
      </g>
    </svg>
  )
}
