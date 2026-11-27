import {
  Box,
  Cpu,
  Disc,
  Gamepad,
  Gamepad2,
  HardDrive,
  Joystick,
  Laptop,
  Monitor,
  Tv,
  type LucideIcon
} from 'lucide-react'
import {
  siAtari,
  siBattledotnet,
  siCommodore,
  siDolphin,
  siEa,
  siEpicgames,
  siGamejolt,
  siGogdotcom,
  siHumblebundle,
  siItchdotio,
  siLegacygames,
  siNec,
  siNvidia,
  siOrigin,
  siPlaystation,
  siPlaystation2,
  siPlaystation3,
  siPlaystation4,
  siPlaystation5,
  siPlaystationportable,
  siPlaystationvita,
  siRetroachievements,
  siRetroarch,
  siRockstargames,
  siSega,
  siSteam,
  siUbisoft
} from 'simple-icons'

/**
 * Platform badge resolution: maps a Platform.icon slug (simple-icons slug or lucide name) to a drawable
 * glyph and a background colour. <PlatformBadge> renders the result.
 */

interface SimpleGlyph {
  path: string
  hex: string
  title: string
}

/** simple-icons slugs that exist in the installed package (16.x); every entry was verified. */
const SIMPLE_ICONS: Record<string, SimpleGlyph> = {
  steam: siSteam,
  epicgames: siEpicgames,
  gogdotcom: siGogdotcom,
  ea: siEa,
  battledotnet: siBattledotnet,
  ubisoft: siUbisoft,
  playstation: siPlaystation,
  playstation2: siPlaystation2,
  playstation3: siPlaystation3,
  playstation4: siPlaystation4,
  playstation5: siPlaystation5,
  playstationvita: siPlaystationvita,
  playstationportable: siPlaystationportable,
  sega: siSega,
  atari: siAtari,
  commodore: siCommodore,
  retroarch: siRetroarch,
  nec: siNec,
  dolphin: siDolphin,
  retroachievements: siRetroachievements,
  itchdotio: siItchdotio,
  humblebundle: siHumblebundle,
  rockstargames: siRockstargames,
  origin: siOrigin,
  legacygames: siLegacygames,
  gamejolt: siGamejolt,
  nvidia: siNvidia
}

/** lucide names accepted as Platform.icon (kebab-case, as lucide documents them). */
const LUCIDE_ICONS: Record<string, LucideIcon> = {
  'gamepad-2': Gamepad2,
  gamepad: Gamepad,
  monitor: Monitor,
  disc: Disc,
  joystick: Joystick,
  tv: Tv,
  cpu: Cpu,
  'hard-drive': HardDrive,
  laptop: Laptop,
  box: Box
}

/** Slugs that stand for brands with no simple-icons glyph; drawn with our own generic marks. */
const XBOX_SLUGS = new Set(['xbox', 'microsoft', 'microsoftstore', 'windows', 'windows11'])
const NINTENDO_PREFIXES = [
  'nintendo',
  'nes',
  'snes',
  'n64',
  'gc',
  'gamecube',
  'wii',
  'switch',
  'gb',
  'gba',
  'gbc',
  'ds',
  '3ds',
  'nds'
]

export type BadgeGlyph =
  | { kind: 'simple'; path: string; hex: string; title: string }
  | { kind: 'lucide'; Icon: LucideIcon }
  | { kind: 'xbox' }
  | { kind: 'nintendo' }
  | { kind: 'letter'; letter: string }

/** Resolve a Platform.icon slug (or lucide name) to something drawable; `name` feeds the letter fallback. */
export function badgeGlyph(icon: string | undefined, name?: string): BadgeGlyph {
  const slug = (icon ?? '').trim().toLowerCase()
  if (slug) {
    const simple = SIMPLE_ICONS[slug]
    if (simple) return { kind: 'simple', path: simple.path, hex: simple.hex, title: simple.title }
    if (XBOX_SLUGS.has(slug)) return { kind: 'xbox' }
    if (NINTENDO_PREFIXES.some((p) => slug === p || slug.startsWith('nintendo'))) {
      return { kind: 'nintendo' }
    }
    const lucide = LUCIDE_ICONS[slug]
    if (lucide) return { kind: 'lucide', Icon: lucide }
  }
  const letter = (name ?? slug).trim().charAt(0).toUpperCase()
  return letter ? { kind: 'letter', letter } : { kind: 'lucide', Icon: Gamepad2 }
}

/** CSS background for a badge: the --badge-<slug> token when defined, else the brand hex, else the control colour. */
export function badgeColor(icon: string | undefined, glyph: BadgeGlyph): string {
  const slug = (icon ?? '').trim().toLowerCase()
  const fallback = glyph.kind === 'simple' ? `#${glyph.hex}` : 'var(--badge-manual)'
  if (glyph.kind === 'xbox') return 'var(--badge-xbox)'
  if (glyph.kind === 'nintendo') return 'var(--badge-nintendo)'
  if (!slug) return fallback
  return `var(--badge-${slug.replace(/[^a-z0-9-]/g, '')}, ${fallback})`
}
