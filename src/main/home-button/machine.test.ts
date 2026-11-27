import { readdirSync } from 'fs'
import { win32 } from 'path'
import { describe, expect, it } from 'vitest'
import { GAME_BAR_KEY, GAME_BAR_VALUES } from './game-bar'
import { createRealIo, regQuery, runningProcesses } from './io'
import { STEAM_GUIDE_KEY } from './steam-guide'
import { decodeVdf, encodeVdf, findVdfKey, removeVdfKey, setVdfKey } from './steam-vdf'
import { detectWinhanced } from './winhanced'

/**
 * Read-only checks against this PC: the real reg.exe and tasklist.exe output parses, and an edit of the real Steam
 * files (in memory only, never written) touches nothing but the key. Nothing here changes Windows or Steam.
 */
const onWindows = process.platform === 'win32'

describe.skipIf(!onWindows)('home button on this machine (read-only)', () => {
  const io = createRealIo()

  it('reads the Game Bar values through reg.exe', async () => {
    for (const name of GAME_BAR_VALUES) {
      const v = await regQuery(io.run, GAME_BAR_KEY, name)
      if (v) expect(typeof v.data).toBe('number')
    }
    expect(await regQuery(io.run, GAME_BAR_KEY, 'PlayOutNoSuchValue')).toBeNull()
    expect(await regQuery(io.run, 'HKCU\\Software\\PlayOutNoSuchKey', 'x')).toBeNull()
  })

  it('lists running programs through tasklist.exe', async () => {
    const running = await runningProcesses(io.run, ['explorer.exe', 'playout-no-such.exe'])
    expect(running).not.toContain('playout-no-such.exe')
  })

  it('reads Winhanced when it runs', async () => {
    const w = await detectWinhanced(io)
    if (w) expect(typeof w.startSelectOpensGameBar).toBe('boolean')
  })

  it('edits the real Steam files in memory without touching anything else', async () => {
    const path = await regQuery(io.run, 'HKCU\\Software\\Valve\\Steam', 'SteamPath')
    if (!path || typeof path.data !== 'string') return
    const steam = win32.normalize(path.data.replace(/\//g, '\\'))
    const files = [win32.join(steam, 'config', 'config.vdf')]
    try {
      for (const id of readdirSync(win32.join(steam, 'userdata'))) {
        files.push(win32.join(steam, 'userdata', id, 'config', 'localconfig.vdf'))
      }
    } catch {
      /* no userdata */
    }
    for (const file of files) {
      const data = await io.readFile(file)
      if (!data) continue
      const { text, bom } = decodeVdf(data)
      const block = /localconfig/i.test(file)
        ? ['UserLocalConfigStore']
        : ['InstallConfigStore', 'Software', 'Valve', 'Steam']
      const before = findVdfKey(text, STEAM_GUIDE_KEY)
      const edited = setVdfKey(text, STEAM_GUIDE_KEY, '0', block)
      expect(findVdfKey(edited.text, STEAM_GUIDE_KEY).every((e) => e.value === '0')).toBe(true)
      if (before.length === 0) {
        // Absent: adding then removing gives the exact bytes back.
        expect(encodeVdf(removeVdfKey(edited.text, STEAM_GUIDE_KEY).text, bom).equals(data)).toBe(
          true
        )
      } else {
        const back = setVdfKey(edited.text, STEAM_GUIDE_KEY, before[0].value, block).text
        expect(encodeVdf(back, bom).equals(data)).toBe(
          before.every((e) => e.value === before[0].value)
        )
      }
    }
  })
})
