import { readFileSync } from 'fs'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { FRAME_LIMIT_MAX } from '../../shared/overlay-extras'

/**
 * The overlay's per-game memory (userData\overlay\game-extras.json): the frame rate limit picked for each game and
 * the RivaTuner profile (exe) it was written to, so it is put on again when the game starts and taken off the right
 * profile when the game's exe turns out to be another one. Keys are PlayOut game ids, or 'exe:<lower-case exe>' for
 * programs PlayOut did not start.
 *
 * It also remembers every exe a "Sync FPS + refresh" limit was written to (key '$synced'), so turning sync off takes
 * those limits off again, even after a restart or with no game running.
 */

export interface GameExtras {
  /** 0 = unlimited. */
  frameLimit: number
  /** The RivaTuner profile it was written to, e.g. 'Game.exe'. */
  exe: string
}

export interface GameExtrasStore {
  get(key: string): GameExtras | null
  set(key: string, value: GameExtras | null): Promise<void>
  /** The exe a sync limit was last written to for this key, or null. */
  getSynced(key: string): string | null
  /** Record (or with null forget) the exe a sync limit was written to. */
  setSynced(key: string, exe: string | null): Promise<void>
  /** Every [key, exe] a sync limit is still on. */
  allSynced(): [string, string][]
  /** Forget everything (the power helper was removed and put every profile back). */
  clear(): Promise<void>
}

/** The file's key for the sync record (never a game key: game ids are not this, and exe keys start with 'exe:'). */
export const SYNCED_KEY = '$synced'
// eslint-disable-next-line no-control-regex -- control characters cannot be in a file name
const EXE = /^[^\\/:*?"<>|\x00-\x1f]{1,260}$/

const KEY = /^.{1,300}$/s

function valid(v: unknown): v is GameExtras {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.frameLimit === 'number' &&
    Number.isInteger(o.frameLimit) &&
    o.frameLimit >= 0 &&
    o.frameLimit <= FRAME_LIMIT_MAX &&
    typeof o.exe === 'string' &&
    o.exe.length > 0 &&
    o.exe.length <= 260
  )
}

interface Loaded {
  entries: Map<string, GameExtras>
  synced: Map<string, string>
}

/** The file's entries that are well formed; a missing or malformed file reads as empty. */
function load(file: string): Loaded {
  const out: Loaded = { entries: new Map(), synced: new Map() }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return out
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === SYNCED_KEY) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v))
        for (const [sk, exe] of Object.entries(v as Record<string, unknown>))
          if (KEY.test(sk) && typeof exe === 'string' && EXE.test(exe)) out.synced.set(sk, exe)
    } else if (KEY.test(k) && valid(v)) out.entries.set(k, { frameLimit: v.frameLimit, exe: v.exe })
  }
  return out
}

export function createGameExtrasStore(file: string): GameExtrasStore {
  let loaded: Loaded | null = null
  const data = (): Loaded => (loaded ??= load(file))
  const all = (): Map<string, GameExtras> => data().entries
  let queue: Promise<void> = Promise.resolve()

  /** Write the whole file atomically (a temp file renamed over it), one write at a time. */
  function save(): Promise<void> {
    const { synced } = data()
    const text = JSON.stringify(
      {
        ...Object.fromEntries(all()),
        ...(synced.size ? { [SYNCED_KEY]: Object.fromEntries(synced) } : {})
      },
      null,
      2
    )
    const work = async (): Promise<void> => {
      await fs.mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, text)
      await fs.rename(tmp, file)
    }
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    get(key) {
      const v = all().get(key)
      return v ? { ...v } : null
    },
    getSynced(key) {
      return data().synced.get(key) ?? null
    },
    async setSynced(key, exe) {
      if (!KEY.test(key) || key === SYNCED_KEY) throw new Error('Not a game key')
      if (exe !== null && !EXE.test(exe)) throw new Error('Not a program name')
      const { synced } = data()
      if (exe === null) {
        if (!synced.has(key)) return
        synced.delete(key)
      } else {
        if (synced.get(key) === exe) return
        synced.set(key, exe)
      }
      await save()
    },
    allSynced() {
      return [...data().synced]
    },
    async clear() {
      const d = data()
      if (!d.entries.size && !d.synced.size) return
      d.entries.clear()
      d.synced.clear()
      await save()
    },
    async set(key, value) {
      if (!KEY.test(key) || key === SYNCED_KEY) throw new Error('Not a game key')
      if (value !== null && !valid(value)) throw new Error('Not a valid frame limit')
      const map = all()
      if (value === null) {
        if (!map.has(key)) return
        map.delete(key)
      } else map.set(key, { frameLimit: value.frameLimit, exe: value.exe })
      await save()
    }
  }
}
