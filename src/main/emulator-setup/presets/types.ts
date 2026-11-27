import type { ConfigureContext } from '../types'

/**
 * Contract of the fullscreen and controller presets (docs/emulator-setup.md, "Fullscreen and controllers"): each
 * emulator module turns on fullscreen and sets up an XInput/SDL game controller, leaving every other setting at the
 * emulator's default.
 */

/** A program started in the background by a preset (Ryujinx's default Config.json, PCSX2's -testconfig). */
export interface HiddenProcess {
  /** Resolves with the exit code (null when killed or it could not start). */
  exited: Promise<number | null>
  /** The process id (absent when it could not start). */
  pid?: number
  /** Kill the process tree; resolves when it exited. */
  stop(): Promise<void>
  /** Ask the program to close (it saves and exits), killing it when it does not within 10 s. */
  close?(): Promise<void>
}

/** What every preset module gets. */
export interface PresetContext extends ConfigureContext {
  /**
   * True when the presets were never applied to this emulator before. Fullscreen is only switched on then, so a user
   * who later turns it off is not overridden.
   */
  firstTime: boolean
  /**
   * The PRESETS_VERSION last applied to this emulator (undefined: never; 0: a first run that was deferred). A setting a
   * later version brings is switched on when this is older than that version (big-picture.ts newSince), once.
   */
  previousVersion: number | undefined
  /** Start a program without a window and without waiting for it. */
  startHidden(file: string, args: string[], options: { cwd: string }): HiddenProcess
}

/**
 * Thrown by a preset that cannot run now but should run again at the next launch (the emulator is running, a runtime it
 * needs is still missing): the service records no presets version for it and shows no notice.
 */
export class PresetDeferredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PresetDeferredError'
  }
}

/**
 * One emulator's presets; idempotent, merges into existing files. Throws an Error when they could not be applied (a
 * notice, retried next launch) or a {@link PresetDeferredError} to be retried silently.
 */
export type ApplyPresets = (ctx: PresetContext) => Promise<void>
