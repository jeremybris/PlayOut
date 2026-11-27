import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  type Dirent
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPACT_EXE,
  CompactLineCounter,
  compactArgs,
  compactFileBatches,
  compressFolder,
  compressStateOf,
  compressUnavailable,
  isCompressibleFile,
  listFolderFiles,
  measureFolder,
  measureFolderScript,
  parseCompactDatabase,
  parseFolderMeasure,
  parseVolumeInfo,
  uncompressFolder,
  volumeInfoScript,
  type CompactSpawn
} from './compress'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'playout-compress-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function file(rel: string, size: number): string {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(size, 1))
  return path
}

/** A fake compact.exe: prints one result line per file argument. */
function fakeSpawn(
  calls: { args: string[]; cwd: string }[],
  code: number | null = 0,
  silent: Set<string> = new Set()
): CompactSpawn {
  return async (_exe, args, options) => {
    calls.push({ args, cwd: options.cwd })
    const files = args.filter((a) => !a.startsWith('/'))
    const text =
      `\r\n Compressing files in ${options.cwd}\\\r\n\r\n` +
      files
        .filter((f) => !silent.has(f))
        .map((f) => `${f}    5000 :    4096 = 1.2 to 1 [OK]\r\n`)
        .join('') +
      `\r\n${files.length} files within 1 directories were compressed.\r\n`
    // Streamed in small pieces (lines split across chunks), as compact.exe does.
    for (let i = 0; i < text.length; i += 7) options.onStdout(text.slice(i, i + 7))
    return { code }
  }
}

describe('compactArgs', () => {
  it('builds the spec flags for each action', () => {
    expect(compactArgs('compress', 'D:\\Games\\X\\', 'lzx')).toEqual([
      '/C',
      '/S:D:\\Games\\X',
      '/A',
      '/I',
      '/EXE:LZX'
    ])
    expect(compactArgs('compress', 'D:\\Games\\X')).toContain('/EXE:XPRESS8K')
    expect(compactArgs('compress', 'D:\\Games\\X', 'xpress16k', true)).toContain('/F')
    expect(compactArgs('uncompress', 'D:\\Games\\X')).toEqual([
      '/U',
      '/S:D:\\Games\\X',
      '/A',
      '/I',
      '/EXE'
    ])
    expect(compactArgs('query', 'D:\\Games\\X')).toEqual(['/Q', '/S:D:\\Games\\X', '/A'])
  })
})

describe('compactFileBatches', () => {
  it('keeps every command line under the limit and every file once', () => {
    const files = Array.from(
      { length: 2000 },
      (_, i) => `Content\\Paks\\some long file name ${i}.pak`
    )
    const batches = compactFileBatches('compress', files, 'xpress4k')
    expect(batches.length).toBeGreaterThan(1)
    for (const b of batches) {
      expect(b.slice(0, 4)).toEqual(['/C', '/A', '/I', '/EXE:XPRESS4K'])
      expect(b.join(' ').length + COMPACT_EXE.length).toBeLessThan(32_000)
    }
    expect(batches.flatMap((b) => b.slice(4))).toEqual(files)
    expect(compactFileBatches('uncompress', ['a'])).toEqual([['/U', '/A', '/I', '/EXE', 'a']])
  })
})

describe('CompactLineCounter', () => {
  it('counts per-file lines only, across chunks and in any language', () => {
    const c = new CompactLineCounter()
    c.push('\r\n Compressing files in C:\\x\\\r\n\r\na1.txt   300000 :  12')
    expect(c.count).toBe(0)
    c.push(
      '288 = 24.4 to 1 [OK]\r\nb.txt [OK]\r\n\r\n2 files within 1 directories were compressed.\r\n'
    )
    c.push(' Komprimiere Dateien in C:\\y\\\r\nc.bin  5 : 5 = 1,0 zu 1 [OK]')
    expect(c.count).toBe(2)
    expect(c.end()).toBe(3)
  })
})

