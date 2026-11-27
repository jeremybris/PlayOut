import {
  buttonsOf,
  maskOf,
  type ComboCaptureEvent,
  type PadButton,
  type PadInfo
} from '../../shared/overlay'
import { tMain } from '../i18n'

/**
 * The home combo matcher (docs/home-overlay.md, "Controller buttons"). Pure: it is fed every pad report and says
 * when the combo completes.
 *
 * - A combo fires on the press that completes it: every combo button held on ONE pad (two pads holding half each
 *   never count) and at least one of them pressed since the last report. Extra buttons held alongside are allowed.
 * - With holdMs > 0 the completed combo must stay held that long. Reports only arrive when buttons change, so the
 *   caller asks `pendingUntil()` and calls `update` again at that time with the same pads.
 * - Once fired it cannot fire again until one of its buttons is released, so holding Guide opens the overlay once.
 * - A pad seen for the first time is taken as it is: buttons it already holds were not "just pressed". This keeps
 *   the Guide press that turns an Xbox pad on (and connects it) from opening the overlay.
 * - A pad that disconnects forgets its state.
 */
export interface ComboMatcher {
  /** Feed the pads as reported now; true exactly once per completed press. */
  update(pads: readonly PadInfo[], t?: number): boolean
  /** When a held combo will complete its hold (ms, the `now` clock), or null when none is waiting. */
  pendingUntil(): number | null
}

interface PadState {
  prev: number
  /** 'idle': waiting for a press; 'holding': completed at `since`, waiting for holdMs; 'fired': until released. */
  phase: 'idle' | 'holding' | 'fired'
  since: number
}

export function createComboMatcher(options: {
  combo: readonly PadButton[]
  holdMs: number
  now?: () => number
}): ComboMatcher {
  const combo = maskOf(options.combo)
  const holdMs = Math.max(0, Number.isFinite(options.holdMs) ? options.holdMs : 0)
  const now = options.now ?? Date.now
  const state = new Map<string, PadState>()

  return {
    update(pads, t = now()) {
      let fired = false
      const seen = new Set<string>()
      for (const pad of pads) {
        seen.add(pad.id)
        const mask = pad.buttons
        let s = state.get(pad.id)
        if (!s) {
          s = { prev: mask, phase: 'idle', since: 0 }
          state.set(pad.id, s)
        }
        if (combo === 0) {
          s.prev = mask
          continue
        }
        const held = (mask & combo) === combo
        const justPressed = (mask & ~s.prev & combo) !== 0
        s.prev = mask
        if (!held) {
          s.phase = 'idle'
          continue
        }
        if (s.phase === 'idle' && justPressed) {
          s.phase = 'holding'
          s.since = t
        }
        if (s.phase === 'holding' && t - s.since >= holdMs) {
          s.phase = 'fired'
          fired = true
        }
      }
      for (const id of [...state.keys()]) if (!seen.has(id)) state.delete(id)
      return fired
    },
    pendingUntil() {
      let at: number | null = null
      for (const s of state.values()) {
        if (s.phase !== 'holding') continue
        const due = s.since + holdMs
        if (at === null || due < at) at = due
      }
      return at
    }
  }
}

/** The most buttons a combo may have (the settings schema's limit). */
export const MAX_COMBO_BUTTONS = 4

/**
 * Whether a recorded combo can be the home button. More than 4 buttons is over the settings' limit, and a single
 * button other than Guide (Home) is one games use all the time (pressing B to back out of the capture would make B
 * open the overlay in every game).
 */
export function validateCombo(
  buttons: readonly PadButton[]
): { ok: true } | { ok: false; reason: string } {
  if (buttons.length === 0) return { ok: false, reason: tMain('mainApp.combo.pressOne') }
  if (buttons.length > MAX_COMBO_BUTTONS)
    return { ok: false, reason: tMain('mainApp.combo.atMostFour') }
  if (buttons.length === 1 && buttons[0] !== 'guide') {
    return {
      ok: false,
      reason: tMain('mainApp.combo.single')
    }
  }
  return { ok: true }
}

/**
 * Settings' "Press new buttons": records the buttons the user holds together.
 *
 * The first pad that presses something owns the capture; its held buttons accumulate (pressing LB, then adding RB
 * records both) and the capture is done when that pad releases everything. At most 4 buttons are kept: the first
 * four pressed (several in one report count in button order); later ones are ignored. Pads that already hold
 * buttons when the capture starts (the A press that clicked "Press new buttons") are ignored until they release all
 * their buttons. The owner disconnecting starts over.
 *
 * A recorded combo that `validateCombo` refuses (a single button other than Guide, such as B pressed to back out)
 * ends the capture with `{ held: [], done: [] }`: an empty `done` means cancelled/rejected, and nothing is saved.
 * The reason is in `rejected` (ComboCaptureEvent in shared/overlay.ts has no field for it).
 */
export interface ComboCapture {
  /** Feed the pads as reported now; the event to send when what is shown changed, else null. */
  feed(pads: readonly PadInfo[]): ComboCaptureEvent | null
  /** True once the capture ended, recorded or rejected (further feeds return null). */
  readonly finished: boolean
  /** Why the recorded buttons were refused (the capture then ended with an empty done), else null. */
  readonly rejected: string | null
}

export function createComboCapture(): ComboCapture {
  const blocked = new Set<string>()
  const known = new Set<string>()
  let owner: string | null = null
  let union = 0
  let finished = false
  let rejected: string | null = null

  /** `union` plus the new buttons in `mask`, up to MAX_COMBO_BUTTONS. */
  function add(mask: number): number {
    let next = union
    let count = buttonsOf(union).length
    for (const b of buttonsOf(mask & ~union)) {
      if (count >= MAX_COMBO_BUTTONS) break
      next |= maskOf([b])
      count++
    }
    return next
  }

  return {
    get finished() {
      return finished
    },
    get rejected() {
      return rejected
    },
    feed(pads) {
      if (finished) return null
      const byId = new Map(pads.map((p) => [p.id, p.buttons]))
      for (const pad of pads) {
        if (!known.has(pad.id)) {
          known.add(pad.id)
          if (pad.buttons !== 0) blocked.add(pad.id)
        } else if (blocked.has(pad.id) && pad.buttons === 0) {
          blocked.delete(pad.id)
        }
      }
      for (const id of [...known]) {
        if (!byId.has(id)) {
          known.delete(id)
          blocked.delete(id)
        }
      }

      if (owner !== null && !byId.has(owner)) {
        owner = null
        const had = union
        union = 0
        if (had !== 0) return { held: [] }
      }
      if (owner === null) {
        const first = pads.find((p) => p.buttons !== 0 && !blocked.has(p.id))
        if (!first) return null
        owner = first.id
      }

      const mask = byId.get(owner) ?? 0
      if (mask === 0) {
        finished = true
        const combo = buttonsOf(union)
        const check = validateCombo(combo)
        if (!check.ok) {
          rejected = check.reason
          return { held: [], done: [] }
        }
        return { held: combo, done: combo }
      }
      const next = add(mask)
      if (next === union) return null
      union = next
      return { held: buttonsOf(union) }
    }
  }
}
