import { win32 } from 'path'
import { z } from 'zod'
import { writeFileAtomic, type HomeButtonIo } from './io'

/**
 * `<dataDir>\overrides.json`: what PlayOut changed outside itself for the home button, with the values it found, so
 * they can be put back even after a crash or a reinstall. Written before the change it records, so a change is
 * never made without its original being kept.
 */
const steamFileSchema = z.object({
  path: z.string(),
  /** The Guide button key's value found before PlayOut's edit; null when the key was absent. */
  original: z.string().nullable(),
  /**
   * Every key PlayOut changed in this file -> its value before the edit (null: absent). Records from before 0.9.49
   * have only `original` (the Guide button key).
   */
  originals: z.record(z.string(), z.string().nullable()).optional(),
  /** A copy of the file as it was, next to overrides.json. */
  backup: z.string().optional()
})

const recordSchema = z.object({
  version: z.literal(1),
  steam: z
    .object({
      steamPath: z.string(),
      files: z.array(steamFileSchema)
    })
    .optional(),
  gameBar: z
    .object({
      /** Value name -> the DWORD found before PlayOut's change (null: absent). */
      values: z.record(z.string(), z.number().nullable()),
      /** Game Bar's links (game-bar-links.ts) as they were before PlayOut pointed them at nothing. */
      links: z
        .record(
          z.string(),
          z.object({
            keyExisted: z.boolean(),
            shellExisted: z.boolean(),
            openExisted: z.boolean().optional(),
            commandKeyExisted: z.boolean().optional(),
            command: z.string().nullable(),
            commandType: z.string().nullable().optional(),
            keyDefault: z.boolean().optional(),
            urlProtocol: z.string().nullable().optional(),
            noOpenWith: z.boolean()
          })
        )
        .optional()
    })
    .optional(),
  /**
   * Set just before PlayOut asks Steam to close for a change and cleared once Steam was started again. Still present
   * at the next start means PlayOut quit or crashed in between: Steam is started then if it is not running.
   */
  steamClosed: z
    .object({
      steamClosedAt: z.number(),
      /** The steam.exe that was asked to close. */
      exe: z.string()
    })
    .optional()
})

export type OverridesRecord = z.infer<typeof recordSchema>
export type SteamOverrideRecord = NonNullable<OverridesRecord['steam']>
export type GameBarOverrideRecord = NonNullable<OverridesRecord['gameBar']>
export type SteamClosedRecord = NonNullable<OverridesRecord['steamClosed']>

export interface OverridesStore {
  read(): Promise<OverridesRecord>
  /** Replace one section (undefined removes it). */
  set<K extends 'steam' | 'gameBar' | 'steamClosed'>(
    section: K,
    value: OverridesRecord[K]
  ): Promise<void>
}

export function createOverridesStore(io: HomeButtonIo, dataDir: string): OverridesStore {
  const file = win32.join(dataDir, 'overrides.json')

  async function read(): Promise<OverridesRecord> {
    const data = await io.readFile(file)
    if (!data) return { version: 1 }
    try {
      const parsed = recordSchema.safeParse(JSON.parse(data.toString('utf8')))
      if (parsed.success) return parsed.data
    } catch {
      /* unreadable: start over below */
    }
    // An unreadable record is kept aside rather than overwritten: it may hold the only copy of an original.
    await io.copyFile(file, `${file}.bad`).catch(() => {})
    return { version: 1 }
  }

  return {
    read,
    async set(section, value) {
      const current = await read()
      const next: OverridesRecord = { ...current, [section]: value }
      if (value === undefined) delete next[section]
      await io.mkdir(dataDir)
      await writeFileAtomic(io, file, JSON.stringify(next, null, 2))
    }
  }
}
