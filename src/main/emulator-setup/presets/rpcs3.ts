import { promises as fs } from 'fs'
import { join } from 'path'
import { setIniValues } from '../ini'
import { BIG_PICTURE_VERSION, newSince } from './big-picture'
import { readLines } from './keys'
import type { ApplyPresets } from './types'

/**
 * RPCS3 presets (docs/emulator-setup.md, "Fullscreen and controllers").
 *
 * - Controllers: `E\config\input_configs\global\Default.yml` binds players 1-4 to the XInput handler's statically named
 *   devices "XInput Pad #1".."#4" (hot-plug safe, unlike SDL names). Only the Handler and Device keys are written:
 *   RPCS3 restores the handler's defaults before loading the file, so every left-out key keeps the native XInput
 *   mapping (the same mapping the Pad Settings dialog writes). RPCS3 never writes this file itself, so an existing
 *   one means the user set up pads and it is left alone. Without it RPCS3 puts the keyboard on player 1.
 * - Fullscreen: "Start games in fullscreen mode" already defaults to true, so config.yml is never created for it; an
 *   existing file where it is false is switched on, only the first time.
 * - The Welcome dialog is queued even for `--no-gui` launches and quits the emulator when closed, so it would block
 *   every fullscreen game PlayOut starts: it is switched off.
 * - Big Picture (big-picture.ts): "Start Big Picture Mode on boot" is switched on once (it only applies when RPCS3 is
 *   opened without a game), and the PS button, which opens RPCS3's Home menu in game, is Start + Select for players
 *   1-4 instead of RPCS3's "Guide, or Start + Back": Guide is PlayOut's home button. RPCS3 restores the handler's
 *   defaults before loading Default.yml, so a `Config:` with only the PS Button keeps every other button's mapping.
 */

const PLAYERS = 4

/**
 * The PS button (RPCS3's Home menu in game): Start + Select only. RPCS3's XInput default is "Guide, or Start + Back"
 * (xinput_pad_handler.cpp), and Guide is PlayOut's home button. A combo joins buttons with '&', alternatives with ','.
 */
export const PS_BUTTON = 'Start&Back'

/** The Default.yml PlayOut writes (LF, the Device value quoted: an unquoted ` #1` would be a YAML comment). */
export function rpcs3InputConfig(): string {
  const lines: string[] = []
  for (let p = 1; p <= PLAYERS; p++) {
    lines.push(
      `Player ${p} Input:`,
      '  Handler: XInput',
      `  Device: "XInput Pad #${p}"`,
      '  Config:',
      `    PS Button: ${PS_BUTTON}`
    )
  }
  return lines.join('\n') + '\n'
}

/** The Default.yml PlayOut wrote before the Start + Select menu (presets version 1). */
function legacyInputConfig(): string {
  const lines: string[] = []
  for (let p = 1; p <= PLAYERS; p++) {
    lines.push(`Player ${p} Input:`, '  Handler: XInput', `  Device: "XInput Pad #${p}"`)
  }
  return lines.join('\n') + '\n'
}

