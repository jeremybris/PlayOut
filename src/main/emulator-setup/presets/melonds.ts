import { promises as fs } from 'fs'
import { join } from 'path'
import type { ApplyPresets } from './types'

/**
 * melonDS 1.1 (portable: `<E>\melonDS.toml`).
 *
 * Fullscreen: melonDS has no fullscreen setting; only the `-f` / `--fullscreen` flag starts it fullscreen, and
 * PlayOut's launch command already passes it (`%EMULATOR_MELONDS% -f %ROM%`, as ES-DE does). Nothing is written.
 *
 * Controller: melonDS reads the SDL raw joystick picked by `[Instance0] JoystickID` (0 = the first one) with the
 * integer bindings of `[Instance0.Joystick]` (-1 = unbound, every key's default). On Windows SDL drives an Xbox pad
 * through XInput/RAWINPUT: buttons 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 Back, 7 Start, hat 0 the D-pad, axes 0/1 the
 * left stick. The positional Nintendo layout (DS A = Xbox B) is written as melonDS's own mapping dialog stores it,
 * with the D-pad on hat 0 combined with the left stick. The keyboard table and every HK_* hotkey stay as they are.
 * Written only when all 12 button keys are absent or -1 (melonDS saves every key, -1 when unbound, on exit), so a
 * mapping the user made is kept. An existing JoystickID is kept.
 */

/**
 * `[Instance0.Joystick]` values. A hat binding is 0x100 | hat << 4 | direction (1 up, 2 right, 4 down, 8 left); an
 * axis adds 0x10000 | type << 20 | axis << 24 (type 0 positive, 1 negative) in the upper half.
 */
export const MELONDS_JOYSTICK: Record<string, number> = {
  A: 1,
  B: 0,
  X: 3,
  Y: 2,
  L: 4,
  R: 5,
  Select: 6,
  Start: 7,
  Up: 0x101 | (0x10000 | (1 << 20) | (1 << 24)),
  Down: 0x104 | (0x10000 | (0 << 20) | (1 << 24)),
  Left: 0x108 | (0x10000 | (1 << 20) | (0 << 24)),
  Right: 0x102 | (0x10000 | (0 << 20) | (0 << 24))
}

const TABLE = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/
const ANY_TABLE = /^\s*\[/

/** The bare or quoted key of a `key = value` TOML line, or null. */
function tomlKey(line: string): string | null {
  const m = /^\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*=/.exec(line)
  if (!m) return null
  const k = m[1]
  return k.startsWith('"') || k.startsWith("'") ? k.slice(1, -1) : k
}

/** Body range [start, end) of `[table]`, or null. */
function tableRange(lines: string[], table: string): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = TABLE.exec(lines[i])
    if (!m || m[1].trim() !== table) continue
    let end = i + 1
    while (end < lines.length && !ANY_TABLE.test(lines[end])) end++
    return { start: i + 1, end }
  }
  return null
}

/** The raw value text of `key` in `[table]`, or undefined. */
function tomlRaw(lines: string[], table: string, key: string): string | undefined {
  const r = tableRange(lines, table)
  if (!r) return undefined
  for (let i = r.start; i < r.end; i++) {
    if (tomlKey(lines[i]) !== key) continue
    return lines[i]
      .slice(lines[i].indexOf('=') + 1)
      .replace(/#.*$/, '')
      .trim()
  }
  return undefined
}

/**
 * Sets integer keys of `[table]` (ini.ts's setTomlValues writes strings only, and melonDS reads these as integers),
 * replacing an existing line or adding it after the table's last non-blank line, or appending the table.
 */
function setTomlInts(lines: string[], table: string, values: Record<string, number>): void {
  const missing: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const line = `${key} = ${value}`
    const r = tableRange(lines, table)
    if (!r) {
      missing.push(line)
      continue
    }
    const i = lines.slice(r.start, r.end).findIndex((l) => tomlKey(l) === key)
    if (i >= 0) {
      lines[r.start + i] = line
      continue
    }
    let at = r.end
    while (at > r.start && lines[at - 1].trim() === '') at--
    lines.splice(at, 0, line)
  }
  if (missing.length === 0) return
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
  lines.push(`[${table}]`, ...missing)
}

/** Whether `[Instance0.Joystick]` binds no DS button yet (each key absent or -1). */
export function joystickUnmapped(lines: string[]): boolean {
  return Object.keys(MELONDS_JOYSTICK).every((key) => {
    const raw = tomlRaw(lines, 'Instance0.Joystick', key)
    return raw === undefined || Number(raw) === -1
  })
}

export const applyPresets: ApplyPresets = async (ctx) => {
  const file = join(ctx.emuDir, 'melonDS.toml')
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)

  if (!joystickUnmapped(lines)) return
  if (tomlRaw(lines, 'Instance0', 'JoystickID') === undefined) {
    setTomlInts(lines, 'Instance0', { JoystickID: 0 })
  }
  setTomlInts(lines, 'Instance0.Joystick', MELONDS_JOYSTICK)
  const out = lines.join(eol) + eol
  if (out === text) return
  await fs.mkdir(ctx.emuDir, { recursive: true })
  await fs.writeFile(file, out, 'utf8')
}
