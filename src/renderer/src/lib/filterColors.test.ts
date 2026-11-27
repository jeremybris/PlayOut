import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { LOCAL_LENGTH_CHOICES, LAN_PARTY, PLAYER_BANDS } from './localMultiplayer'
import { CONTROLS_FILTERS } from './controls'
import {
  allFilterColors,
  CONTROLS_COLORS,
  GENRE_COLORS,
  LOCAL_COLORS,
  ONLINE_COLORS
} from './filterColors'

const here = __dirname

describe('Filters icon colours', () => {
  it('never uses one colour twice, nor the colours Filters already has', () => {
    const colors = allFilterColors().map((c) => c.toLowerCase())
    expect(new Set(colors).size).toBe(colors.length)
    // Favorites' red and Recompilations' blue (tokens.css)
    for (const taken of ['#ff4d5e', '#3a96ff']) expect(colors).not.toContain(taken)
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('is light enough to read on the dark menu', () => {
    for (const c of allFilterColors()) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
      expect(0.2126 * r! + 0.7152 * g! + 0.0722 * b!, c).toBeGreaterThan(0.3)
    }
  })

  it('gives every genre drawn in the text colour a colour (line icons and black pictures)', () => {
    const source = readFileSync(join(here, '../components/GenreIcon.tsx'), 'utf8')
    const block = source.slice(
      source.indexOf('const ICONS'),
      source.indexOf('}', source.indexOf('const ICONS'))
    )
    const ids = [...block.matchAll(/^\s+(?:'([^']+)'|([a-z]+)):/gm)].map((m) => m[1] ?? m[2])
    expect(ids.length).toBeGreaterThan(50)
    for (const id of ids) expect(GENRE_COLORS[id!], id).toBeDefined()
    const masks = readdirSync(join(here, '../assets/genre-icons'))
      .filter((f) => f.endsWith('.mask.png'))
      .map((f) => f.slice(0, -'.mask.png'.length))
    const slugs = new Set(Object.keys(GENRE_COLORS).map((id) => id.replace(/[^a-z0-9]+/g, '-')))
    for (const slug of masks) expect(slugs.has(slug), slug).toBe(true)
  })

  it('colours every Local Multiplayer, Online Multiplayer and Controls choice', () => {
    for (const c of [...LOCAL_LENGTH_CHOICES, LAN_PARTY, ...PLAYER_BANDS])
      expect(LOCAL_COLORS[c.id], c.id).toBeDefined()
    expect(LOCAL_COLORS['nucleus-coop']).toBeDefined()
    for (const c of CONTROLS_FILTERS) expect(CONTROLS_COLORS[c.id], c.id).toBeDefined()
    expect(Object.keys(ONLINE_COLORS).sort()).toEqual(
      ['coop', 'esports', 'mmo', 'pvp', 'team', 'versus'].sort()
    )
  })
})
