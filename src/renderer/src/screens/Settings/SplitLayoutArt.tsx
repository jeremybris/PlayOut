import type { ReactElement } from 'react'

/**
 * A screen split for two players: a rectangle divided by a line through the middle, horizontal (stacked: 1 on top,
 * 2 below) or vertical (side by side: 1 left, 2 right), each half numbered.
 */
export function SplitLayoutArt({ layout }: { layout: 'stacked' | 'sideBySide' }): ReactElement {
  const stacked = layout === 'stacked'
  return (
    <svg
      className="split-art"
      viewBox="0 0 64 40"
      width="64"
      height="40"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="split-art__frame" x="1.5" y="1.5" width="61" height="37" rx="4" />
      {stacked ? (
        <line className="split-art__line" x1="1.5" y1="20" x2="62.5" y2="20" />
      ) : (
        <line className="split-art__line" x1="32" y1="1.5" x2="32" y2="38.5" />
      )}
      <text className="split-art__num" x={stacked ? 32 : 16.75} y={stacked ? 11 : 20}>
        1
      </text>
      <text className="split-art__num" x={stacked ? 32 : 47.25} y={stacked ? 29.25 : 20}>
        2
      </text>
    </svg>
  )
}
