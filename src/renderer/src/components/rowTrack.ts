import { createContext, useContext, type RefObject } from 'react'

/**
 * The scroll track (.row__track) of the enclosing Row, for children that need to observe it (WindowedCards
 * reads scrollLeft/clientWidth). Kept out of Row.tsx so React fast-refresh keeps working.
 */
export const RowTrackContext = createContext<RefObject<HTMLDivElement | null> | null>(null)

export function useRowTrack(): RefObject<HTMLDivElement | null> | null {
  return useContext(RowTrackContext)
}
