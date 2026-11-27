// Typed in-memory event bus for the mock API. Mirrors the renderer-facing half of src/main/events.ts: listeners are
// isolated from each other (one throwing listener never blocks the rest) and `on` returns an unsubscribe function.
import type { PlayOutEventName, PlayOutEvents } from '@shared/types'

export type MockListener<E extends PlayOutEventName> = (payload: PlayOutEvents[E]) => void

export interface MockEmitter {
  emit<E extends PlayOutEventName>(event: E, payload: PlayOutEvents[E]): void
  on<E extends PlayOutEventName>(event: E, listener: MockListener<E>): () => void
  listenerCount(event: PlayOutEventName): number
}

export function createEmitter(): MockEmitter {
  const listeners = new Map<PlayOutEventName, Set<MockListener<PlayOutEventName>>>()

  return {
    emit(event, payload) {
      const set = listeners.get(event)
      if (!set) return
      // Copy so a listener that unsubscribes (or subscribes) during dispatch cannot disturb the iteration.
      for (const listener of [...set]) {
        try {
          listener(payload)
        } catch (err) {
          console.error(`[mock] listener for ${event} failed`, err)
        }
      }
    },

    on(event, listener) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      const entry = listener as MockListener<PlayOutEventName>
      set.add(entry)
      return () => {
        set.delete(entry)
      }
    },

    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    }
  }
}
