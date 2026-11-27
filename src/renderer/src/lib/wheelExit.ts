/**
 * The "wheel up at the top of the grid returns Home" gesture of the Library view (screens/Library), as
 * pure state so its rules can be unit tested without a DOM. Only a deliberate, continuous upward wheel
 * gesture that starts while the grid viewport is already resting at its top counts: the momentum that
 * carried the grid up to its top, the remainder of the burst that got it there, and the momentum that
 * opened the view from Home never do.
 */
export interface WheelExitOptions {
  /** Upward deltaY (px) one gesture must accumulate. */
  step: number
  /** The viewport must have stopped scrolling this long ago (ms) before upward deltas count. */
  restMs: number
  /** A pause longer than this (ms) between two wheel events starts a new gesture. */
  gapMs: number
  /** Wheel events are ignored for this long (ms) after the view appeared (the momentum that opened it). */
  graceMs: number
}

export interface WheelExitEvent {
  deltaY: number
  /** performance.now() of the event. */
  now: number
  /** The viewport is at its top (scrollTop <= 0). */
  atTop: boolean
  /** Something on top of the view (a modal, the on-screen keyboard) owns the input. */
  blocked?: boolean
}

export class WheelExit {
  private acc = 0
  private lastWheelAt = -Infinity
  private lastScrollAt = -Infinity
  /** A wheel event of the current burst saw the viewport away from its top: the burst is scrolling, not exiting. */
  private burstScrolled = false

  constructor(
    private readonly options: WheelExitOptions,
    private readonly openedAt: number
  ) {}

  /** The viewport scrolled (any direction, any cause). */
  scrolled(now: number): void {
    this.lastScrollAt = now
    this.acc = 0
  }

  /** True when the viewport has been resting at its top long enough for an exit gesture to start. */
  restedAtTop(now: number, atTop: boolean): boolean {
    const { restMs, graceMs } = this.options
    return atTop && now - this.openedAt >= graceMs && now - this.lastScrollAt >= restMs
  }

  /** One wheel event; returns true when the gesture completed and the view should return Home. */
  wheel(event: WheelExitEvent): boolean {
    const { step, gapMs } = this.options
    const { deltaY, now, atTop } = event
    if (now - this.lastWheelAt > gapMs) {
      this.burstScrolled = false
      this.acc = 0
    }
    this.lastWheelAt = now
    if (!atTop) this.burstScrolled = true
    if (deltaY >= 0 || event.blocked || this.burstScrolled || !this.restedAtTop(now, atTop)) {
      this.acc = 0
      return false
    }
    this.acc -= deltaY
    if (this.acc < step) return false
    this.acc = 0
    return true
  }
}
