import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ANTI_CHEAT } from '../overlay-logic'

/**
 * The injector's anti-cheat names (ingame-helper/common/anticheat_names.json, compiled into PlayOutIngame64.exe) must
 * cover every anti-cheat program PlayOut itself knows (overlay-logic.ts ANTI_CHEAT), so the helper never injects into
 * a game PlayOut would have refused to pause.
 */
const names = JSON.parse(
  readFileSync(join(__dirname, '../../../../ingame-helper/common/anticheat_names.json'), 'utf8')
) as { drivers: string[]; modules: string[]; processes: string[] }

const matches = (patterns: string[], name: string): boolean =>
  patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p))

describe('anticheat_names.json', () => {
  it('lists every anti-cheat program PlayOut knows', () => {
    for (const image of ANTI_CHEAT) expect(matches(names.processes, image), image).toBe(true)
  })

  it('has lower-case names and common kernel drivers', () => {
    for (const list of [names.drivers, names.modules, names.processes])
      for (const n of list) expect(n).toBe(n.toLowerCase())
    for (const driver of ['easyanticheat.sys', 'bedaisy.sys', 'vgk.sys'])
      expect(matches(names.drivers, driver), driver).toBe(true)
  })
})
