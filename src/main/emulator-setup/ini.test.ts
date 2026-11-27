import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  iniSectionOf,
  readIniSection,
  replaceIniSection,
  setIniValues,
  setMameIni,
  setRetroArchCfg,
  setTomlValues,
  setYamlTopLevel
} from './ini'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-ini-'))
  file = join(dir, 'sub', 'test.ini')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const read = (): Promise<string> => readFile(file, 'utf8')

describe('setIniValues', () => {
  it('creates the file and section with CRLF', async () => {
    await setIniValues(file, 'General', { A: '1', B: 'x' })
    expect(await read()).toBe('[General]\r\nA = 1\r\nB = x\r\n')
  })

  it('writes tight style', async () => {
    await setIniValues(file, 'scummvm', { savepath: 'C:\\s' }, { style: 'tight' })
    expect(await read()).toBe('[scummvm]\r\nsavepath=C:\\s\r\n')
  })

  it('replaces keys case-insensitively in a case-insensitive section, keeping other lines and LF', async () => {
    file = join(dir, 'g.ini')
    await writeFile(
      file,
      '; top comment\n[general]\n  isopath0 = old\nOther = 5\n\n[Next]\nISOPath0 = untouched\n'
    )
    await setIniValues(file, 'General', { ISOPath0: 'new', NewKey: 'v' })
    expect(await read()).toBe(
      '; top comment\n[general]\n  isopath0 = new\nOther = 5\nNewKey = v\n\n[Next]\nISOPath0 = untouched\n'
    )
  })

  it('leaves commented keys alone and adds a real one (Model 2 EMULATOR.INI)', async () => {
    file = join(dir, 'EMULATOR.INI')
    await writeFile(file, '[RomDirs]\r\n;Dir1=c:\\Model2\\roms\r\n\r\n[Renderer]\r\nFSAA=0\r\n')
    await setIniValues(file, 'RomDirs', { Dir1: 'D:\\roms\\model2' }, { style: 'tight' })
    expect(await read()).toBe(
      '[RomDirs]\r\n;Dir1=c:\\Model2\\roms\r\nDir1=D:\\roms\\model2\r\n\r\n[Renderer]\r\nFSAA=0\r\n'
    )
  })

  it('appends a missing section after a blank line', async () => {
    file = join(dir, 'a.ini')
    await writeFile(file, '[Other]\r\nx=1')
    await setIniValues(file, 'ports.qt', { savegamePath: 'C:\\s' }, { style: 'tight' })
    expect(await read()).toBe('[Other]\r\nx=1\r\n\r\n[ports.qt]\r\nsavegamePath=C:\\s')
  })

  it('strips a BOM and does not re-add it', async () => {
    file = join(dir, 'bom.ini')
    await writeFile(file, '\uFEFF[General]\r\nA = 0\r\n')
    await setIniValues(file, 'General', { A: '1' })
    const buf = await readFile(file)
    expect(buf[0]).toBe(0x5b)
    expect(buf.toString('utf8')).toBe('[General]\r\nA = 1\r\n')
  })

  it('does not rewrite an unchanged file and is idempotent', async () => {
    await setIniValues(file, 'General', { A: '1' })
    const first = await read()
    const m1 = (await stat(file)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await setIniValues(file, 'General', { A: '1' })
    expect(await read()).toBe(first)
    expect((await stat(file)).mtimeMs).toBe(m1)
  })
})

describe('setTomlValues', () => {
  it('creates tables with LF and escaped basic strings', async () => {
    file = join(dir, 'melonDS.toml')
    await setTomlValues(file, 'Instance0', { SaveFilePath: 'C:/a "b"\\c' })
    expect(await read()).toBe('[Instance0]\nSaveFilePath = "C:/a \\"b\\"\\\\c"\n')
  })

  it('replaces keys in the right table, inserting before the next table and root keys before the first table', async () => {
    file = join(dir, 'melonDS.toml')
    await writeFile(
      file,
      'LastROMFolder = ""\n\n[DS]\nBIOS9Path = ""\n\n[DSi]\nBIOS9Path = ""\n\n[Instance0.Joystick]\nx = 1\n'
    )
    await setTomlValues(file, 'DSi', { BIOS9Path: 'b9', NANDPath: 'n' })
    await setTomlValues(file, null, { Root: 'r' })
    await setTomlValues(file, 'Instance0', { SaveFilePath: 's' })
    expect(await read()).toBe(
      'LastROMFolder = ""\nRoot = "r"\n\n[DS]\nBIOS9Path = ""\n\n[DSi]\nBIOS9Path = "b9"\nNANDPath = "n"\n\n' +
        '[Instance0.Joystick]\nx = 1\n\n[Instance0]\nSaveFilePath = "s"\n'
    )
  })
})

describe('setYamlTopLevel', () => {
  it('replaces top-level keys with slashes and keeps nested maps', async () => {
    file = join(dir, 'vfs.yml')
    await writeFile(
      file,
      '$(EmulatorDir): ""\n/dev_hdd0/: $(EmulatorDir)dev_hdd0/\n/dev_usb***/:\n  /dev_usb000/:\n    Path: x\n'
    )
    await setYamlTopLevel(file, {
      '/dev_hdd0/': 'C:/D/storage/rpcs3/dev_hdd0/',
      '/games/': 'C:/D/roms/ps3/'
    })
    expect(await read()).toBe(
      '$(EmulatorDir): ""\n/dev_hdd0/: C:/D/storage/rpcs3/dev_hdd0/\n/dev_usb***/:\n  /dev_usb000/:\n    Path: x\n' +
        '/games/: C:/D/roms/ps3/\n'
    )
  })

  it('quotes values that are not plain-safe', async () => {
    file = join(dir, 'v.yml')
    await setYamlTopLevel(file, { a: 'x: y', b: "#it's", c: '' })
    expect(await read()).toBe("a: 'x: y'\nb: '#it''s'\nc: ''\n")
  })
})

describe('setMameIni', () => {
  it('replaces values keeping the 26-column alignment, quoting values with #, appending missing keys', async () => {
    file = join(dir, 'mame.ini')
    await writeFile(
      file,
      '#\r\n# CORE SEARCH PATH OPTIONS\r\n#\r\nhomepath                  .\r\nrompath                   roms\r\n' +
        'hashpath                  hash\r\n'
    )
    await setMameIni(file, {
      rompath: 'C:\\D\\roms;roms',
      nvram_directory: 'C:\\#x',
      homepath: '.'
    })
    expect(await read()).toBe(
      '#\r\n# CORE SEARCH PATH OPTIONS\r\n#\r\nhomepath                  .\r\nrompath                   C:\\D\\roms;roms\r\n' +
        'hashpath                  hash\r\nnvram_directory           "C:\\#x"\r\n'
    )
  })

  it('creates a new file with CRLF', async () => {
    file = join(dir, 'new', 'mame.ini')
    await setMameIni(file, { a_very_long_option_name_over_26: 'v' })
    expect(await read()).toBe('a_very_long_option_name_over_26 v\r\n')
  })
})

describe('setRetroArchCfg', () => {
  it('replaces and appends double-quoted values', async () => {
    file = join(dir, 'retroarch.cfg')
    await writeFile(file, 'video_driver = "gl"\nsystem_directory = "default"\n')
    await setRetroArchCfg(file, {
      system_directory: 'C:\\D\\bios',
      savefile_directory: 'C:\\D\\saves'
    })
    expect(await read()).toBe(
      'video_driver = "gl"\nsystem_directory = "C:\\D\\bios"\nsavefile_directory = "C:\\D\\saves"\n'
    )
  })
})

describe('readIniSection', () => {
  it('returns null for a missing file or section', async () => {
    expect(await readIniSection(file, 'Pad1')).toBeNull()
    await writeFile(join(dir, 'a.ini'), '[Main]\r\nA = 1\r\n')
    expect(await readIniSection(join(dir, 'a.ini'), 'Pad1')).toBeNull()
  })

  it('returns the raw body of the first matching section, case-insensitively, without separators', async () => {
    file = join(dir, 'a.ini')
    await writeFile(
      file,
      '﻿[Main]\r\nA = 1\r\n\r\n[pad1]\r\n; comment\r\nUp = Keyboard/W\r\nUp = SDL-0/DPadUp\r\n\r\n\r\n[Pad2]\r\nType = None\r\n'
    )
    expect(await readIniSection(file, 'Pad1')).toEqual([
      '; comment',
      'Up = Keyboard/W',
      'Up = SDL-0/DPadUp'
    ])
    expect(await readIniSection(file, 'PAD2')).toEqual(['Type = None'])
  })

  it('returns an empty array for an empty section and handles names with spaces and #', async () => {
    file = join(dir, 'a.ini')
    await writeFile(file, '[Empty]\n[gba.input-profile.XInput Controller #1]\nkeyA=0\n')
    expect(await readIniSection(file, 'Empty')).toEqual([])
    expect(await readIniSection(file, 'gba.input-profile.XInput Controller #1')).toEqual(['keyA=0'])
  })
})

describe('replaceIniSection', () => {
  it('creates the file with CRLF, or LF when asked', async () => {
    await replaceIniSection(file, 'Pad1', ['Type = AnalogController', 'Up = SDL-0/DPadUp'])
    expect(await read()).toBe('[Pad1]\r\nType = AnalogController\r\nUp = SDL-0/DPadUp\r\n')
    const lf = join(dir, 'lf.ini')
    await replaceIniSection(lf, 'GCPad1', ['Device = XInput/0/Gamepad'], { eol: 'lf' })
    expect(await readFile(lf, 'utf8')).toBe('[GCPad1]\nDevice = XInput/0/Gamepad\n')
  })

  it('replaces only the body of the first matching section, keeping the others and the separators', async () => {
    file = join(dir, 'a.ini')
    await writeFile(
      file,
      '[Main]\nA = 1\n\n[PAD1]\nUp = Keyboard/W\nDown = Keyboard/S\n\n[Pad2]\nType = None\n'
    )
    await replaceIniSection(file, 'Pad1', ['Up = Keyboard/W', 'Up = SDL-0/DPadUp'], { eol: 'crlf' })
    // The existing file keeps its LF line endings and the header its spelling.
    expect(await read()).toBe(
      '[Main]\nA = 1\n\n[PAD1]\nUp = Keyboard/W\nUp = SDL-0/DPadUp\n\n[Pad2]\nType = None\n'
    )
  })

  it('appends a missing section after a blank line, and is idempotent', async () => {
    file = join(dir, 'a.ini')
    await writeFile(file, '[Main]\r\nA = 1\r\n')
    await replaceIniSection(file, 'Pad1', ['Type = DualShock2'])
    await replaceIniSection(file, 'Pad1', ['Type = DualShock2'])
    expect(await read()).toBe('[Main]\r\nA = 1\r\n\r\n[Pad1]\r\nType = DualShock2\r\n')
    const before = (await stat(file)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await replaceIniSection(file, 'Pad1', ['Type = DualShock2'])
    expect((await stat(file)).mtimeMs).toBe(before)
  })

  it('replaces the last section of a file without a final line break', async () => {
    file = join(dir, 'a.ini')
    await writeFile(file, '[Main]\nA = 1\n[Pad1]\nOld = 1')
    await replaceIniSection(file, 'pad1', ['New = 2', 'New = 3'])
    expect(await read()).toBe('[Main]\nA = 1\n[Pad1]\nNew = 2\nNew = 3')
  })
})

describe("encoding 'latin1'", () => {
  /** An ANSI (Windows-1252) file: 'é' is the single byte 0xE9, '±' is 0xB1. */
  const ANSI = Buffer.from([
    ...Buffer.from('[RomDirs]\r\n;Dir1=C:/Jeux/'),
    0xe9,
    ...Buffer.from('t\r\n\r\n[Input]\r\nXInput=0\t;'),
    0xb1,
    ...Buffer.from('\r\n')
  ])

  it('keeps every byte of an ANSI file through setIniValues and replaceIniSection', async () => {
    file = join(dir, 'a.ini')
    await writeFile(file, ANSI)
    await setIniValues(file, 'Input', { XInput: '1' }, { style: 'tight', encoding: 'latin1' })
    await replaceIniSection(file, 'Extra', ['A=1'], { encoding: 'latin1' })
    const bytes = await readFile(file)
    const expected = Buffer.from(
      ANSI.toString('latin1').replace('XInput=0\t;\u00b1', 'XInput=1') + '\r\n[Extra]\r\nA=1\r\n',
      'latin1'
    )
    expect(bytes.equals(expected)).toBe(true)
    expect(bytes.includes(0xe9)).toBe(true)
    expect(bytes.includes(Buffer.from([0xc3, 0xa9]))).toBe(false)
  })

  it('reads ANSI bytes one to one, and leaves an unchanged file alone', async () => {
    file = join(dir, 'a.ini')
    await writeFile(file, ANSI)
    expect(await readIniSection(file, 'RomDirs', { encoding: 'latin1' })).toEqual([
      ';Dir1=C:/Jeux/\u00e9t'
    ])
    await setIniValues(
      file,
      'Input',
      { XInput: '0\t;\u00b1' },
      { style: 'tight', encoding: 'latin1' }
    )
    expect((await readFile(file)).equals(ANSI)).toBe(true)
  })

  it('is what corrupts the file without it (UTF-8 replaces the byte)', async () => {
    file = join(dir, 'a.ini')
    await writeFile(file, ANSI)
    await setIniValues(file, 'Input', { XInput: '1' }, { style: 'tight' })
    expect((await readFile(file)).includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(true)
  })
})

describe('iniSectionOf', () => {
  it('reads sections of text already read, like readIniSection', () => {
    const text = '\uFEFF[UI]\r\nA = 1\r\n\r\n[GameList]\r\nPaths = C:/x\r\nPaths = D:/y\r\n'
    expect(iniSectionOf(text, 'gamelist')).toEqual(['Paths = C:/x', 'Paths = D:/y'])
    expect(iniSectionOf(text, 'UI')).toEqual(['A = 1'])
    expect(iniSectionOf(text, 'Folders')).toBeNull()
    expect(iniSectionOf('', 'UI')).toBeNull()
  })
})
