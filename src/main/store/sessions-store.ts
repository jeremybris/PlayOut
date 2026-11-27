import type { PlaySession } from '../../shared/types'
import { newId } from '../util/ids'
import { JsonStore } from './json-store'

interface SessionsFile {
  version: 1
  sessions: PlaySession[]
  /**
   * The ids of the sessions dropped by the MAX_SESSIONS limit (newest last, at most MAX_DROPPED_IDS): has() still
   * knows them, so the play time sync never takes a dropped session again as a new one.
   */
  dropped?: string[]
}

const MAX_SESSIONS = 10_000
const MAX_DROPPED_IDS = 50_000

export class SessionsStore {
  private readonly store: JsonStore<SessionsFile>
  /** The ids of the sessions and dropped sessions (built on first use, kept up to date after). */
  private ids: Set<string> | null = null

  constructor(file: string) {
    this.store = new JsonStore<SessionsFile>({
      file,
      defaults: () => ({ version: 1, sessions: [] }),
      normalize: (raw) => {
        const r = raw as Partial<SessionsFile> | null
        if (!r || typeof r !== 'object') return null
        const dropped = Array.isArray(r.dropped)
          ? r.dropped.filter((id): id is string => typeof id === 'string')
          : []
        return {
          version: 1,
          sessions: Array.isArray(r.sessions) ? r.sessions : [],
          ...(dropped.length ? { dropped } : {})
        }
      },
      debounceMs: 1000
    })
  }

  load(): Promise<SessionsFile> {
    this.ids = null
    return this.store.load()
  }

  start(gameId: string, startedAt: string): PlaySession {
    const session: PlaySession = { id: newId('s'), gameId, startedAt, minutes: 0 }
    this.store.set((d) => {
      d.sessions.push(session)
      this.trim(d)
    })
    this.ids?.add(session.id)
    return session
  }

  /**
   * Sessions played on another PC (the play time sync), each as given; one already here (or dropped) is skipped.
   * Returns the ones added.
   */
  add(sessions: PlaySession[]): PlaySession[] {
    const added: PlaySession[] = []
    const ids = this.knownIds()
    for (const s of sessions) {
      if (ids.has(s.id)) continue
      ids.add(s.id)
      added.push({ ...s })
    }
    if (added.length)
      this.store.set((d) => {
        d.sessions.push(...added)
        this.trim(d)
      })
    return added
  }

  /** Whether a session of this id is here, or was (dropped by the limit). */
  has(id: string): boolean {
    return this.knownIds().has(id)
  }

  end(sessionId: string, endedAt: string, minutes: number): PlaySession | undefined {
    let found: PlaySession | undefined
    this.store.set((d) => {
      found = d.sessions.find((s) => s.id === sessionId)
      if (found) {
        found.endedAt = endedAt
        found.minutes = minutes
      }
    })
    return found
  }

  /** Move a game's sessions to its new id (a converted ROM). */
  rekey(fromId: string, toId: string): void {
    this.store.set((d) => {
      for (const s of d.sessions) if (s.gameId === fromId) s.gameId = toId
    })
  }

  forGame(gameId: string): PlaySession[] {
    return this.store.get().sessions.filter((s) => s.gameId === gameId)
  }

  all(): PlaySession[] {
    return this.store.get().sessions
  }

  /** `flush()` that tells whether the write reached the disk (false = it failed); never rejects. */
  tryFlush(): Promise<boolean> {
    return this.store.tryFlush()
  }

  flush(): Promise<void> {
    return this.store.flush()
  }

  private knownIds(): Set<string> {
    if (!this.ids) {
      const d = this.store.get()
      this.ids = new Set([...(d.dropped ?? []), ...d.sessions.map((s) => s.id)])
    }
    return this.ids
  }

  /**
   * The sessions past MAX_SESSIONS go, those taken from other PCs (`from`) first, oldest first: one taken from a host
   * never pushes out this PC's own, which the play time sync may still have to send to another host. Their ids are
   * kept (dropped).
   */
  private trim(d: SessionsFile): void {
    let over = d.sessions.length - MAX_SESSIONS
    if (over <= 0) return
    const gone: PlaySession[] = []
    const kept: PlaySession[] = []
    for (const s of d.sessions) {
      if (over > 0 && s.from) {
        gone.push(s)
        over--
      } else kept.push(s)
    }
    if (over > 0) gone.push(...kept.splice(0, over))
    d.sessions = kept
    const dropped = [...(d.dropped ?? []), ...gone.map((s) => s.id)]
    d.dropped = dropped.length > MAX_DROPPED_IDS ? dropped.slice(-MAX_DROPPED_IDS) : dropped
    // An id past the dropped limit is forgotten too.
    if (this.ids && dropped.length > MAX_DROPPED_IDS) this.ids = null
  }
}
