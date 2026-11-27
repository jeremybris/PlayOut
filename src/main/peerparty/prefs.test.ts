import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensurePortablePrefs } from './prefs'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const dirs: string[] = []
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'playout-peerparty-'))
  dirs.push(d)
  return join(d, 'peerparty-data')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const read = (dir: string): unknown => JSON.parse(readFileSync(join(dir, 'ui.json'), 'utf8'))

describe('ensurePortablePrefs', () => {
  it('makes the data folder and writes only the Home button setting when there is no ui.json', async () => {
    const dir = scratch()
    expect(await ensurePortablePrefs(dir, log)).toBe(true)
    expect(read(dir)).toEqual({ prefs: { hotkeys: { guide: false } } })
    expect(readdirSync(dir)).toEqual(['ui.json'])
  })

  it('turns the Home button off and keeps every other setting', async () => {
    const dir = scratch()
    await ensurePortablePrefs(dir, log)
    writeFileSync(
      join(dir, 'ui.json'),
      JSON.stringify({
        ui_version: 3,
        games: { a: { overlay: true } },
        prefs: { name: 'Jo', hotkeys: { guide: true, shift_tab: false, chord: 5 } }
      })
    )
    expect(await ensurePortablePrefs(dir, log)).toBe(true)
    expect(read(dir)).toEqual({
      ui_version: 3,
      games: { a: { overlay: true } },
      prefs: { name: 'Jo', hotkeys: { guide: false, shift_tab: false, chord: 5 } }
    })
    // Already off: nothing is written.
    expect(await ensurePortablePrefs(dir, log)).toBe(false)
  })

  it('leaves a file it cannot read as settings alone', async () => {
    const dir = scratch()
    await ensurePortablePrefs(dir, log)
    writeFileSync(join(dir, 'ui.json'), '{ broken')
    expect(await ensurePortablePrefs(dir, log)).toBe(false)
    writeFileSync(join(dir, 'ui.json'), '[1]')
    expect(await ensurePortablePrefs(dir, log)).toBe(false)
    expect(readFileSync(join(dir, 'ui.json'), 'utf8')).toBe('[1]')
  })
})
