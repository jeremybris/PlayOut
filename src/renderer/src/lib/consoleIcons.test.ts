import { readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { consoleIcon } from './consoleIcons'
import iconBySystem from './console-icons.json'

/** Filters > Platform's console pictures (scripts/build-console-icons.ps1). */
describe('consoleIcon', () => {
  it('has a picture file for every system the map names', () => {
    const files = new Set(
      readdirSync(join(__dirname, '../assets/console-icons')).map((f) => f.replace(/\.png$/, ''))
    )
    for (const [system, slug] of Object.entries(iconBySystem as Record<string, string>)) {
      expect(files.has(slug), `${system} -> ${slug}`).toBe(true)
      expect(consoleIcon(system), system).toBeTruthy()
    }
  })

  it('gives regional twins the same picture, and none to a system without one', () => {
    expect(consoleIcon('megadrivejp')).toBe(consoleIcon('genesis'))
    expect(consoleIcon('sfc')).toBe(consoleIcon('snes'))
    expect(consoleIcon('ps4')).toBeTruthy()
    expect(consoleIcon('switch2')).not.toBe(consoleIcon('switch'))
    expect(consoleIcon('androidgames')).toBe(consoleIcon('android'))
    expect(consoleIcon('pc98')).toBeUndefined()
    expect(consoleIcon(undefined)).toBeUndefined()
  })
})
