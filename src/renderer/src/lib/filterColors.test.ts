import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { LOCAL_LENGTH_CHOICES, LAN_PARTY, PLAYER_BANDS } from './localMultiplayer'
import { CONTROLS_FILTERS } from './controls'
import { CUSTOM_FILTER_ICONS } from '@shared/custom-filters'
import {
  allFilterColors,
  CONTROLS_COLORS,
  CUSTOM_FILTER_COLORS,
  GENRE_COLORS,
  LOCAL_COLORS,
  MIN_CUSTOM_COLOR_DISTANCE,
  ONLINE_COLORS
} from './filterColors'

const here = __dirname

/** A colour in CIELAB (sRGB, D65). */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047)
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b)
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** CIE76 Delta E: how far apart two colours look. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a)
  const [l2, a2, b2] = lab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

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

  it('colours every custom filter icon, each its own, none of the other Filters colours', () => {
    expect(Object.keys(CUSTOM_FILTER_COLORS).sort()).toEqual([...CUSTOM_FILTER_ICONS].sort())
    const others = allFilterColors().filter((c) => !Object.values(CUSTOM_FILTER_COLORS).includes(c))
    for (const c of Object.values(CUSTOM_FILTER_COLORS)) expect(others).not.toContain(c)
    expect(new Set(Object.values(CUSTOM_FILTER_COLORS)).size).toBe(CUSTOM_FILTER_ICONS.length)
  })

  it("keeps the custom filter icons' colours far enough apart that no two look alike", () => {
    const entries = Object.entries(CUSTOM_FILTER_COLORS)
    const close: string[] = []
    for (let i = 0; i < entries.length; i++)
      for (let j = i + 1; j < entries.length; j++) {
        const [a, ca] = entries[i]!
        const [b, cb] = entries[j]!
        if (deltaE(ca, cb) < MIN_CUSTOM_COLOR_DISTANCE) close.push(`${a}/${b}`)
      }
    expect(close).toEqual([])
  })
})