/** A button string as RPCS3 reads it: a set of combos, each a set of buttons. */
function combos(value: string): string {
  return value
    .replace(/^(["'])(.*)\1$/, '$2')
    .split(',')
    .map((c) =>
      c
        .split('&')
        .map((b) => b.trim())
        .filter(Boolean)
        .sort()
        .join('&')
    )
    .filter(Boolean)
    .sort()
    .join(',')
}

/** RPCS3's own XInput PS button, in any order RPCS3 may have written it. */
const DEFAULT_PS = combos('Guide,Start&Back')

/**
 * Moves every PS button still at RPCS3's XInput default to Start + Select (a Default.yml the Pad Settings dialog
 * wrote). A PS button the user changed stays. Returns the new text, or null when nothing changed.
 */
export function freeGuideFromPsButton(text: string): string | null {
  let changed = false
  const next = text.replace(
    /^([ \t]*PS Button:[ \t]*)(.*?)([ \t]*)$/gm,
    (line, head, value, tail) => {
      if (combos(value) !== DEFAULT_PS) return line
      changed = true
      return `${head}${PS_BUTTON}${tail}`
    }
  )
  return changed ? next : null
}

/**
 * Turns on "Start Big Picture Mode on boot" in config.yml (in `Miscellaneous:`), creating the file when RPCS3 never
 * wrote one: RPCS3 fills every missing key with its default. Returns the new text, or null when it was already on.
 */
export function withBigPicture(text: string | null): string | null {
  const key = 'Start Big Picture Mode on boot'
  if (text === null) return `Miscellaneous:\n  ${key}: true\n`
  const re = new RegExp(`^([ \\t]*)${key}:[ \\t]*(\\S*)[ \\t]*$`, 'm')
  const m = re.exec(text)
  if (m) return m[2] === 'true' ? null : text.replace(re, `$1${key}: true`)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const section = /^Miscellaneous:[ \t]*(?=\r?$)/m.exec(text)
  if (!section)
    return `${text}${text.endsWith('\n') || text === '' ? '' : eol}Miscellaneous:${eol}  ${key}: true${eol}`
  const after = section.index + section[0].length
  const indent = /^\r?\n([ \t]+)\S/.exec(text.slice(after))?.[1] ?? '  '
  return `${text.slice(0, after)}${eol}${indent}${key}: true${text.slice(after)}`
}

/**
 * The profile active_input_configurations.yml selects for 'global', or null when the file or the entry is missing
 * or empty (RPCS3 then falls back to Default).
 */
async function activeGlobalProfile(file: string): Promise<string | null> {
  const lines = await readLines(file)
  if (!lines) return null
  for (const line of lines) {
    const m = /^\s+global:\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const value = m[1].replace(/^(["'])(.*)\1$/, '$2').trim()
    return value || null
  }
  return null
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export const applyPresets: ApplyPresets = async (ctx) => {
  const { emuDir: E, log } = ctx
  const configDir = join(E, 'config')

  // Controllers: only when no pad configuration exists yet.
  const inputDir = join(configDir, 'input_configs')
  const profile = await activeGlobalProfile(join(inputDir, 'active_input_configurations.yml'))
  const defaultYml = join(inputDir, 'global', 'Default.yml')
  if (profile && profile.toLowerCase() !== 'default') {
    log.info(`RPCS3 uses the input profile "${profile}"; controllers left as they are`)
  } else if (await exists(defaultYml)) {
    if (newSince(ctx, BIG_PICTURE_VERSION)) {
      // Once: the Home menu moves from Guide (PlayOut's home button) to Start + Select, in the file PlayOut wrote
      // before, or wherever the PS button is still RPCS3's default.
      const text = await fs.readFile(defaultYml, 'utf8')
      const next =
        text.replace(/\r\n/g, '\n') === legacyInputConfig()
          ? rpcs3InputConfig()
          : freeGuideFromPsButton(text)
      if (next !== null && next !== text) {
        await fs.writeFile(defaultYml, next, 'utf8')
        log.info('RPCS3: Start + Select opens the Home menu')
      } else {
        log.info('RPCS3 already has a controller configuration; left as it is')
      }
    } else {
      log.info('RPCS3 already has a controller configuration; left as it is')
    }
  } else {
    await fs.mkdir(join(inputDir, 'global'), { recursive: true })
    await fs.writeFile(defaultYml, rpcs3InputConfig(), 'utf8')
    log.info('RPCS3 players 1-4 set to XInput Pad #1-#4; Start + Select opens the Home menu')
  }

  const configYml = join(configDir, 'config.yml')
  // Big Picture when RPCS3 is opened by itself (a game PlayOut starts with --no-gui boots without it), once.
  if (newSince(ctx, BIG_PICTURE_VERSION)) {
    let current: string | null = null
    try {
      current = await fs.readFile(configYml, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const next = withBigPicture(current)
    if (next !== null) {
      await fs.mkdir(configDir, { recursive: true })
      await fs.writeFile(configYml, next, 'utf8')
      log.info('RPCS3 set to start in Big Picture mode')
    }
  }

  // Fullscreen: the default is already true; only an existing file that turned it off is changed.
  if (ctx.firstTime) {
    let text: string | null = null
    try {
      text = await fs.readFile(configYml, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (text !== null) {
      const next = text.replace(
        /^([ \t]*)Start games in fullscreen mode:[ \t]*false[ \t]*$/m,
        '$1Start games in fullscreen mode: true'
      )
      if (next !== text) {
        await fs.writeFile(configYml, next, 'utf8')
        log.info('RPCS3 set to start games in fullscreen')
      }
    }
  }

  // Needed for fullscreen launches: the Welcome dialog would block (and on close quit) every `--no-gui` start.
  await setIniValues(
    join(E, 'GuiConfigs', 'CurrentSettings.ini'),
    'main_window',
    { infoBoxEnabledWelcome: 'false' },
    { style: 'tight' }
  )
}