describe('listFolderFiles / isCompressibleFile', () => {
  it('lists files with relative paths and skips links', async () => {
    file('game.exe', 10)
    file('Content\\data.pak', 20)
    mkdirSync(join(root, 'elsewhere'))
    try {
      symlinkSync(join(root, 'Content'), join(root, 'link'), 'junction')
    } catch {
      /* junctions may be refused; the rest still runs */
    }
    const files = await listFolderFiles(root)
    expect(files.map((f) => f.relPath).sort()).toEqual(['Content\\data.pak', 'game.exe'])
    expect(files.find((f) => f.relPath === 'game.exe')?.size).toBe(10)
  })

  it('reads folders 32 levels deep and no deeper (as measureFolderScript does)', async () => {
    const levels = (n: number): string => Array.from({ length: n }, () => 'd').join('\\')
    file(`${levels(32)}\\in.pak`, 10)
    file(`${levels(33)}\\out.pak`, 10)
    const files = await listFolderFiles(root)
    expect(files.map((f) => f.relPath)).toEqual([`${levels(32)}\\in.pak`])
  })

  it('leaves tiny files and CompactGUI skip types alone', () => {
    expect(isCompressibleFile('a.pak', 4096)).toBe(false)
    expect(isCompressibleFile('a.pak', 4097)).toBe(true)
    expect(isCompressibleFile('Movies\\intro.BK2', 1e6)).toBe(false)
    expect(isCompressibleFile('x.mp4', 1e6)).toBe(false)
    expect(isCompressibleFile('noext', 1e6)).toBe(true)
    expect(isCompressibleFile('.hidden', 1e6)).toBe(true)
  })
})

