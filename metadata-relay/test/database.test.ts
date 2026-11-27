import { describe, expect, it } from 'vitest'
import {
  appendMessage,
  appendRows,
  DB_REPO,
  DB_WRITE_RETRIES,
  groupByShard,
  mergeShard,
  readShard,
  type DbRepoRef
} from '../src/database'
import { encodeGameDbCsv, gameDbShardPath, type GameDbRow } from '../src/database-format'
import { FakeGitHub } from './fakes'

const row = (key: string, patch: Partial<GameDbRow> = {}): GameDbRow => ({
  key,
  title: `Game ${key}`,
  platform: 'pc',
  releaseDate: '2020',
  genres: ['Action'],
  tags: [],
  developers: [],
  publishers: [],
  localPlayers: null,
  steamAppId: null,
  ...patch
})

const SHARD = 'data/steam/03.csv'

function setup(): { gh: FakeGitHub; ref: DbRepoRef; waits: number[] } {
  const gh = new FakeGitHub()
  const waits: number[] = []
  const ref: DbRepoRef = {
    ...DB_REPO,
    token: 't',
    fetch: gh.fetch,
    sleep: async (ms) => {
      waits.push(ms)
    },
    random: () => 0.5
  }
  return { gh, ref, waits }
}

describe('mergeShard', () => {
  it('writes a new shard exactly as the format encodes it', () => {
    const rows = [row('steam-2'), row('steam-1')]
    const r = mergeShard(null, rows)
    expect(r.text).toBe(encodeGameDbCsv(rows))
    expect(r.added).toEqual(['steam-2', 'steam-1'])
    expect(r.present).toEqual([])
  })

  it('adds only keys the shard lacks, sorted in, and never changes a row that is there', () => {
    const before = encodeGameDbCsv([row('steam-1'), row('steam-3')])
    const r = mergeShard(before, [row('steam-3', { title: 'Vandalised' }), row('steam-2')])
    expect(r.added).toEqual(['steam-2'])
    expect(r.present).toEqual(['steam-3'])
    expect(r.text).toBe(encodeGameDbCsv([row('steam-1'), row('steam-2'), row('steam-3')]))
  })

  it('keeps rows it cannot read and columns a later version added', () => {
    const before =
      'key,title,platform,release_date,future\n' +
      'steam-9,"Broken, =row",pc,2099-99,kept\n' +
      'steam-1,One,pc,2001,x\n'
    const r = mergeShard(before, [row('steam-9'), row('steam-5', { releaseDate: '2005' })])
    expect(r.present).toEqual(['steam-9'])
    expect(r.text).toBe(
      'key,title,platform,release_date,future\n' +
        'steam-1,One,pc,2001,x\n' +
        'steam-5,Game steam-5,pc,2005,\n' +
        'steam-9,"Broken, =row",pc,2099-99,kept\n'
    )
  })

  it('leaves a shard with nothing new as it is, and refuses one without a key column', () => {
    const before = encodeGameDbCsv([row('steam-1')])
    expect(mergeShard(before, [row('steam-1')])).toEqual({
      text: before,
      added: [],
      present: ['steam-1']
    })
    expect(() => mergeShard('title,platform\nX,pc\n', [row('steam-1')])).toThrow(/key column/)
  })
})

