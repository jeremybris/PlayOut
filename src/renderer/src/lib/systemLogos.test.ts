import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import logoBySystem from './system-logos.json'
import { systemLogo } from './systemLogos'

describe('system logos', () => {
  it('ships a logo for every system it maps, and only known systems', () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, '../../../../resources/systems/systems.json'), 'utf8')
    ) as { id: string }[] | { systems: { id: string }[] }
    const known = new Set((Array.isArray(raw) ? raw : raw.systems).map((s) => s.id))
    for (const id of Object.keys(logoBySystem)) {
      expect(known.has(id), id).toBe(true)
      expect(systemLogo(id), id).toBeTruthy()
    }
  })

  it('has none for stores or systems without a logo', () => {
    expect(systemLogo('steam')).toBeUndefined()
    expect(systemLogo('pc')).toBeUndefined()
    // Close substitutes the user turned down: these keep the round badge.
    for (const id of ['apple2gs', 'arcade', 'windows9x', 'naomigd'])
      expect(systemLogo(id), id).toBeUndefined()
    expect(systemLogo(undefined)).toBeUndefined()
    expect(systemLogo('ps2')).toBeTruthy()
  })
})
