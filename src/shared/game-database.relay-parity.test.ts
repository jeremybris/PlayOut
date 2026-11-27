// PlayOut's copy of the database format against the cases the relay's copy (metadata-relay/src/database-format.ts)
// is tested with: both must pass every case in metadata-relay/test/fixtures/game-db-cases.json, so the relay accepts
// exactly the rows PlayOut makes and writes the CSV PlayOut reads. The relay's code is never imported here.
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import {
  GAME_DB_COLUMNS,
  GAME_DB_MAX_ROWS_PER_REQUEST,
  GAME_DB_SHARDS,
  encodeGameDbCsv,
  fnv1a,
  gameDbRowProblem,
  gameDbShardPath,
  parseGameDbCsv,
  type GameDbRow
} from './game-database'

interface Cases {
  maxRowsPerRequest: number
  shardCount: number
  columns: string[]
  accepted: GameDbRow[]
  refused: { row: GameDbRow; error: string }[]
  encode: { rows: GameDbRow[]; csv: string }[]
  parse: { name: string; csv: string; rows: GameDbRow[] }[]
  shards: { key: string; path: string }[]
  fnv1a: { text: string; hash: number }[]
}

const CASES = resolve(__dirname, '../../metadata-relay/test/fixtures/game-db-cases.json')
const c = JSON.parse(readFileSync(CASES, 'utf8')) as Cases

describe('PlayOut database format (cases shared with the relay)', () => {
  it('has the same columns and limits', () => {
    expect([...GAME_DB_COLUMNS]).toEqual(c.columns)
    expect(GAME_DB_MAX_ROWS_PER_REQUEST).toBe(c.maxRowsPerRequest)
    expect(GAME_DB_SHARDS).toBe(c.shardCount)
  })

  it.each(c.accepted.map((row) => [row.key, row] as const))('accepts %s', (_key, row) => {
    expect(gameDbRowProblem(row)).toBeNull()
  })

  it.each(c.refused.map((x, i) => [i, x.error, x.row] as const))(
    'refuses case %i (%s)',
    (_i, error, row) => {
      expect(gameDbRowProblem(row)).toContain(error)
    }
  )

  it('writes the same CSV', () => {
    for (const x of c.encode) expect(encodeGameDbCsv(x.rows)).toBe(x.csv)
  })

  it.each(c.parse.map((x) => [x.name, x] as const))('reads: %s', (_name, x) => {
    expect([...parseGameDbCsv(x.csv).values()]).toEqual(x.rows)
  })

  it('reads back every accepted row unchanged', () => {
    const back = parseGameDbCsv(encodeGameDbCsv(c.accepted))
    for (const row of c.accepted) expect(back.get(row.key)).toEqual(row)
  })

  it('puts a key in the same shard', () => {
    for (const x of c.fnv1a) expect(fnv1a(x.text)).toBe(x.hash)
    for (const x of c.shards) expect(gameDbShardPath(x.key)).toBe(x.path)
  })
})
