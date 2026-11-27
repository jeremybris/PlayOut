/**
 * Helpers shared by the DuckStation and PCSX2 presets. Both emulators keep a pad's bindings in an INI section
 * (`[Pad1]`, `[Pad2]`, ...) as `Key = Device/Input` lines, and both read a key that is repeated as a list of bindings
 * (DuckStation's INISettingsInterface, PCSX2's multi-key CSimpleIniA), so a pad binding can be added next to the
 * keyboard one without losing it.
 */

/** One `key = value` line of a section body (comments and blank lines are not entries). */
export interface IniEntry {
  key: string
  value: string
}

/** A binding: the pad key (`Cross`) and its value (`SDL-0/A`). */
export type Binding = readonly [key: string, value: string]

/** A value bound to a game controller rather than the keyboard or mouse. */
const PAD_DEVICE = /^\s*(SDL|XInput|DInput)-/i

function entryOf(line: string): IniEntry | null {
  const t = line.trim()
  if (t === '' || t.startsWith(';') || t.startsWith('#')) return null
  const eq = t.indexOf('=')
  if (eq < 0) return null
  return { key: t.slice(0, eq).trim(), value: t.slice(eq + 1).trim() }
}

/** The `key = value` entries of a section body, in file order. */
export function parseEntries(lines: string[]): IniEntry[] {
  const out: IniEntry[] = []
  for (const line of lines) {
    const e = entryOf(line)
    if (e) out.push(e)
  }
  return out
}

/** The first value of `key` (case-insensitive), or undefined. */
export function entryValue(lines: string[] | null, key: string): string | undefined {
  if (!lines) return undefined
  const k = key.toLowerCase()
  return parseEntries(lines).find((e) => e.key.toLowerCase() === k)?.value
}

/** Whether a boolean setting is explicitly turned off (`false`, `0`). */
export function isFalse(value: string | undefined): boolean {
  return value !== undefined && /^(false|0)$/i.test(value)
}

/** A binding template with its device index replaced: `SDL-0/A` -> `SDL-<index>/A`. */
export function forDevice(template: readonly Binding[], index: number): Binding[] {
  return template.map(([k, v]) => [k, v.replace(/^SDL-\d+\//, `SDL-${index}/`)] as const)
}

/** `Key = Value` lines. */
export function bindingLines(bindings: readonly Binding[]): string[] {
  return bindings.map(([k, v]) => `${k} = ${v}`)
}

/** A sorted, case-folded fingerprint of a multiset of bindings (order and spacing do not matter). */
function fingerprint(entries: readonly Binding[]): string {
  return entries
    .map(([k, v]) => `${k.toLowerCase()}=${v.toLowerCase()}`)
    .sort()
    .join('\n')
}

export interface PadDefaults {
  /** The emulator's default controller type for this port (`AnalogController`, `DualShock2`). */
  type: string
  /** Every binding key the controller type has; other keys in the section are settings, not mappings. */
  bindingKeys: readonly string[]
  /** The bindings the emulator writes by default for this port (the keyboard set for port 1, none for port 2). */
  defaults: readonly Binding[]
}

/**
 * Whether a pad section is missing or still exactly the emulator's own default mapping: its Type is missing or the
 * default type, nothing in it is bound to a game controller, and its bindings (compared as a multiset, ignoring order,
 * case and spacing) are the default ones. Non-binding settings (dead zones, vibration scale, ...) are ignored, since
 * they are kept as they are.
 */
export function isUntouchedPad(lines: string[] | null, pad: PadDefaults): boolean {
  if (lines === null) return true
  const entries = parseEntries(lines)
  const type = entries.find((e) => e.key.toLowerCase() === 'type')?.value
  if (type !== undefined && type.toLowerCase() !== pad.type.toLowerCase()) return false
  if (entries.some((e) => PAD_DEVICE.test(e.value))) return false
  const keys = new Set(pad.bindingKeys.map((k) => k.toLowerCase()))
  const bound = entries
    .filter((e) => keys.has(e.key.toLowerCase()) && e.value !== '')
    .map((e) => [e.key, e.value] as const)
  return fingerprint(bound) === fingerprint(pad.defaults)
}

/**
 * Whether a pad section is missing or an unused port at its default (`Type = None` or no Type, and no bindings): the
 * port the presets may turn into player 2.
 */
export function isUnusedPad(lines: string[] | null, bindingKeys: readonly string[]): boolean {
  if (lines === null) return true
  const entries = parseEntries(lines)
  const type = entries.find((e) => e.key.toLowerCase() === 'type')?.value
  if (type !== undefined && type.toLowerCase() !== 'none') return false
  const keys = new Set(bindingKeys.map((k) => k.toLowerCase()))
  return !entries.some(
    (e) => (keys.has(e.key.toLowerCase()) && e.value !== '') || PAD_DEVICE.test(e.value)
  )
}

/** Index after the last non-blank line, so trailing blank lines stay at the end of the section. */
function endOfContent(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() !== '') return i + 1
  return 0
}

/**
 * Adds binding lines to a section body: each one goes right after the last line of the same key (so `Up = Keyboard/Up`
 * is followed by `Up = SDL-0/DPadUp`), or at the end of the section when the key has no line yet. Lines already present
 * (same key and value) are not added twice. Every existing line is kept.
 */
export function addBindings(lines: string[], bindings: readonly Binding[]): string[] {
  const out = [...lines]
  for (const [key, value] of bindings) {
    const k = key.toLowerCase()
    let last = -1
    let present = false
    out.forEach((line, i) => {
      const e = entryOf(line)
      if (!e || e.key.toLowerCase() !== k) return
      last = i
      if (e.value.toLowerCase() === value.toLowerCase()) present = true
    })
    if (present) continue
    out.splice(last >= 0 ? last + 1 : endOfContent(out), 0, `${key} = ${value}`)
  }
  return out
}

/**
 * Sets `Type = <type>` in a section body: replaces the first Type line, or puts one first. Other lines are kept.
 */
export function setType(lines: string[], type: string): string[] {
  const out = [...lines]
  const i = out.findIndex((line) => entryOf(line)?.key.toLowerCase() === 'type')
  if (i >= 0) out[i] = `Type = ${type}`
  else out.unshift(`Type = ${type}`)
  return out
}
