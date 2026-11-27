import { promises as fs } from 'fs'
import { join } from 'path'
import type { Logger } from '../logger'
import { readIniSection, setIniValues } from './ini'
import { cachedRecord, pcsx2CacheFile } from './pcsx2-game-list'

/**
 * PCSX2's memory cards for a game PlayOut is about to start (docs/emulator-setup.md, "PCSX2's memory cards").
 *
 * PCSX2 locks a memory card file while it uses it, so the two slots can never use the same card: the second one fails
 * with "Memory Card Read Failed ... Another instance of PCSX2 may be using this memory card". That happens when a game's
 * own settings (Big Picture's Game Properties) give one slot the card the other slot already uses. Before the launch,
 * such a game gets the other slot back on the card that slot would otherwise not use (the two cards trade places for
 * that game), or that slot switched off when there is no other card. Only the game's own settings file changes; the
 * chosen card, and the saves on it, stay where the user put them.
 */

/** PCSX2's defaults for the two slots (Pcsx2Config::McdOptions). */
const DEFAULT_CARD = ['Mcd001.ps2', 'Mcd002.ps2']

interface Slot {
  enabled: boolean
  file: string
}

/** One key of a section (the last one wins, as PCSX2 reads a plain value). */
function value(lines: string[] | null, key: string): string | undefined {
  let found: string | undefined
  for (const line of lines ?? []) {
    const m = /^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && m[1].toLowerCase() === key.toLowerCase()) found = m[2]
  }
  return found
}

const enabled = (v: string | undefined): boolean | undefined =>
  v === undefined ? undefined : /^(true|1)$/i.test(v)

/** The file of a game's own settings (VMManager::GetGameSettingsPath: "SERIAL_CRC.ini", the CRC in 8 hex digits). */
export function gameSettingsName(serial: string, crc: number): string {
  const hex = crc.toString(16).toUpperCase().padStart(8, '0')
  return serial ? `${serial}_${hex}.ini` : `${hex}.ini`
}

/**
 * What to write into a game's settings so its two slots use different cards, or null when they already do.
 * `global` and `game` are the [MemoryCards] sections of PCSX2.ini and of the game's own file.
 */
export function separateSlots(
  global: string[] | null,
  game: string[] | null
): Record<string, string> | null {
  const globalSlot = (n: 1 | 2): Slot => ({
    enabled: enabled(value(global, `Slot${n}_Enable`)) ?? true,
    file: value(global, `Slot${n}_Filename`) ?? DEFAULT_CARD[n - 1]
  })
  const own = (n: 1 | 2): { enabled?: boolean; file?: string } => ({
    enabled: enabled(value(game, `Slot${n}_Enable`)),
    file: value(game, `Slot${n}_Filename`)
  })
  const g = [globalSlot(1), globalSlot(2)]
  const o = [own(1), own(2)]
  const slot = (i: 0 | 1): Slot => ({
    enabled: o[i].enabled ?? g[i].enabled,
    file: o[i].file ?? g[i].file
  })
  const [s1, s2] = [slot(0), slot(1)]
  if (!s1.enabled || !s2.enabled || s1.file.toLowerCase() !== s2.file.toLowerCase()) return null
  const card = s1.file.toLowerCase()
  // The slot the game chose a card for keeps it; the other one gets the card the chosen slot would have used.
  if (o[0].file !== undefined && o[1].file === undefined) {
    return g[0].file.toLowerCase() !== card
      ? { Slot2_Filename: g[0].file }
      : { Slot2_Enable: 'false' }
  }
  if (o[1].file !== undefined && o[0].file === undefined) {
    return g[1].file.toLowerCase() !== card
      ? { Slot1_Filename: g[1].file }
      : { Slot2_Enable: 'false' }
  }
  return { Slot2_Enable: 'false' }
}

/**
 * Separates the two slots of the game PlayOut is about to start (see above). The check is read-only; `isRunning` is
 * asked only when something must be written (a running PCSX2 writes its settings files when it exits), and nothing is
 * written while one runs. A game PCSX2 has not cached yet (no serial and CRC to name its file) is left alone. Never
 * throws.
 */
export async function fixSharedMemoryCard(deps: {
  emuDir: string
  rom: string
  log: Logger
  isRunning?: () => Promise<boolean>
}): Promise<boolean> {
  const { emuDir, log } = deps
  try {
    let cache: Buffer
    try {
      cache = await fs.readFile(await pcsx2CacheFile(emuDir))
    } catch {
      return false
    }
    const record = cachedRecord(cache, deps.rom)
    if (!record) {
      log.info(`PCSX2: memory cards not checked for ${deps.rom}: not in the game list cache yet`)
      return false
    }
    const file = join(emuDir, 'gamesettings', gameSettingsName(record.serial, record.crc))
    const global = await readIniSection(join(emuDir, 'inis', 'PCSX2.ini'), 'MemoryCards')
    const game = await readIniSection(file, 'MemoryCards')
    const change = separateSlots(global, game)
    if (!change) return false
    if (await deps.isRunning?.()) {
      log.info('PCSX2 is running: its shared memory card is separated at a later launch')
      return false
    }
    await setIniValues(file, 'MemoryCards', change)
    log.info(
      `PCSX2: both memory card slots of ${record.serial || 'the game'} used one card; ${Object.entries(
        change
      )
        .map(([k, v]) => `${k} = ${v}`)
        .join(', ')}`
    )
    return true
  } catch (err) {
    log.warn(`PCSX2: memory card check failed: ${(err as Error).message}`)
    return false
  }
}
