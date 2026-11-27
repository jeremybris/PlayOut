import { promises as fs } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  gogHiddenIds,
  hiddenProductIds,
  readGalaxyHiddenGogIds,
  resetGalaxyHiddenCache
} from './gog-galaxy-hidden'

/** The real signed-in user id from a Galaxy install: above 2^53, so it only survives as text. */
const USER = '46987917103636323'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-ggh-test-'))
  resetGalaxyHiddenCache()
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** A Galaxy-shaped database: the two tables the reader queries, with Galaxy's column types. */
function createDb(
  rows: [userId: string, releaseKey: string, hidden: 0 | 1][],
  users = [USER]
): DatabaseSync {
  const db = new DatabaseSync(join(dir, 'galaxy-2.0.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE Users (id INTEGER PRIMARY KEY NOT NULL)')
  db.exec(
    'CREATE TABLE UserReleaseProperties (userId INT64 NOT NULL, releaseKey TEXT NOT NULL, isHidden BOOLEAN NOT NULL, hasTagsFetched BOOLEAN)'
  )
  for (const id of users) db.exec(`INSERT INTO Users VALUES (${id})`)
  for (const [userId, key, hidden] of rows) {
    db.exec(`INSERT INTO UserReleaseProperties VALUES (${userId}, '${key}', ${hidden}, 0)`)
  }
  return db
}

describe('readGalaxyHiddenGogIds', () => {
  it('returns the GOG games the signed-in user hid, nothing else', async () => {
    const db = createDb([
      [USER, 'gog_1207658924', 1],
      [USER, 'gog_1207659061', 1],
      [USER, 'gog_1207658695', 0],
      [USER, 'steam_620', 1],
      [USER, 'gogx_5', 1],
      ['12345', 'gog_999', 1]
    ])
    db.close()
    expect(await readGalaxyHiddenGogIds({ storageDir: dir })).toEqual(
      new Set(['1207658924', '1207659061'])
    )
  })

  it('reads changes still in the write-ahead log while Galaxy holds the database open', async () => {
    const db = createDb([[USER, 'gog_1', 1]])
    db.exec('PRAGMA wal_autocheckpoint = 0')
    db.exec(`INSERT INTO UserReleaseProperties VALUES (${USER}, 'gog_2', 1, 0)`)
    try {
      expect(await fs.stat(join(dir, 'galaxy-2.0.db-wal'))).toBeTruthy()
      expect(await readGalaxyHiddenGogIds({ storageDir: dir })).toEqual(new Set(['1', '2']))
    } finally {
      db.close()
    }
  })

  it('never writes the live files', async () => {
    createDb([[USER, 'gog_1', 1]]).close()
    const before = await fs.readdir(dir)
    const stat = await fs.stat(join(dir, 'galaxy-2.0.db'))
    await readGalaxyHiddenGogIds({ storageDir: dir })
    expect(await fs.readdir(dir)).toEqual(before)
    expect((await fs.stat(join(dir, 'galaxy-2.0.db'))).mtimeMs).toBe(stat.mtimeMs)
  })

  it('answers again when the database changes', async () => {
    let db = createDb([[USER, 'gog_1', 1]])
    db.close()
    expect(await readGalaxyHiddenGogIds({ storageDir: dir })).toEqual(new Set(['1']))
    db = new DatabaseSync(join(dir, 'galaxy-2.0.db'))
    db.exec(`UPDATE UserReleaseProperties SET isHidden = 0`)
    db.close()
    expect(await readGalaxyHiddenGogIds({ storageDir: dir })).toEqual(new Set())
  })

  it('is an empty answer when Galaxy is not installed', async () => {
    expect(await readGalaxyHiddenGogIds({ storageDir: join(dir, 'missing') })).toEqual(new Set())
  })

  it('is no answer when nobody is signed in to Galaxy', async () => {
    createDb([[USER, 'gog_1', 1]], []).close()
    expect(await readGalaxyHiddenGogIds({ storageDir: dir })).toBeNull()
  })

  it('is no answer when the database cannot be read', async () => {
    await fs.writeFile(join(dir, 'galaxy-2.0.db'), 'not a database')
    expect(await readGalaxyHiddenGogIds({ storageDir: dir })).toBeNull()
  })

  it('leaves no copy behind, and sweeps copies an interrupted run left', async () => {
    createDb([[USER, 'gog_1', 1]]).close()
    const stale = await fs.mkdtemp(join(tmpdir(), 'playout-galaxy-hidden-copy-'))
    await fs.writeFile(join(stale, 'galaxy-2.0.db'), 'left by a killed run')
    await readGalaxyHiddenGogIds({ storageDir: dir })
    const leftovers = (await fs.readdir(tmpdir())).filter((n) =>
      n.startsWith('playout-galaxy-hidden-copy-')
    )
    expect(leftovers).toEqual([])
  })

  it('shares one read between overlapping calls', async () => {
    createDb([[USER, 'gog_1', 1]]).close()
    const copy = vi.spyOn(fs, 'copyFile')
    try {
      const [a, b] = await Promise.all([
        readGalaxyHiddenGogIds({ storageDir: dir }),
        readGalaxyHiddenGogIds({ storageDir: dir })
      ])
      expect(a).toEqual(new Set(['1']))
      expect(b).toEqual(new Set(['1']))
      // One copy of the .db (plus its side files), not two.
      expect(copy.mock.calls.filter(([from]) => String(from).endsWith('.db'))).toHaveLength(1)
    } finally {
      copy.mockRestore()
    }
  })

  it('takes the copy again when Galaxy writes during it', async () => {
    const db = createDb([[USER, 'gog_1', 1]])
    db.exec('PRAGMA wal_autocheckpoint = 0')
    const realCopy = fs.copyFile.bind(fs)
    let writes = 0
    const copy = vi.spyOn(fs, 'copyFile').mockImplementation(async (from, to, mode) => {
      await realCopy(from, to, mode)
      // Galaxy writes right after the first copy of the .db.
      if (String(from).endsWith('.db') && writes++ === 0) {
        db.exec(`INSERT INTO UserReleaseProperties VALUES (${USER}, 'gog_2', 1, 0)`)
      }
    })
    try {
      expect(await readGalaxyHiddenGogIds({ storageDir: dir })).toEqual(new Set(['1', '2']))
      expect(writes).toBe(2)
    } finally {
      copy.mockRestore()
      db.close()
    }
  })
})

describe('hiddenProductIds', () => {
  it('keeps gog_<digits> keys only', () => {
    expect(
      hiddenProductIds([
        { releaseKey: 'gog_1' },
        { releaseKey: 'gog_x' },
        { releaseKey: 'steam_2' },
        {},
        null
      ])
    ).toEqual(new Set(['1']))
  })
})

describe('gogHiddenIds', () => {
  const games = [
    { source: 'gog' as const, externalId: '10', owned: true, extra: { gogHidden: true } },
    { source: 'gog' as const, externalId: '11', owned: true, extra: { gogHidden: false } },
    { source: 'gog' as const, externalId: '12', owned: true },
    // Left the account's listing (signed out): its gog.com flag no longer counts.
    { source: 'gog' as const, externalId: '14', owned: false, extra: { gogHidden: true } },
    // Hidden by a store at the last sync; Galaxy may be the one that hid it.
    { source: 'gog' as const, externalId: '15', owned: false, hiddenByStore: true },
    { source: 'steam' as const, externalId: '13', owned: true, extra: { gogHidden: true } }
  ]

  it('joins Galaxy with the games hidden on gog.com', () => {
    expect(gogHiddenIds(new Set(['1']), games)).toEqual(new Set(['1', '10']))
  })

  it("keeps store-hidden games hidden when Galaxy's answer is unknown", () => {
    expect(gogHiddenIds(null, games)).toEqual(new Set(['10', '15']))
  })
})
