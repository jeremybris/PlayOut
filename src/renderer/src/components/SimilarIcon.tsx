import { useId, type ReactElement, type SVGProps } from 'react'

/**
 * The Similar button's glyph: two overlapping circles, the right one filled softly and their overlap striped, drawn
 * like the Lucide icons beside it (24 x 24, 2-wide strokes in the current colour) so it takes the page's icon colour.
 */
export function SimilarIcon(props: SVGProps<SVGSVGElement>): ReactElement {
  const id = useId().replace(/:/g, '')
  const left = `similar-left-${id}`
  const right = `similar-right-${id}`
  const outsideLeft = `similar-outside-${id}`
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <defs>
        <clipPath id={left}>
          <circle cx="8.5" cy="12" r="6.5" />
        </clipPath>
        <clipPath id={right}>
          <circle cx="15.5" cy="12" r="6.5" />
        </clipPath>
        <mask id={outsideLeft}>
          <rect width="24" height="24" fill="white" stroke="none" />
          <circle cx="8.5" cy="12" r="6.5" fill="black" stroke="none" />
        </mask>
      </defs>
      {/* The right circle's own part, filled softly (the overlap stays clear for its stripes). */}
      <circle
        cx="15.5"
        cy="12"
        r="6.5"
        fill="currentColor"
        fillOpacity={0.35}
        stroke="none"
        mask={`url(#${outsideLeft})`}
      />
      {/* The overlap's stripes. */}
      <g clipPath={`url(#${left})`}>
        <g clipPath={`url(#${right})`} strokeWidth={1.4}>
          <path d="M10 10.5 13.5 7" />
          <path d="M10 14 14 10" />
          <path d="M10.5 17 14 13.5" />
        </g>
      </g>
      <circle cx="8.5" cy="12" r="6.5" />
      <circle cx="15.5" cy="12" r="6.5" />
    </svg>
  )
}
