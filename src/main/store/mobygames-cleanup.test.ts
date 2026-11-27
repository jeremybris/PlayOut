import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonStore } from './json-store'
import { LibraryStore } from './library-store'
import { SettingsStore } from './settings-store'

// MobyGames support was removed: what it left in the user's files goes away.
describe('MobyGames leftovers', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'playout-moby-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("drops a game's Moby Score, IGDB rating and Backloggd rating on load and keeps the rest of its metadata", async () => {
    const file = join(dir, 'library.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        games: {
          a: {
            id: 'a',
            metadata: {
              genres: ['RPG'],
              moby: { score: 8.4, id: 1 },
              igdbRating: { score: 84, id: 2 },
              backloggdRating: { score: 4.5, igdbId: 3 }
            }
          }
        },
        platforms: {},
        sources: {}
      })
    )
    const store = new LibraryStore(file)
    await store.load()
    expect(store.getGame('a')?.metadata).toEqual({ genres: ['RPG'] })
  })

  it('writes settings.json once without the MobyGames key, keeping every other setting', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        scrapers: {
          mobygames: { apiKey: 'fake-moby-key' },
          steamgriddb: { apiKey: 'fake-sgdb-key' }
        }
      })
    )
    const store = new SettingsStore(file)
    const settings = await store.load()
    expect(settings.scrapers.steamgriddb.apiKey).toBe('fake-sgdb-key')
    await store.flush()
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('mobygames')
    expect(text).not.toContain('fake-moby-key')
    expect(text).toContain('fake-sgdb-key')
  })

  it('does not rewrite a settings.json without MobyGames', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      JSON.stringify({ version: 2, scrapers: { steamgriddb: { apiKey: 'fake-sgdb-key' } } })
    )
    const replace = vi.spyOn(JsonStore.prototype, 'replace')
    try {
      await new SettingsStore(file).load()
      expect(replace).not.toHaveBeenCalled()
    } finally {
      replace.mockRestore()
    }
  })
})
