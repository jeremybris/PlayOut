/**
 * The right stick scrolls what the player is looking at when no screen takes its up / down (Home and the Library
 * move between them, the Recompilation page and the VR browser scroll their own pages): the nearest scrollable box
 * around the focused control, else the top modal's, else the page. It scrolls for as long as the stick is held, faster
 * the further it is pushed, so text and controls the D-pad cannot reach (the bottom of Settings › Controls) come into
 * view.
 */

/** Pixels a second at full deflection. */
export const STICK_SCROLL_SPEED = 1400

function scrollsVertically(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.scrollHeight <= el.clientHeight + 1) return false
  const overflow = getComputedStyle(el).overflowY
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay'
}

/** The nearest scrollable ancestor of `start` (itself included), or null. */
export function scrollableAround(start: Element | null): HTMLElement | null {
  for (let el = start; el; el = el.parentElement)
    if (scrollsVertically(el)) return el as HTMLElement
  return null
}

const area = (el: HTMLElement): number => el.clientWidth * el.clientHeight

/**
 * What the right stick scrolls now, in the top modal (else the page): the box around the focused control when it is a
 * main one (at least half the size of the biggest), else the biggest box that scrolls (Settings: its content, not
 * the column of sections on its left).
 */
/**
 * The floating menu the focused control is in (a drop-down, the Play menu: drawn over the page, position fixed),
 * before any dialog around it; null when it is in no such menu.
 */
function floatingMenuOf(focused: Element | null): HTMLElement | null {
  for (let el = focused; el && el !== el.ownerDocument.body; el = el.parentElement) {
    if (el.getAttribute('role') === 'dialog') return null
    if (getComputedStyle(el).position === 'fixed') return el as HTMLElement
  }
  return null
}

export function stickScrollTarget(doc: Document = document): HTMLElement | null {
  const focused = doc.querySelector('[data-focused="true"]') ?? doc.activeElement
  // A drop-down is open: only its own list scrolls (the page behind it would leave it floating over other rows).
  const menu = floatingMenuOf(focused)
  if (menu) {
    const around = scrollableAround(focused)
    return around && menu.contains(around) ? around : null
  }
  const modals = doc.querySelectorAll('[role="dialog"]')
  const scope: ParentNode = modals[modals.length - 1] ?? doc
  const boxes: HTMLElement[] = []
  if (scope instanceof Element && scrollsVertically(scope)) boxes.push(scope as HTMLElement)
  for (const el of scope.querySelectorAll('*'))
    if (scrollsVertically(el)) boxes.push(el as HTMLElement)
  const biggest = boxes.reduce<HTMLElement | null>(
    (best, el) => (!best || area(el) > area(best) ? el : best),
    null
  )
  const around = scrollableAround(focused)
  if (around && boxes.includes(around) && (!biggest || area(around) * 2 >= area(biggest)))
    return around
  if (biggest) return biggest
  const page = doc.scrollingElement
  return page instanceof HTMLElement && page.scrollHeight > page.clientHeight + 1 ? page : null
}

/**
 * Scroll `target` by the stick's vertical deflection (-1 up .. 1 down, past the dead zone) for `ms` milliseconds:
 * gently near the centre, quickly at the edge.
 */
export function stickScroll(target: HTMLElement, deflection: number, ms: number): void {
  if (deflection === 0) return
  const step = Math.min(ms, 50) / 1000
  target.scrollTop += Math.sign(deflection) * deflection * deflection * STICK_SCROLL_SPEED * step
}