describe('compressFolder', () => {
  it('compresses eligible files in the folder with progress to 1', async () => {
    file('game.exe', 5000)
    file('Content\\data.pak', 8000)
    file('Movies\\intro.bk2', 9000)
    file('tiny.ini', 100)
    const calls: { args: string[]; cwd: string }[] = []
    const progress: (number | null)[] = []
    const result = await compressFolder(
      root,
      'xpress16k',
      (p) => progress.push(p.progress),
      new AbortController().signal,
      { spawn: fakeSpawn(calls) }
    )
    expect(result).toEqual({ ok: true, message: 'Compressed 2 files.' })
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe(root)
    expect(calls[0].args.slice(0, 4)).toEqual(['/C', '/A', '/I', '/EXE:XPRESS16K'])
    expect(calls[0].args.slice(4).sort()).toEqual(['Content\\data.pak', 'game.exe'])
    expect(progress[0]).toBeNull()
    expect(progress).toContain(0.5)
    expect(progress[progress.length - 1]).toBe(1)
  })

  it('adds /F when forced and reaches 1 when compact.exe skips files silently', async () => {
    file('a.pak', 5000)
    file('b.pak', 5000)
    const calls: { args: string[]; cwd: string }[] = []
    const progress: (number | null)[] = []
    await compressFolder(
      root,
      'lzx',
      (p) => progress.push(p.progress),
      new AbortController().signal,
      { spawn: fakeSpawn(calls, 0, new Set(['a.pak', 'b.pak'])) },
      { force: true }
    )
    expect(calls[0].args).toContain('/F')
    expect(progress[progress.length - 1]).toBe(1)
  })

  it('adds /F when the previous algorithm differs, and not when it is the same', async () => {
    file('a.pak', 5000)
    const calls: { args: string[]; cwd: string }[] = []
    const signal = new AbortController().signal
    await compressFolder(
      root,
      'lzx',
      () => {},
      signal,
      { spawn: fakeSpawn(calls) },
      {
        previousAlgorithm: 'xpress8k'
      }
    )
    expect(calls[0].args).toContain('/F')
    await compressFolder(
      root,
      'lzx',
      () => {},
      signal,
      { spawn: fakeSpawn(calls) },
      {
        previousAlgorithm: 'lzx'
      }
    )
    expect(calls[1].args).not.toContain('/F')
    await compressFolder(root, 'lzx', () => {}, signal, { spawn: fakeSpawn(calls) })
    expect(calls[2].args).not.toContain('/F')
  })

  it('does not claim work when compact.exe skipped every file', async () => {
    file('a.pak', 5000)
    file('b.pak', 5000)
    const signal = new AbortController().signal
    const none = await compressFolder(root, 'lzx', () => {}, signal, {
      spawn: fakeSpawn([], 0, new Set(['a.pak', 'b.pak']))
    })
    expect(none).toEqual({
      ok: true,
      message: "The game's files were already compressed, so nothing changed."
    })
    const some = await compressFolder(root, 'lzx', () => {}, signal, {
      spawn: fakeSpawn([], 0, new Set(['a.pak']))
    })
    expect(some).toEqual({
      ok: true,
      message: 'Compressed 1 file; the others were already compressed.'
    })
  })

  it('stops counting files as soon as it is aborted', async () => {
    const controller = new AbortController()
    let reads = 0
    const dir = (name: string): Dirent =>
      ({
        name,
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => false
      }) as unknown as Dirent
    const io = {
      readdir: async () => {
        reads++
        if (reads === 3) controller.abort()
        return [dir('a'), dir('b'), dir('c')]
      },
      stat: async () => ({ size: 0, mtimeMs: 0, isDirectory: () => true })
    }
    const calls: { args: string[]; cwd: string }[] = []
    const result = await compressFolder(root, 'xpress8k', () => {}, controller.signal, {
      spawn: fakeSpawn(calls),
      io
    })
    expect(result).toEqual({ ok: false, message: 'Compression was stopped.' })
    expect(reads).toBe(3)
    expect(calls).toHaveLength(0)
    const un = await uncompressFolder(root, () => {}, controller.signal, {
      spawn: fakeSpawn([]),
      io
    })
    expect(un.ok).toBe(false)
    expect(reads).toBe(3)
  })

  it('reports a failed run', async () => {
    file('a.pak', 5000)
    const result = await compressFolder(root, 'xpress8k', () => {}, new AbortController().signal, {
      spawn: fakeSpawn([], 1)
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/closed/)
  })

  it('treats a throwing spawn as a failed run', async () => {
    file('a.pak', 5000)
    const result = await compressFolder(root, 'xpress8k', () => {}, new AbortController().signal, {
      spawn: async () => {
        throw new Error('no compact')
      }
    })
    expect(result.ok).toBe(false)
  })

  it('stops between runs when aborted', async () => {
    for (let i = 0; i < 400; i++) file(`d\\${'x'.repeat(100)}${i}.pak`, 5000)
    const controller = new AbortController()
    const calls: { args: string[]; cwd: string }[] = []
    const spawn = fakeSpawn(calls)
    const result = await compressFolder(root, 'xpress8k', () => {}, controller.signal, {
      spawn: async (exe, args, options) => {
        const r = await spawn(exe, args, options)
        controller.abort()
        return r
      }
    })
    expect(result).toEqual({ ok: false, message: 'Compression was stopped.' })
    expect(calls).toHaveLength(1)
  })

  it('refuses with too little free space', async () => {
    file('a.pak', 6000)
    const calls: { args: string[]; cwd: string }[] = []
    const result = await compressFolder(root, 'xpress8k', () => {}, new AbortController().signal, {
      spawn: fakeSpawn(calls),
      freeSpace: async () => 11_000
    })
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('does nothing in a folder with nothing worth compressing', async () => {
    file('a.mp4', 50_000)
    const calls: { args: string[]; cwd: string }[] = []
    const result = await compressFolder(root, 'xpress8k', () => {}, new AbortController().signal, {
      spawn: fakeSpawn(calls)
    })
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('uncompressFolder', () => {
  it('uncompresses every file, skip types and tiny files included', async () => {
    file('a.pak', 5000)
    file('b.mp4', 5000)
    file('c.ini', 10)
    const calls: { args: string[]; cwd: string }[] = []
    let last: number | null = null
    const result = await uncompressFolder(
      root,
      (p) => (last = p.progress),
      new AbortController().signal,
      { spawn: fakeSpawn(calls) }
    )
    expect(result).toEqual({ ok: true, message: 'Uncompressed 3 files.' })
    expect(calls[0].args.slice(0, 4)).toEqual(['/U', '/A', '/I', '/EXE'])
    expect(calls[0].args.slice(4).sort()).toEqual(['a.pak', 'b.mp4', 'c.ini'])
    expect(last).toBe(1)
  })

  it('refuses when the drive cannot hold the uncompressed files', async () => {
    // 3 files of 10,000 bytes taking 4,000 each on disk: they grow by 18,000, plus the largest file = 28,000.
    file('a.pak', 10_000)
    file('b.pak', 10_000)
    file('c.pak', 10_000)
    const calls: { args: string[]; cwd: string }[] = []
    const signal = new AbortController().signal
    const measured: string[] = []
    const compressedSize = async (f: string): Promise<number> => {
      measured.push(f)
      return 4000
    }
    const short = await uncompressFolder(root, () => {}, signal, {
      spawn: fakeSpawn(calls),
      freeSpace: async () => 27_999,
      compressedSize
    })
    expect(short.ok).toBe(false)
    expect(short.message).toMatch(/free space/)
    expect(calls).toHaveLength(0)
    expect(measured.sort()).toEqual(['a.pak', 'b.pak', 'c.pak'].map((f) => join(root, f)))
    const enough = await uncompressFolder(root, () => {}, signal, {
      spawn: fakeSpawn(calls),
      freeSpace: async () => 28_000,
      compressedSize
    })
    expect(enough.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('uses the last measured bytes on disk without compressedSize', async () => {
    file('a.pak', 10_000)
    file('b.pak', 10_000)
    const calls: { args: string[]; cwd: string }[] = []
    const signal = new AbortController().signal
    // Grows by 20,000 - 8,000 = 12,000, plus 10,000 for the largest file.
    const deps = { spawn: fakeSpawn(calls), freeSpace: async () => 21_000 }
    expect((await uncompressFolder(root, () => {}, signal, deps, { onDisk: 8000 })).ok).toBe(false)
    expect((await uncompressFolder(root, () => {}, signal, deps, { onDisk: 9000 })).ok).toBe(true)
    // Unknown on-disk size: only the largest file is required.
    expect((await uncompressFolder(root, () => {}, signal, deps)).ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('is stopped before starting when already aborted', async () => {
    file('a.pak', 5000)
    const controller = new AbortController()
    controller.abort()
    const calls: { args: string[]; cwd: string }[] = []
    const result = await uncompressFolder(root, () => {}, controller.signal, {
      spawn: fakeSpawn(calls)
    })
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('compressStateOf / measureFolder', () => {
  it('decides the state from the counts', () => {
    const base = { compressedFiles: 0, eligible: 3, eligibleCompressed: 0, changed: null }
    expect(compressStateOf(base)).toBe('none')
    expect(compressStateOf({ ...base, compressedFiles: 3, eligibleCompressed: 3 })).toBe(
      'compressed'
    )
    expect(compressStateOf({ ...base, compressedFiles: 2, eligibleCompressed: 2 })).toBe('partial')
    expect(
      compressStateOf({ ...base, compressedFiles: 2, eligibleCompressed: 2, changed: 0 })
    ).toBe('compressed')
    expect(
      compressStateOf({ ...base, compressedFiles: 2, eligibleCompressed: 2, changed: 1 })
    ).toBe('partial')
  })

  it('sums sizes and on-disk sizes', async () => {
    const a = file('a.pak', 10_000)
    file('b.pak', 20_000)
    file('c.mp4', 30_000)
    const sizes = new Map([[a, 4_000]])
    const none = await measureFolder(root, { compressedSize: async (f) => (f === a ? 10_000 : -1) })
    expect(none).toEqual({ size: 60_000, onDisk: 60_000, state: 'none' })
    const partial = await measureFolder(root, {
      compressedSize: async (f) => {
        if (f.endsWith('c.mp4')) throw new Error('locked')
        return sizes.get(f) ?? 20_000
      }
    })
    expect(partial).toEqual({ size: 60_000, onDisk: 54_000, state: 'partial' })
  })

  it('tells a game update apart from incompressible files with compressedAt', async () => {
    const a = file('a.pak', 10_000)
    const b = file('b.pak', 20_000)
    const old = new Date('2026-01-01T00:00:00Z')
    utimesSync(a, old, old)
    utimesSync(b, old, old)
    const compressedAt = Date.parse('2026-02-01T00:00:00Z')
    const compressedSize = async (f: string): Promise<number> => (f === a ? 3_000 : 20_000)
    expect((await measureFolder(root, { compressedSize, compressedAt })).state).toBe('compressed')
    const later = new Date('2026-03-01T00:00:00Z')
    utimesSync(b, later, later)
    expect((await measureFolder(root, { compressedSize, compressedAt })).state).toBe('partial')
  })
})

describe('measureFolderScript / parseFolderMeasure', () => {
  it('quotes the folder and embeds the rules', () => {
    const script = measureFolderScript("D:\\Games\\Assassin's Creed", 1_700_000_000_000)
    expect(script).toContain("$dir = 'D:\\Games\\Assassin''s Creed'")
    expect(script).toContain('[double]1700000000000')
    expect(script).toContain("'.bk2'")
    expect(script).toContain('GetCompressedFileSizeW')
    expect(script).toContain('ReparsePoint')
    expect(script).toContain('if ($top.depth -lt 32)')
    expect(script).toContain('$full = $true; break')
    expect(script).toContain('-and -not $lznt1')
    expect(measureFolderScript('D:\\X')).toContain('[double]0')
  })

  it('parses the result object or its JSON', () => {
    const value = {
      size: 1400005,
      onDisk: 216389,
      files: 5,
      compressedFiles: 2,
      eligible: 2,
      eligibleCompressed: 2,
      changed: null
    }
    expect(parseFolderMeasure(value)).toEqual({
      size: 1400005,
      onDisk: 216389,
      state: 'compressed'
    })
    expect(parseFolderMeasure(JSON.stringify({ ...value, changed: 3 }))?.state).toBe('partial')
    expect(parseFolderMeasure({ ...value, compressedFiles: 0 })?.state).toBe('none')
    expect(parseFolderMeasure('nope')).toBeNull()
    expect(parseFolderMeasure({ size: 1 })).toBeNull()
    expect(parseFolderMeasure([value])).toBeNull()
  })
})

describe('parseCompactDatabase', () => {
  const db = JSON.stringify([
    {
      SteamID: 10,
      GameName: 'Counter-Strike',
      Confidence: 2,
      CompressionResults: [
        { CompType: 0, BeforeBytes: 1000, AfterBytes: 600, TotalResults: 1 },
        { CompType: 3, BeforeBytes: 1000, AfterBytes: 400, TotalResults: 3 },
        { CompType: 1, BeforeBytes: 0, AfterBytes: 400, TotalResults: 9 }
      ],
      PoorlyCompressedExtensions: { '.mp3': 4739 },
      TotalFiles: 63
    },
    { SteamID: 20, CompressionResults: [] },
    {
      SteamID: 30,
      CompressionResults: [{ CompType: 1, BeforeBytes: 100, AfterBytes: 150, TotalResults: 2 }]
    },
    { GameName: 'no id', CompressionResults: [] },
    null
  ])

  it('weights the ratios by their results', () => {
    const map = parseCompactDatabase(db)
    expect(map.get('10')).toBeCloseTo(1 - (0.6 * 1 + 0.4 * 3) / 4)
    expect(map.has('20')).toBe(false)
    expect(map.get('30')).toBe(0)
    expect(map.size).toBe(2)
  })

  it('can use one algorithm only', () => {
    expect(parseCompactDatabase(db, 'lzx').get('10')).toBeCloseTo(0.6)
    expect(parseCompactDatabase(db, 'xpress8k').has('10')).toBe(false)
  })

  it('gives an empty map for other text', () => {
    expect(parseCompactDatabase('{"10":1}').size).toBe(0)
    expect(parseCompactDatabase('not json').size).toBe(0)
  })
})

describe('volume info', () => {
  it('builds and parses the script', () => {
    expect(volumeInfoScript('D:\\Games\\X')).toContain("$dir = 'D:\\Games\\X'")
    expect(volumeInfoScript('D:\\Games\\X')).toContain('FileAttributes]::Compressed')
    expect(parseVolumeInfo({ fileSystem: 'NTFS', network: false })).toEqual({
      fileSystem: 'NTFS',
      network: false,
      folderCompressed: false
    })
    expect(parseVolumeInfo('{"fileSystem":null,"network":true,"folderCompressed":true}')).toEqual({
      fileSystem: null,
      network: true,
      folderCompressed: true
    })
    expect(parseVolumeInfo(42)).toBeNull()
  })
})

describe('compressUnavailable', () => {
  const ntfs = { volumeInfo: async () => ({ fileSystem: 'NTFS', network: false }) }

  it('allows a normal NTFS game folder', async () => {
    expect(await compressUnavailable(root, ntfs)).toBeNull()
    expect(await compressUnavailable(root, { volumeInfo: async () => null })).toBeNull()
  })

  it('refuses protected, missing, root, Windows and OneDrive folders', async () => {
    expect(await compressUnavailable('C:\\Program Files\\WindowsApps\\Game_1.0', ntfs)).toMatch(
      /protected/
    )
    expect(await compressUnavailable(join(root, 'missing'), ntfs)).toMatch(/not found/)
    const drive = root.slice(0, 3)
    expect(await compressUnavailable(drive, ntfs)).toMatch(/whole drive/)
    expect(await compressUnavailable(root, { ...ntfs, windowsDir: join(root, '..') })).toMatch(
      /Windows/
    )
    const od = join(root, 'OneDrive', 'Games')
    mkdirSync(od, { recursive: true })
    expect(await compressUnavailable(od, ntfs)).toMatch(/OneDrive/)
  })

  it('refuses network and non-NTFS drives', async () => {
    expect(
      await compressUnavailable(root, {
        volumeInfo: async () => ({ fileSystem: 'NTFS', network: true })
      })
    ).toMatch(/network/)
    expect(
      await compressUnavailable(root, {
        volumeInfo: async () => ({ fileSystem: 'exFAT', network: false })
      })
    ).toBe('This drive is formatted as exFAT; Windows compression needs an NTFS drive.')
  })

  it('refuses a folder NTFS (LZNT1) compressed already', async () => {
    expect(
      await compressUnavailable(root, {
        volumeInfo: async () => ({ fileSystem: 'NTFS', network: false, folderCompressed: true })
      })
    ).toMatch(/already compressed by NTFS/)
  })

  it('treats a long-path prefix as the local folder, and only real UNC paths as network', async () => {
    const seen: string[] = []
    const deps = {
      volumeInfo: async (d: string) => {
        seen.push(d)
        return { fileSystem: 'NTFS', network: false }
      }
    }
    expect(await compressUnavailable(`\\\\?\\${root}`, deps)).toBeNull()
    expect(seen[0].toLowerCase()).toBe(root.toLowerCase())
    expect(await compressUnavailable(`\\\\?\\${root.slice(0, 3)}`, deps)).toMatch(/whole drive/)
    const io = {
      readdir: async () => [],
      stat: async () => ({ size: 0, mtimeMs: 0, isDirectory: () => true })
    }
    expect(
      await compressUnavailable('\\\\?\\UNC\\server\\share\\Games\\X', { ...deps, io })
    ).toMatch(/network/)
    expect(await compressUnavailable('\\\\server\\share\\Games\\X', { ...deps, io })).toMatch(
      /network/
    )
  })
})
