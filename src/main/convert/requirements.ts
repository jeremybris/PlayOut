import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { ConvertMissing, ConvertNeed } from '../../shared/convert'
import { tMain } from '../i18n'

/**
 * What some conversions need from the user (their own keys, their emulators), found the way an ES-DE / EmuDeck setup
 * keeps them: keys in the Emulation folder's `bios` subfolders (the Switch emulators' `keys` folders, as EmuDeck
 * lays them out), emulators where PlayOut already finds them (Settings › Emulators). Nothing is downloaded or made up.
 */

/** Where each key is looked for, relative to the Emulation folder; the first is where PlayOut asks for it. */
export const KEY_PLACES: Record<'switchKeys' | 'wiiKey' | 'ps3Key', string[]> = {
  switchKeys: [
    'bios/switch/prod.keys',
    'bios/ryujinx/keys/prod.keys',
    'bios/yuzu/keys/prod.keys',
    'bios/eden/keys/prod.keys',
    'bios/citron/keys/prod.keys',
    'bios/prod.keys'
  ],
  wiiKey: [
    'bios/wii/common-key.bin',
    'bios/wii/common-key.txt',
    'bios/dolphin/common-key.bin',
    'bios/dolphin/common-key.txt'
  ],
  ps3Key: [
    'bios/ps3/pkg-key.txt',
    'bios/ps3/pkg-key.bin',
    'bios/rpcs3/pkg-key.txt',
    'bios/rpcs3/pkg-key.bin'
  ]
}

/** The tools and keys a run passes to the converter (only what was found). */
export interface ConvertTools {
  switchKeys?: string
  /** 32 hex characters. */
  wiiKey?: string
  dolphinTool?: string
  rpcs3?: string
  /** 32 hex characters. */
  ps3Key?: string
}

const place = (emulationDir: string, relative: string): string =>
  join(emulationDir, ...relative.split('/'))

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

/** A 16-byte key, from a file of exactly 16 bytes or 32 hex characters (spaces, colons, dashes or 0x allowed). */
export function readHexKey(data: Buffer): string | null {
  if (data.length === 16) return data.toString('hex')
  if (data.length > 4096) return null
  for (const line of data.toString('utf8').split(/\r?\n/)) {
    const text = line.split(/#|;|\/\//)[0]!
    const m =
      /(?<![0-9a-f])(?:0x)?([0-9a-f]{32})(?![0-9a-f])/i.exec(text) ??
      /((?:[0-9a-f]{2}[ :-]){15}[0-9a-f]{2})/i.exec(text)
    if (m) return m[1]!.replace(/[^0-9a-f]/gi, '').toLowerCase()
  }
  return null
}

async function firstFile(emulationDir: string, places: string[]): Promise<string | undefined> {
  for (const relative of places) {
    const path = place(emulationDir, relative)
    if (await isFile(path)) return path
  }
  return undefined
}

async function firstKey(emulationDir: string, places: string[]): Promise<string | undefined> {
  for (const relative of places) {
    const path = place(emulationDir, relative)
    if (!(await isFile(path))) continue
    const key = readHexKey(await fs.readFile(path).catch(() => Buffer.alloc(0)))
    if (key) return key
  }
  return undefined
}

export interface FindToolsDeps {
  emulationDir: string
  /** Resolved emulator executables by PlayOut emulator id ('RPCS3', 'DOLPHIN'). */
  emulatorPath: (id: string) => Promise<string | null>
}

/** Every key and tool the given needs could use, as far as they are on this PC. */
export async function findTools(
  needs: readonly ConvertNeed[],
  deps: FindToolsDeps
): Promise<ConvertTools> {
  const tools: ConvertTools = {}
  const dir = deps.emulationDir
  if (needs.includes('switchKeys')) tools.switchKeys = await firstFile(dir, KEY_PLACES.switchKeys)
  if (needs.includes('wiiKey')) {
    tools.wiiKey = await firstKey(dir, KEY_PLACES.wiiKey)
    const dolphin = await deps.emulatorPath('DOLPHIN')
    if (dolphin) {
      const tool = join(dirname(dolphin), 'DolphinTool.exe')
      if (await isFile(tool)) tools.dolphinTool = tool
    }
  }
  if (needs.includes('ps3Unpack')) {
    const rpcs3 = await deps.emulatorPath('RPCS3')
    if (rpcs3 && (await isFile(rpcs3))) tools.rpcs3 = rpcs3
  }
  if (needs.includes('ps3Unpack') || needs.includes('ps3PackKey'))
    tools.ps3Key = await firstKey(dir, KEY_PLACES.ps3Key)
  for (const key of Object.keys(tools) as (keyof ConvertTools)[])
    if (tools[key] === undefined) delete tools[key]
  return tools
}

/** Where PlayOut asks for what a need lacks (an absolute path in the Emulation folder). */
export function needPlace(need: ConvertNeed, emulationDir: string): string {
  const key = need === 'switchKeys' ? 'switchKeys' : need === 'wiiKey' ? 'wiiKey' : 'ps3Key'
  return place(emulationDir, KEY_PLACES[key][0]!)
}

/** What the needs lack on this PC, each with where to put it. */
export function missingFor(
  needs: readonly ConvertNeed[],
  tools: ConvertTools,
  emulationDir: string
): ConvertMissing[] {
  const out: ConvertMissing[] = []
  const at = (relative: string): string => place(emulationDir, relative)
  if (needs.includes('switchKeys') && !tools.switchKeys)
    out.push({
      need: 'switchKeys',
      message: tMain('mainConvert.needs.switchKeys'),
      place: at(KEY_PLACES.switchKeys[0]!),
      blocking: false
    })
  if (needs.includes('wiiKey') && !tools.wiiKey && !tools.dolphinTool)
    out.push({
      need: 'wiiKey',
      message: tMain('mainConvert.needs.wiiKey'),
      place: at(KEY_PLACES.wiiKey[0]!),
      blocking: true
    })
  if (needs.includes('ps3Unpack') && !tools.rpcs3 && !tools.ps3Key)
    out.push({
      need: 'ps3Unpack',
      message: tMain('mainConvert.needs.ps3Unpack'),
      place: at(KEY_PLACES.ps3Key[0]!),
      blocking: true
    })
  if (needs.includes('ps3PackKey') && !tools.ps3Key)
    out.push({
      need: 'ps3PackKey',
      message: tMain('mainConvert.needs.ps3PackKey'),
      place: at(KEY_PLACES.ps3Key[0]!),
      blocking: true
    })
  return out
}

/** The converter's command-line options for the tools found. */
export function toolArgs(tools: ConvertTools): string[] {
  const args: string[] = []
  if (tools.switchKeys) args.push('--switch-keys', tools.switchKeys)
  if (tools.wiiKey) args.push('--wii-key', tools.wiiKey)
  if (tools.dolphinTool) args.push('--dolphintool', tools.dolphinTool)
  if (tools.rpcs3) args.push('--rpcs3', tools.rpcs3)
  if (tools.ps3Key) args.push('--pkg-key', tools.ps3Key)
  return args
}