describe('appendRows', () => {
  it('creates a shard on the database branch, named explicitly, with a plain commit message', async () => {
    const { gh, ref } = setup()
    expect(await appendRows(ref, SHARD, [row('steam-1'), row('steam-2')])).toEqual({
      added: ['steam-1', 'steam-2'],
      present: []
    })
    expect(gh.dbFile(SHARD)).toBe(encodeGameDbCsv([row('steam-1'), row('steam-2')]))
    const put = gh.dbCalls.find((c) => c.method === 'PUT')!
    expect(put.path).toBe(`/contents/${SHARD}`)
    expect(put.body).toMatchObject({ branch: 'database', message: 'Add 2 games from PlayOut' })
    expect((put.body as { sha?: string }).sha).toBeUndefined()
    expect(appendMessage(1)).toBe('Add 1 game from PlayOut')
    // Reads name the branch too (ref=database: GitHub would read main without it); nothing else is touched.
    expect(gh.calls.map((c) => [c.method, c.branch])).toEqual([
      ['GET', 'database'],
      ['PUT', 'database']
    ])
    expect(gh.branches.get('main')!.files.size).toBe(0)
    expect(gh.suggestBranches()).toEqual([])
  })

  it('keeps a file of the same path on main as it is', async () => {
    const { gh, ref } = setup()
    gh.branches.get('main')!.files.set(SHARD, 'main,untouched\n')
    gh.dbFiles.set(SHARD, encodeGameDbCsv([row('steam-1')]))
    expect(await appendRows(ref, SHARD, [row('steam-2')])).toEqual({
      added: ['steam-2'],
      present: []
    })
    expect(gh.dbFile(SHARD)).toBe(encodeGameDbCsv([row('steam-1'), row('steam-2')]))
    expect(gh.branches.get('main')!.files.get(SHARD)).toBe('main,untouched\n')
  })

  it('appends to an existing shard with its sha, and writes nothing when every key is there', async () => {
    const { gh, ref } = setup()
    gh.dbFiles.set(SHARD, encodeGameDbCsv([row('steam-1')]))
    expect(await appendRows(ref, SHARD, [row('steam-1'), row('steam-2')])).toEqual({
      added: ['steam-2'],
      present: ['steam-1']
    })
    expect(gh.dbCalls.find((c) => c.method === 'PUT')!.body).toHaveProperty('sha')
    gh.calls.length = 0
    let asked = 0
    expect(
      await appendRows(ref, SHARD, [row('steam-2')], {
        beforeWrite: async () => {
          asked++
        }
      })
    ).toEqual({ added: [], present: ['steam-2'] })
    expect(gh.dbCalls.map((c) => c.method)).toEqual(['GET'])
    expect(asked).toBe(0)
  })

  it('reads again and retries when another commit landed first (409 and 422)', async () => {
    for (const status of [409, 422]) {
      const { gh, ref, waits } = setup()
      gh.staleStatus = status
      gh.dbFiles.set(SHARD, encodeGameDbCsv([row('steam-1')]))
      // Someone else adds steam-2 (with their own title) and then steam-4 between our read and our write.
      gh.races = [
        (files) =>
          files.set(SHARD, encodeGameDbCsv([row('steam-1'), row('steam-2', { title: 'Theirs' })])),
        (files) =>
          files.set(
            SHARD,
            encodeGameDbCsv([row('steam-1'), row('steam-2', { title: 'Theirs' }), row('steam-4')])
          )
      ]
      const r = await appendRows(ref, SHARD, [row('steam-2'), row('steam-3')])
      expect(r).toEqual({ added: ['steam-3'], present: ['steam-2'] })
      expect(gh.dbFile(SHARD)).toBe(
        encodeGameDbCsv([
          row('steam-1'),
          row('steam-2', { title: 'Theirs' }),
          row('steam-3'),
          row('steam-4')
        ])
      )
      expect(gh.dbCalls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET', 'PUT', 'GET', 'PUT'])
      expect(waits).toHaveLength(2)
      expect(waits[1]).toBeGreaterThan(waits[0])
    }
  })

  it('creating a shard someone else just created is a stale write too', async () => {
    const { gh, ref } = setup()
    gh.staleStatus = 422
    gh.races = [(files) => files.set(SHARD, encodeGameDbCsv([row('steam-7')]))]
    expect(await appendRows(ref, SHARD, [row('steam-1')])).toEqual({
      added: ['steam-1'],
      present: []
    })
    expect(gh.dbFile(SHARD)).toBe(encodeGameDbCsv([row('steam-1'), row('steam-7')]))
  })

  it(`gives up after ${DB_WRITE_RETRIES} retries`, async () => {
    const { gh, ref } = setup()
    gh.dbFiles.set(SHARD, encodeGameDbCsv([row('steam-1')]))
    gh.races = Array.from(
      { length: 10 },
      (_, i) => (files: Map<string, string>) =>
        files.set(SHARD, encodeGameDbCsv([row('steam-1', { title: `Race ${i}` })]))
    )
    await expect(appendRows(ref, SHARD, [row('steam-2')])).rejects.toThrow(/409/)
    expect(gh.dbCalls.filter((c) => c.method === 'PUT')).toHaveLength(DB_WRITE_RETRIES + 1)
  })

  it('does not retry other errors', async () => {
    const { gh, ref } = setup()
    gh.failures = [{ method: 'PUT', path: '/contents/', status: 403 }]
    await expect(appendRows(ref, SHARD, [row('steam-2')])).rejects.toThrow(/403/)
    expect(gh.dbCalls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('reads a shard over 1 MB through the raw media type', async () => {
    const { gh, ref } = setup()
    gh.largeFiles = true
    const text = encodeGameDbCsv([row('steam-1')])
    gh.dbFiles.set(SHARD, text)
    expect((await readShard(ref, SHARD))?.text).toBe(text)
    expect(await appendRows(ref, SHARD, [row('steam-2')])).toEqual({
      added: ['steam-2'],
      present: []
    })
    expect(gh.dbFile(SHARD)).toBe(encodeGameDbCsv([row('steam-1'), row('steam-2')]))
  })

  it('reads a missing shard as an empty one', async () => {
    const { ref } = setup()
    expect(await readShard(ref, SHARD)).toBeNull()
  })
})

describe('groupByShard', () => {
  it('groups rows by their shard, shards in path order', () => {
    const rows = ['steam-1', 'gog-1', 'steam-2', 'steam-1000'].map((k) => row(k))
    const groups = groupByShard(rows, gameDbShardPath)
    expect(groups.map(([p]) => p)).toEqual([...groups.map(([p]) => p)].sort())
    expect(groups.flatMap(([, r]) => r.map((x) => x.key)).sort()).toEqual(
      rows.map((r) => r.key).sort()
    )
    for (const [path, list] of groups) {
      for (const r of list) expect(gameDbShardPath(r.key)).toBe(path)
    }
  })
})
