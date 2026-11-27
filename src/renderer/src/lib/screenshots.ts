/** The step from `index` by `delta` through `count` screenshots, wrapping round at both ends. */
export function stepScreenshot(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((index + delta) % count) + count) % count
}
