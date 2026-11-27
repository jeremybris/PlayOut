// The relay's copy of the PlayOut database format against the cases PlayOut's own copy is tested with
// (src/shared/game-database.relay-parity.test.ts): both must pass every case in fixtures/game-db-cases.json.
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
} from '../src/database-format'
import cases from './fixtures/game-db-cases.json'

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

const c = cases as unknown as Cases

describe('PlayOut database format (shared cases)', () => {
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
