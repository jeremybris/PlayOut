import type { ReactElement } from 'react'
import { bandFill, bandIconSize, slicePath } from '../lib/bandIcon'

/** The dial's centre and face radius inside the 24-unit stopwatch (the buttons sit above it). */
const CX = 12
const CY = 13.6
const FACE = 7

/** The twelve marks round the face, as in the user's stopwatch picture. */
const MARKS = Array.from({ length: 12 }, (_, i) => {
  const a = (Math.PI / 6) * i
  return { x: +(CX + 5.4 * Math.sin(a)).toFixed(2), y: +(CY - 5.4 * Math.cos(a)).toFixed(2) }
})

/**
 * A Filters > H.L.T.B. band's stopwatch before its name: band `step` of `steps` (1 = shortest). The slice starts at
 * the top of the dial and fills clockwise one seventh per band, so the longest band is almost full (6/7), with the hand
 * at the slice's edge; the whole stopwatch grows with the band, like Filters > Size's pies (SizePie.tsx). Drawn in
 * the text colour, like the pies, in the box Platform's console pictures use so the rows line up. In Filters > H.L.T.B.
 * the time slice is red (`redSlice`); the Sort menu's stopwatch stays all in the text colour.
 */
export const HLTB_SLICE_RED = '#f2453d'

export function HltbClock({
  step,
  steps,
  redSlice = false
}: {
  step: number
  steps: number
  redSlice?: boolean
}): ReactElement {
  const fill = bandFill(step, steps)
  const size = bandIconSize(step, steps)
  const angle = 2 * Math.PI * fill
  const handX = (CX + 5.2 * Math.sin(angle)).toFixed(2)
  const handY = (CY - 5.2 * Math.cos(angle)).toFixed(2)
  return (
    <span className="console-icon" aria-hidden="true">
      <svg
        className="hltb-clock"
        viewBox="0 0 24 24"
        style={{ width: size, height: size }}
        data-fill={fill.toFixed(3)}
        fill="currentColor"
      >
        {/* The top button and its stem, and the two side buttons. */}
        <rect x="9.6" y="0.6" width="4.8" height="2" rx="0.7" />
        <rect x="11.1" y="2.4" width="1.8" height="2" />
        <rect x="3" y="4.3" width="3.4" height="1.8" rx="0.6" transform="rotate(-45 4.7 5.2)" />
        <rect x="17.6" y="4.3" width="3.4" height="1.8" rx="0.6" transform="rotate(45 19.3 5.2)" />
        {/* The case, the face and the time slice. */}
        <circle
          cx={CX}
          cy={CY}
          r={FACE + 1.1}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
        />
        <circle cx={CX} cy={CY} r={FACE} opacity="0.14" />
        <path
          d={slicePath(CX, CY, FACE, fill)}
          {...(redSlice ? { fill: HLTB_SLICE_RED, opacity: 0.9 } : { opacity: 0.45 })}
        />
        {MARKS.map((m, i) => (
          <circle key={i} cx={m.x} cy={m.y} r="0.6" />
        ))}
        {/* The hand at the slice's edge, on its pivot. */}
        <line
          x1={CX}
          y1={CY}
          x2={handX}
          y2={handY}
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r="1.3" />
      </svg>
    </span>
  )
}
