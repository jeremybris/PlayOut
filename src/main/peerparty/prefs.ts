import { promises as fs } from 'fs'
import { join } from 'path'
import type { Logger } from '../logger'

/**
 * PlayOut runs its own copy of PeerParty in portable mode: a `peerparty-data` folder beside peerparty.exe (in
 * PlayOut's data folder) holds its ui.json, identities, saves and hook files instead of %LOCALAPPDATA%\peerparty. In
 * that ui.json PlayOut turns PeerParty's Home (Guide) button hotkey off, so the controller's Home button keeps opening
 * PlayOut's overlay; every other setting the player made in PeerParty stays as it is.
 */

export const DATA_DIR_NAME = 'peerparty-data'
const UI_JSON = 'ui.json'

/** The text without a leading byte order mark (character 0xFEFF), which JSON.parse refuses. */
const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Makes the portable data folder and turns PeerParty's Home button hotkey off in its ui.json. Call it only while no
 * PeerParty of ours runs (PeerParty writes ui.json under its own lock). A missing ui.json is written with only that
 * setting and no `ui_version`, which PeerParty reads as an older, already set-up file and fills in its defaults. A
 * ui.json that cannot be read as an object is left alone (PeerParty keeps its own copy of a bad file). Returns
 * whether ui.json was written.
 */
export async function ensurePortablePrefs(dataDir: string, log: Logger): Promise<boolean> {
  await fs.mkdir(dataDir, { recursive: true })
  const file = join(dataDir, UI_JSON)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`PeerParty: ${file} could not be read: ${(err as Error).message}`)
      return false
    }
    await writeAtomically(file, { prefs: { hotkeys: { guide: false } } })
    return true
  }
  let value: unknown
  try {
    value = JSON.parse(withoutBom(text))
  } catch {
    log.warn(`PeerParty: ${file} is not valid JSON; left as it is`)
    return false
  }
  if (!isObject(value)) {
    log.warn(`PeerParty: ${file} is not a settings object; left as it is`)
    return false
  }
  const prefs = isObject(value.prefs) ? value.prefs : (value.prefs = {})
  const hotkeys = isObject(prefs.hotkeys) ? prefs.hotkeys : (prefs.hotkeys = {})
  if (hotkeys.guide === false) return false
  hotkeys.guide = false
  await writeAtomically(file, value)
  return true
}

async function writeAtomically(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.playout-${process.pid}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2))
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}
