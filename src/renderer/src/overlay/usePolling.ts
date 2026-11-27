import { useEffect, useRef } from 'react'

/**
 * Run `task` now and every `intervalMs` while `enabled` (the overlay is open and the part that shows the data is
 * visible). Stops as soon as `enabled` turns false, so a closed overlay polls nothing.
 */
export function usePolling(task: () => unknown, intervalMs: number, enabled: boolean): void {
  const latest = useRef(task)
  useEffect(() => {
    latest.current = task
  })
  useEffect(() => {
    if (!enabled) return undefined
    void latest.current()
    const timer = setInterval(() => void latest.current(), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, enabled])
}
