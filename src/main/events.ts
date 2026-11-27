import { IPC_EVENT_CHANNEL } from '../shared/api'
import type { PlayOutEventName, PlayOutEvents } from '../shared/types'

type Listener<E extends PlayOutEventName> = (payload: PlayOutEvents[E]) => void

export type Broadcast = (channel: string, message: { event: string; payload: unknown }) => void

/**
 * Typed event bus: every emit reaches the renderer (through `broadcast`) and main-process subscribers.
 * `broadcast` is injected so the bus stays free of Electron for unit tests.
 */
export class EventBus {
  private readonly listeners = new Map<PlayOutEventName, Set<Listener<PlayOutEventName>>>()

  constructor(private readonly broadcast: Broadcast = () => {}) {}

  emit<E extends PlayOutEventName>(event: E, payload: PlayOutEvents[E]): void {
    try {
      this.broadcast(IPC_EVENT_CHANNEL, { event, payload })
    } catch {
      /* window may be gone */
    }
    const set = this.listeners.get(event)
    if (set) {
      for (const l of set) {
        try {
          l(payload)
        } catch (err) {
          console.error(`event listener for ${event} failed`, err)
        }
      }
    }
  }

  on<E extends PlayOutEventName>(event: E, listener: Listener<E>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener<PlayOutEventName>)
    return () => {
      set!.delete(listener as Listener<PlayOutEventName>)
    }
  }
}

/** A window the bus can send to (a BrowserWindow, or a fake in tests). */
export interface BroadcastTarget {
  webContents: { send(channel: string, message: unknown): void }
  isDestroyed(): boolean
}

/** What a broadcast target function may return: one window, several (main and overlay), or none yet. */
export type BroadcastTargets =
  BroadcastTarget | readonly (BroadcastTarget | null | undefined)[] | null | undefined

/**
 * The windows to send to: the windows `targets` names, or `all()` when it names none (the bus starts before the
 * main window exists). A named window that is destroyed is skipped, never a reason to fall back to every window, so
 * the store sign-in windows still get no app events while the app is shutting down.
 */
export function broadcastWindows(
  targets: BroadcastTargets,
  all: () => readonly BroadcastTarget[]
): BroadcastTarget[] {
  const list: readonly (BroadcastTarget | null | undefined)[] = Array.isArray(targets)
    ? targets
    : [targets as BroadcastTarget | null | undefined]
  const named = list.filter((w): w is BroadcastTarget => !!w)
  const chosen = named.length ? named : all()
  return [...new Set(chosen)].filter((w) => !w.isDestroyed())
}

/**
 * Broadcast to the app's own windows: the main window and the overlay (ARCHITECTURE.md §4.8: the store sign-in
 * windows have no preload and must not receive app events). `target` is read on every emit because the windows are
 * created after the bus, and may return one window or a list. Until it returns any, and without a target, every
 * window receives the event (the pre-accounts behaviour). Loaded lazily so this module can be imported without
 * Electron.
 */
export async function createRendererBroadcast(target?: () => BroadcastTargets): Promise<Broadcast> {
  const { BrowserWindow } = await import('electron')
  return (channel, message) => {
    for (const win of broadcastWindows(target?.(), () => BrowserWindow.getAllWindows())) {
      try {
        win.webContents.send(channel, message)
      } catch {
        /* one window going away must not keep the event from the other */
      }
    }
  }
}
