import type { ReactElement } from 'react'

/** Keyboard key rows (x positions per row) for the Mouse and Keyboard picture. */
const KEY_ROWS: readonly { y: number; xs: readonly number[] }[] = [
  { y: 6.6, xs: [3, 5.6, 8.2, 10.8, 13.4, 16, 18.6] },
  { y: 9.2, xs: [3, 5.6, 8.2, 10.8, 13.4, 16, 18.6] }
]

/** The user's mouse and keyboard picture: a keyboard with its keys and space bar, and a two-button mouse. */
function KeyboardMouse(): ReactElement {
  return (
    <svg className="controls-icon" viewBox="0 0 32 20" data-controls="keyboard" fill="currentColor">
      <rect
        x="1"
        y="4"
        width="22"
        height="12"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      {KEY_ROWS.map((row) =>
        row.xs.map((x) => (
          <rect key={`${row.y}-${x}`} x={x} y={row.y} width="2" height="1.8" rx="0.3" />
        ))
      )}
      <rect x="3" y="11.8" width="2" height="1.8" rx="0.3" />
      <rect x="5.6" y="11.8" width="12.8" height="1.8" rx="0.3" />
      <rect x="19" y="11.8" width="1.6" height="1.8" rx="0.3" />
      <rect
        x="25"
        y="5.5"
        width="6"
        height="10"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M28 5.5v3.6M25 9.1h6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/** The user's controller picture: a gamepad with two sticks, a d-pad, four face buttons and a centre button. */
function Gamepad(): ReactElement {
  return (
    <svg
      className="controls-icon"
      viewBox="0 0 24 24"
      data-controls="controller"
      fill="currentColor"
    >
      <path
        d="M7 7h10c2.6 0 4 1.2 4.6 3.6l1.2 5.4c.5 2.3-.7 3.6-2.2 3.6-1.1 0-1.9-.7-2.6-1.8l-1-1.6H7l-1 1.6c-.7 1.1-1.5 1.8-2.6 1.8-1.5 0-2.7-1.3-2.2-3.6l1.2-5.4C2.9 8.2 4.4 7 7 7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="6.8" cy="10.9" r="1.6" />
      <rect x="9.05" y="12.6" width="1.1" height="3.4" rx="0.3" />
      <rect x="7.9" y="13.75" width="3.4" height="1.1" rx="0.3" />
      <circle cx="14.6" cy="14.3" r="1.5" />
      <circle cx="12" cy="9.2" r="0.9" />
      <circle cx="17.3" cy="9.1" r="0.75" />
      <circle cx="18.9" cy="10.7" r="0.75" />
      <circle cx="15.7" cy="10.7" r="0.75" />
      <circle cx="17.3" cy="12.3" r="0.75" />
    </svg>
  )
}

/** The user's VR picture: a headset marked VR between two hand controllers with rings on top. */
function Vr(): ReactElement {
  return (
    <svg className="controls-icon" viewBox="0 0 24 24" data-controls="vr" fill="currentColor">
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <ellipse cx="4.6" cy="5.4" rx="2.3" ry="1.5" strokeWidth="1.3" />
        <ellipse cx="19.4" cy="5.4" rx="2.3" ry="1.5" strokeWidth="1.3" />
        <path d="M5.2 7 3 18.4M18.8 7 21 18.4" strokeWidth="2.2" />
        <path
          d="M8.6 9.6h6.8c2 0 3.1 1.1 3.1 3.1v1.6c0 2-1.1 3.1-3.1 3.1-1.4 0-2.2-1.1-3.4-1.1s-2 1.1-3.4 1.1c-2 0-3.1-1.1-3.1-3.1v-1.6c0-2 1.1-3.1 3.1-3.1Z"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </g>
      <text
        x="12"
        y="14.6"
        textAnchor="middle"
        fontSize="4.4"
        fontWeight="700"
        fontFamily="inherit"
      >
        VR
      </text>
    </svg>
  )
}

/** The touch picture: a hand, its index finger pointing up and tapping, with tap rings above the fingertip. */
function Touch(): ReactElement {
  return (
    <svg className="controls-icon" viewBox="0 0 24 24" data-controls="touch" fill="none">
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7.4 4.6a3.2 3.2 0 0 1 5.2 0M5.6 3a5.6 5.6 0 0 1 8.8 0" strokeWidth="1.3" />
        <path
          d="M8.8 13V7.3a1.2 1.2 0 0 1 2.4 0v5.2m0-.7v-1.1a1.2 1.2 0 0 1 2.4 0v1.6m0-.6a1.2 1.2 0 0 1 2.4 0v1m0-.2a1.2 1.2 0 0 1 2.4 0v3.4c0 2.9-2 4.9-4.9 4.9h-1.3c-1.7 0-2.8-.6-3.8-1.9l-2.6-3.5a1.2 1.2 0 0 1 1.8-1.6L8.8 15"
          strokeWidth="1.5"
        />
      </g>
    </svg>
  )
}

/**
 * The light gun picture (lucide has none): a pistol pointing right, its trigger in a guard, with light rays leaving
 * the muzzle. Also the game page's controls badge icon for a light-gun game (with that badge's className and `bold`:
 * the 2px strokes of the lucide icons beside it; the filter menu's picture keeps the thinner strokes of its touch hand).
 */
export function LightgunIcon({
  className = 'controls-icon',
  bold = false
}: {
  className?: string
  bold?: boolean
}): ReactElement {
  const body = bold ? '2' : '1.5'
  const detail = bold ? '1.8' : '1.3'
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      data-controls="lightgun"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M2.6 6.6h16.6a.9.9 0 0 1 .9.9v2.6a.9.9 0 0 1-.9.9h-8.4l-.8 1.6H8.4L6.9 19a.9.9 0 0 1-.9.7H3.6a.8.8 0 0 1-.8-1L4.4 11H2.6a.9.9 0 0 1-.9-.9V7.5a.9.9 0 0 1 .9-.9Z"
          strokeWidth={body}
        />
        <path d="M8.4 12.6c.1 1.6 1 2.4 2.5 2.4l.6-1.4" strokeWidth={detail} />
        <path d="M21.4 5.6l1.4-1.2M21.6 8.8h1.8M21.4 12l1.4 1.2" strokeWidth={detail} />
      </g>
    </svg>
  )
}

/**
 * A Filters > Controls choice's picture before its name (the user's VR, controller and mouse and keyboard pictures, a touch hand and a light gun,
 * drawn in the text colour like Size's pies and H.L.T.B.'s stopwatches), in the box Platform's console pictures use so
 * the rows line up; nothing for an id it does not know.
 */
export function ControlsIcon({ controlsId }: { controlsId: string }): ReactElement | null {
  const picture =
    controlsId === 'vr' ? (
      <Vr />
    ) : controlsId === 'controller' ? (
      <Gamepad />
    ) : controlsId === 'keyboard' ? (
      <KeyboardMouse />
    ) : controlsId === 'touch' ? (
      <Touch />
    ) : controlsId === 'lightgun' ? (
      <LightgunIcon />
    ) : null
  if (!picture) return null
  return (
    <span className="console-icon" aria-hidden="true">
      {picture}
    </span>
  )
}
