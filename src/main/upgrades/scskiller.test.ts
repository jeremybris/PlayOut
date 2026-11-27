import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checksumFor,
  compileMessage,
  compileProgress,
  compileShaders,
  disableRecorder,
  ensureScsKiller,
  latestScsKiller,
  lineSplitter,
  parseCompileLine,
  parseGameRows,
  parseGameStatus,
  scsKillerDataDir,
  scsKillerExe,
  spawnTool,
  type ScsKillerRelease,
  type ShaderResult,
  type SpawnTool
} from './scskiller'

const HASH = 'f6cf52b87d5967dbdbb15d90299a9abee70953ce74a04442d107f36d33bca9de'
const OTHER = '9eb45c6a00000000000000000000000000000000000000000000000000000000'
const BASE = 'https://github.com/BlueHeisenberg/SCSKiller/releases/download/v1.4.8/'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-scsk-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function apiRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v1.4.8',
    body: `SHA-256:\n\`\`\`\n${HASH}  SCSKiller-1.4.8-Portable.zip\n\`\`\``,
    assets: [
      { name: 'SCSKiller.zip', browser_download_url: `${BASE}SCSKiller.zip`, size: 1 },
      {
        name: 'SCSKiller-1.4.8-Portable.zip',
        browser_download_url: `${BASE}SCSKiller-1.4.8-Portable.zip`,
        size: 117544651,
        digest: `sha256:${HASH}`
      },
      { name: 'SHA256SUMS-unsigned.txt', browser_download_url: `${BASE}SHA256SUMS-unsigned.txt` }
    ],
    ...overrides
  }
}

describe('checksumFor', () => {
  it('finds a file by name or path end, case-insensitively', () => {
    const text = `${OTHER}  SCSKiller.zip\r\n${HASH} *SCSKiller/cli/scskiller.exe\n`
    expect(checksumFor(text, 'scskiller.zip')).toBe(OTHER)
    expect(checksumFor(text, 'scskiller.exe')).toBe(HASH)
    expect(checksumFor(text, 'SCSKiller-1.4.8-Portable.zip')).toBeNull()
  })
})

describe('latestScsKiller', () => {
  it('picks the portable zip with its GitHub digest', async () => {
    const r = await latestScsKiller({ fetchJson: async () => apiRelease() })
    expect(r).toEqual({
      version: '1.4.8',
      zipUrl: `${BASE}SCSKiller-1.4.8-Portable.zip`,
      sumsUrl: `${BASE}SHA256SUMS-unsigned.txt`,
      fileName: 'SCSKiller-1.4.8-Portable.zip',
      size: 117544651,
      sha256: HASH
    })
  })

  it('falls back to the release notes checksum when there is no digest', async () => {
    const release = apiRelease()
    const assets = release.assets as Record<string, unknown>[]
    delete assets[1]!.digest
    const r = await latestScsKiller({ fetchJson: async () => release })
    expect(r?.sha256).toBe(HASH)
  })

  it('returns null without a portable zip or for a download outside the project', async () => {
    expect(await latestScsKiller({ fetchJson: async () => apiRelease({ assets: [] }) })).toBeNull()
    const release = apiRelease()
    ;(release.assets as Record<string, unknown>[])[1]!.browser_download_url =
      'https://example.com/SCSKiller-1.4.8-Portable.zip'
    expect(await latestScsKiller({ fetchJson: async () => release })).toBeNull()
    expect(await latestScsKiller({ fetchJson: async () => null })).toBeNull()
  })
})

describe('ensureScsKiller', () => {
  const release: ScsKillerRelease = {
    version: '1.4.8',
    zipUrl: `${BASE}SCSKiller-1.4.8-Portable.zip`,
    sumsUrl: `${BASE}SHA256SUMS-unsigned.txt`,
    fileName: 'SCSKiller-1.4.8-Portable.zip',
    size: 10,
    sha256: HASH
  }

  function fakes(options: { sums?: string; actual?: string; layout?: boolean } = {}): {
    downloaded: { sha256?: string; dir: string }[]
    deps: Parameters<typeof ensureScsKiller>[2] & { download: ReturnType<typeof vi.fn> }
  } {
    const downloaded: { sha256?: string; dir: string }[] = []
    return {
      downloaded,
      deps: {
        fetchText: vi.fn(async () => options.sums ?? `${OTHER}  SCSKiller.zip\n`),
        download: vi.fn(async (d: { fileName: string; sha256?: string }, into: string) => {
          downloaded.push({ sha256: d.sha256, dir: into })
          await fs.mkdir(into, { recursive: true })
          const file = join(into, d.fileName)
          await fs.writeFile(file, 'zip')
          return file
        }),
        sha256: vi.fn(async () => options.actual ?? HASH),
        extractZip: vi.fn(async (_zip: string, dest: string) => {
          if (options.layout === false) {
            await fs.mkdir(join(dest, 'SCSKiller', 'cli'), { recursive: true })
            return
          }
          await fs.mkdir(join(dest, 'current', 'cli'), { recursive: true })
          await fs.mkdir(join(dest, 'current', 'native'), { recursive: true })
          await fs.writeFile(join(dest, 'current', 'cli', 'scskiller.exe'), 'exe')
          await fs.writeFile(join(dest, '.portable'), '')
        })
      }
    }
  }

  it('downloads, checks and unpacks the portable build as released', async () => {
    const { deps, downloaded } = fakes()
    const exe = await ensureScsKiller(release, dir, deps)
    expect(exe).toBe(scsKillerExe(join(dir, 'SCSKiller')))
    expect(await fs.readFile(exe, 'utf8')).toBe('exe')
    expect(await fs.stat(join(dir, 'SCSKiller', 'current', 'native'))).toBeTruthy()
    expect(await fs.stat(join(dir, 'SCSKiller', '.portable'))).toBeTruthy()
    expect(downloaded[0]!.sha256).toBe(HASH)
    // The download staging folder is cleaned up.
    expect((await fs.readdir(dir)).sort()).toEqual(['SCSKiller'])
    // A second call with the same version does nothing.
    await ensureScsKiller(release, dir, deps)
    expect(deps.download).toHaveBeenCalledTimes(1)
  })

  it('runs two calls at once one after the other, so they never share the staging folders', async () => {
    const { deps } = fakes()
    let active = 0
    let most = 0
    const download = deps.download.getMockImplementation() as (...args: unknown[]) => unknown
    deps.download.mockImplementation(async (...args: unknown[]) => {
      active++
      most = Math.max(most, active)
      // Long enough for a second call to reach its download if nothing kept them apart.
      await new Promise((r) => setTimeout(r, 30))
      try {
        return await download(...args)
      } finally {
        active--
      }
    })
    const [a, b] = await Promise.all([
      ensureScsKiller(release, dir, deps),
      ensureScsKiller(release, dir, deps)
    ])
    expect(a).toBe(b)
    expect(most).toBe(1)
    // The second call found the version the first one put in.
    expect(deps.download).toHaveBeenCalledTimes(1)
    expect((await fs.readdir(dir)).sort()).toEqual(['SCSKiller'])
  })

  it('uses SHA256SUMS-unsigned.txt when it lists the zip', async () => {
    const { deps, downloaded } = fakes({
      sums: `${HASH}  SCSKiller-1.4.8-Portable.zip\n`
    })
    await ensureScsKiller({ ...release, sha256: null }, dir, deps)
    expect(downloaded[0]!.sha256).toBe(HASH)
  })

  it('refuses when the published checksums disagree or are missing', async () => {
    await expect(
      ensureScsKiller(release, dir, fakes({ sums: `${OTHER}  SCSKiller-1.4.8-Portable.zip` }).deps)
    ).rejects.toThrow(/disagree/)
    await expect(ensureScsKiller({ ...release, sha256: null }, dir, fakes().deps)).rejects.toThrow(
      /no checksum/
    )
  })

  it('refuses a zip whose hash does not match and leaves nothing behind', async () => {
    await expect(ensureScsKiller(release, dir, fakes({ actual: OTHER }).deps)).rejects.toThrow(
      /checksum/
    )
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('refuses a zip that is not the portable layout', async () => {
    await expect(ensureScsKiller(release, dir, fakes({ layout: false }).deps)).rejects.toThrow(
      /portable build/
    )
  })

  it("keeps SCSKiller's data folder across an update", async () => {
    const { deps } = fakes()
    await ensureScsKiller({ ...release, version: '1.4.7' }, dir, deps)
    await fs.mkdir(join(dir, 'SCSKiller', 'data'))
    await fs.writeFile(join(dir, 'SCSKiller', 'data', 'settings.json'), '{"RecordAllGames":false}')
    await ensureScsKiller(release, dir, deps)
    expect(await fs.readFile(join(dir, 'SCSKiller', 'data', 'settings.json'), 'utf8')).toBe(
      '{"RecordAllGames":false}'
    )
    expect(deps.download).toHaveBeenCalledTimes(2)
  })

  /** Installs 1.4.7 with a data folder, then fails the rename `fails` picks during the 1.4.8 update. */
  async function failedUpdate(fails: (from: string, to: string) => boolean): Promise<void> {
    const { deps } = fakes()
    await ensureScsKiller({ ...release, version: '1.4.7' }, dir, deps)
    await fs.mkdir(join(dir, 'SCSKiller', 'data', 'games', 'steam_10'), { recursive: true })
    await fs.writeFile(join(dir, 'SCSKiller', 'data', 'settings.json'), 'mine')
    await fs.writeFile(join(dir, 'SCSKiller', 'data', 'games', 'steam_10', 'warm.json'), 'keys')
    const realRename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (fails(String(from), String(to)))
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return realRename(from, to)
    })
    try {
      await expect(ensureScsKiller(release, dir, deps)).rejects.toThrow(/in use/)
    } finally {
      spy.mockRestore()
    }
    // The old install is back with all of SCSKiller's data, nothing is left half done.
    const root = join(dir, 'SCSKiller')
    expect(await fs.readFile(join(root, 'data', 'settings.json'), 'utf8')).toBe('mine')
    expect(await fs.readFile(join(root, 'data', 'games', 'steam_10', 'warm.json'), 'utf8')).toBe(
      'keys'
    )
    expect(await fs.readFile(join(root, '.playout-version'), 'utf8')).toBe('1.4.7')
    expect(await fs.readFile(scsKillerExe(root), 'utf8')).toBe('exe')
    expect((await fs.readdir(dir)).sort()).toEqual(['SCSKiller'])
  }

  it('keeps the old install and its data when the install folder is locked', async () => {
    await failedUpdate((from) => from === join(dir, 'SCSKiller'))
  })

  it('puts the old install back when the new build cannot be moved in', async () => {
    await failedUpdate((from) => from === join(dir, 'SCSKiller.new'))
  })

  it('puts the old install back when the data folder cannot be moved over', async () => {
    await failedUpdate((from) => from === join(dir, 'SCSKiller.old', 'data'))
  })

  it('finishes a swap an earlier run left half done', async () => {
    const old = join(dir, 'SCSKiller.old')
    await fs.mkdir(join(old, 'current', 'cli'), { recursive: true })
    await fs.mkdir(join(old, 'data'), { recursive: true })
    await fs.writeFile(join(old, 'current', 'cli', 'scskiller.exe'), 'exe')
    await fs.writeFile(join(old, 'data', 'settings.json'), 'mine')
    await fs.writeFile(join(old, '.playout-version'), '1.4.8')
    const { deps } = fakes()
    const exe = await ensureScsKiller(release, dir, deps)
    expect(deps.download).not.toHaveBeenCalled()
    expect(await fs.readFile(exe, 'utf8')).toBe('exe')
    expect(await fs.readFile(join(dir, 'SCSKiller', 'data', 'settings.json'), 'utf8')).toBe('mine')
    expect(await fs.readdir(dir)).toEqual(['SCSKiller'])
  })

  it('moves data left in the old folder into the new install', async () => {
    const { deps } = fakes()
    await ensureScsKiller(release, dir, deps)
    const old = join(dir, 'SCSKiller.old')
    await fs.mkdir(join(old, 'data'), { recursive: true })
    await fs.writeFile(join(old, 'data', 'settings.json'), 'mine')
    await ensureScsKiller(release, dir, deps)
    expect(await fs.readFile(join(dir, 'SCSKiller', 'data', 'settings.json'), 'utf8')).toBe('mine')
    expect(await fs.readdir(dir)).toEqual(['SCSKiller'])
  })

  it('installs on the GitHub checksum when SHA256SUMS-unsigned.txt cannot be fetched', async () => {
    const { deps, downloaded } = fakes()
    deps.fetchText = vi.fn(async () => {
      throw new Error('HTTP 404')
    })
    await ensureScsKiller(release, dir, deps)
    expect(downloaded[0]!.sha256).toBe(HASH)
    await expect(
      ensureScsKiller({ ...release, sha256: null }, join(dir, 'x'), deps)
    ).rejects.toThrow(/404/)
  })
})

describe('disableRecorder', () => {
  it('patches only the recorder and welcome switches', async () => {
    const file = join(dir, 'settings.json')
    await fs.writeFile(file, '\uFEFF{"RecordAllGames": true, "Threads": 8, "Priority": "Normal"}')
    await disableRecorder(dir)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      RecordAllGames: false,
      Threads: 8,
      Priority: 'Normal',
      WelcomeSeen: true
    })
  })

  it('leaves a missing or unreadable file alone', async () => {
    await disableRecorder(dir)
    expect(await fs.readdir(dir)).toEqual([])
    await fs.writeFile(join(dir, 'settings.json'), '{broken')
    await disableRecorder(dir)
    expect(await fs.readFile(join(dir, 'settings.json'), 'utf8')).toBe('{broken')
  })

  it('does not rewrite settings that are already right', async () => {
    const writeFile = vi.fn(async () => undefined)
    await disableRecorder('x', {
      readFile: async () => '{"RecordAllGames":false,"WelcomeSeen":true}',
      writeFile
    })
    expect(writeFile).not.toHaveBeenCalled()
  })
})

describe('compile output', () => {
  it('parses progress lines', () => {
    expect(parseCompileLine('21:05:30 steam:2909400 Warming 15234/80211 (3 failed) 812/s')).toEqual(
      {
        gameId: 'steam:2909400',
        stage: 'Warming',
        done: 15234,
        total: 80211,
        percent: null,
        failed: 3,
        note: null
      }
    )
    const planning = parseCompileLine('21:04:11 steam:1 Planning 42.0% 420/1000 pipelines')!
    expect(planning.percent).toBe(42)
    expect(compileProgress(planning)).toBeCloseTo(0.05 + 0.1 * 0.42)
    const merging = parseCompileLine(
      "21:04:11 steam:1 Merging: Handing the compile to the game's cache, 50%, 1/2 MB, 0:10 left"
    )!
    expect(merging.percent).toBe(50)
    expect(compileMessage(merging)).toBe("Handing the shaders to the game's cache (50%)")
    expect(parseCompileLine('waiting until the PC has been idle for 2 min')).toBeNull()
    expect(parseCompileLine('21:04:11 steam:1 Bogus 1/2')).toBeNull()
  })

  it('writes plain messages', () => {
    const warm = parseCompileLine('21:05:30 steam:1 Warming 15234/80211 (3 failed) 812/s')!
    expect(compileMessage(warm)).toBe('Compiling shaders: 15,234 of 80,211, 3 failed')
    const done = parseCompileLine('21:12:02 steam:1 Done 80211/80211 (0 failed) 0/s - counts')!
    expect(compileMessage(done)).toBe('Precompiled 80,211 shaders')
    expect(compileProgress(done)).toBe(1)
    const paused = parseCompileLine('21:12:02 steam:1 Paused - paused while Foo is running')!
    expect(compileMessage(paused)).toBe('Paused while Foo is running')
    expect(compileProgress(paused)).toBeNull()
    const failed = parseCompileLine('21:12:02 steam:1 Failed - out of memory')!
    expect(compileMessage(failed)).toBe('Failed: out of memory')
  })

  it('parses status blocks and rows', () => {
    expect(
      parseGameStatus([
        'Game (manual:abc, manual)',
        '  install    D:\\Games\\Game',
        '  status     Ready: can compile from the files'
      ])
    ).toEqual({ install: 'D:\\Games\\Game', status: 'Ready', reason: 'can compile from the files' })
    expect(
      parseGameRows([
        'GPU: NVIDIA GeForce RTX 4070, driver 561.56 (nv-2)',
        'Ready               steam:2909400            FINAL FANTASY VII REBIRTH  [known stutter: high]  - fine'
      ])
    ).toEqual([{ status: 'Ready', id: 'steam:2909400', name: 'FINAL FANTASY VII REBIRTH' }])
  })
})

/** A fake SCSKiller: answers each command from a table; compile streams its lines. */
function fakeTool(
  answers: Record<
    string,
    { code?: number | null; stdout?: string[]; stderr?: string[]; hang?: boolean }
  >,
  onRun?: (args: string[]) => Promise<void> | void
): { spawn: SpawnTool; calls: string[][]; killed: string[][] } {
  const calls: string[][] = []
  const killed: string[][] = []
  const spawn: SpawnTool = (_file, args, options) => {
    calls.push(args)
    const answer = answers[args.join(' ')] ?? answers[args[0]!] ?? { code: 0 }
    let release: (code: number | null) => void = () => undefined
    const exited = new Promise<number | null>((r) => (release = r))
    void (async () => {
      await onRun?.(args)
      for (const line of answer.stdout ?? []) options.onLine(line, 'stdout')
      for (const line of answer.stderr ?? []) options.onLine(line, 'stderr')
      if (!answer.hang) release(answer.code ?? 0)
    })()
    return {
      exited,
      killTree() {
        killed.push(args)
        release(null)
      }
    }
  }
  return { spawn, calls, killed }
}

describe('compileShaders', () => {
  let exe: string
  beforeEach(async () => {
    exe = scsKillerExe(join(dir, 'SCSKiller'))
  })
  const gpu = 'GPU: NVIDIA GeForce RTX 4070, driver 561.56 (nv-2)'
  const ready = { stdout: ['Game (steam:10, steam)', '  status     Ready: fine'] }

  it('compiles a Steam game by appid with the recorder off first', async () => {
    const data = scsKillerDataDir(exe)
    let recorderAtCompile: unknown
    const tool = fakeTool(
      {
        scan: { stdout: [gpu] },
        'status steam:10': ready,
        'compile steam:10': {
          stdout: [
            '21:04:11 steam:10 Planning 50.0% 5/10 step',
            '21:05:30 steam:10 Warming 50/100 (1 failed) 812/s',
            '21:05:31 steam:10 Paused - paused while Other is running',
            '21:12:02 steam:10 Done 100/100 (1 failed) 0/s'
          ]
        }
      },
      async (args) => {
        if (args[0] === 'scan') {
          await fs.mkdir(data, { recursive: true })
          await fs.writeFile(join(data, 'settings.json'), '{"RecordAllGames":true}')
        }
        if (args[0] === 'compile')
          recorderAtCompile = JSON.parse(
            await fs.readFile(join(data, 'settings.json'), 'utf8')
          ).RecordAllGames
      }
    )
    const progress: { progress: number | null; message: string }[] = []
    const r = await compileShaders(
      exe,
      { steamAppId: '10', installDir: 'D:\\G', title: 'Game' },
      (p) => progress.push(p),
      new AbortController().signal,
      { spawn: tool.spawn }
    )
    expect(r).toEqual({ ok: true, message: 'Precompiled 100 shaders (1 failed)' })
    expect(recorderAtCompile).toBe(false)
    expect(tool.calls.map((c) => c.join(' '))).toEqual([
      'scan',
      'status steam:10',
      'compile steam:10'
    ])
    const values = progress.map((p) => p.progress).filter((p): p is number => p != null)
    expect(values).toEqual([...values].sort((a, b) => a - b))
    expect(values[values.length - 1]).toBe(1)
    expect(progress.some((p) => p.message === 'Paused while Other is running')).toBe(true)
  })

  it('reports an unsupported graphics card', async () => {
    const tool = fakeTool({ scan: { stdout: ['GPU: Intel Arc, driver 1 (unsupported)'] } })
    const r = await compileShaders(
      exe,
      { steamAppId: '10', installDir: 'D:\\G', title: 'Game' },
      () => undefined,
      new AbortController().signal,
      { spawn: tool.spawn }
    )
    expect(r.unsupported).toBe(true)
    expect(tool.calls).toHaveLength(1)
  })

  it('maps unsupported statuses and unknown games', async () => {
    const run = (answers: Parameters<typeof fakeTool>[0]): Promise<ShaderResult> =>
      compileShaders(
        exe,
        { steamAppId: '10', installDir: 'D:\\G', title: 'Game' },
        () => undefined,
        new AbortController().signal,
        { spawn: fakeTool({ scan: { stdout: [gpu] }, ...answers }).spawn }
      )
    expect(
      await run({
        'status steam:10': { stdout: ['  status     Unsupported: encrypted game files'] }
      })
    ).toEqual({ ok: false, unsupported: true, message: 'encrypted game files' })
    expect(
      await run({ 'status steam:10': { code: 1, stderr: ["error: no game matches 'steam:10'"] } })
    ).toEqual({ ok: false, unsupported: true, message: "no game matches 'steam:10'" })
    expect(
      await run({ 'status steam:10': { stdout: ['  status     NeedsSteamStart: start it once'] } })
    ).toEqual({ ok: false, message: 'start it once' })
    expect(
      await run({ 'status steam:10': { stdout: ['  status     Warmed: done'] } })
    ).toMatchObject({ ok: true })
    expect(
      await run({
        'status steam:10': ready,
        'compile steam:10': { code: 1, stderr: ["error: Game: 32-bit games aren't supported yet"] }
      })
    ).toEqual({ ok: false, unsupported: true, message: "Game: 32-bit games aren't supported yet" })
    expect(
      await run({
        'status steam:10': ready,
        'compile steam:10': { code: 1, stdout: ['21:00:00 steam:10 Failed - disk full'] }
      })
    ).toEqual({ ok: false, message: 'Failed: disk full' })
  })

  it('adds a non-Steam game by its exe', async () => {
    const tool = fakeTool({
      scan: { stdout: [gpu] },
      add: { stdout: ['added: manual:0123456789abcdef  Game  D:\\G\\game.exe'] },
      'status manual:0123456789abcdef': ready,
      'compile manual:0123456789abcdef': { stdout: ['nothing to compile'] }
    })
    const r = await compileShaders(
      exe,
      { installDir: 'D:\\G', title: 'Game', exePath: 'D:\\G\\game.exe' },
      () => undefined,
      new AbortController().signal,
      { spawn: tool.spawn }
    )
    expect(tool.calls[1]).toEqual(['add', 'D:\\G\\game.exe', 'D:\\G'])
    expect(r).toEqual({ ok: true, message: 'Nothing left to compile' })
  })

  it('finds another store game by name and install folder', async () => {
    const tool = fakeTool({
      scan: {
        stdout: [
          gpu,
          'Ready               epic:Other               The Game™  - fine',
          'Ready               epic:Mine                The Game  [cache 1.2 GB]  - fine'
        ]
      },
      'status epic:Other': { stdout: ['  install    E:\\Elsewhere'] },
      'status epic:Mine': {
        stdout: ['  install    D:\\Games\\The Game\\', '  status     Ready: ok']
      },
      'compile epic:Mine': { stdout: [] }
    })
    const r = await compileShaders(
      exe,
      { installDir: 'D:\\Games\\The Game', title: 'The Game' },
      () => undefined,
      new AbortController().signal,
      { spawn: tool.spawn }
    )
    expect(r.ok).toBe(true)
    expect(tool.calls.at(-1)).toEqual(['compile', 'epic:Mine'])
  })

  it('keeps a store game a store lists instead of adding it by its exe', async () => {
    const tool = fakeTool({
      scan: { stdout: [gpu, 'Ready               epic:X                   The Game  - fine'] },
      'status epic:X': { stdout: ['  install    D:\\G', '  status     Ready: ok'] },
      'compile epic:X': { stdout: [] }
    })
    const r = await compileShaders(
      exe,
      { installDir: 'D:\\G', title: 'The Game', exePath: 'D:\\G\\game.exe' },
      () => undefined,
      new AbortController().signal,
      { spawn: tool.spawn }
    )
    expect(r.ok).toBe(true)
    expect(tool.calls.some((c) => c[0] === 'add')).toBe(false)
    expect(tool.calls.at(-1)).toEqual(['compile', 'epic:X'])
  })

  it('does not call a game unsupported from a plain log line', async () => {
    const tool = fakeTool({
      scan: { stdout: [gpu] },
      'status steam:10': ready,
      'compile steam:10': { code: 1, stderr: ['  skipping unsupported pipeline 12'] }
    })
    const r = await compileShaders(
      exe,
      { steamAppId: '10', installDir: 'D:\\G', title: 'Game' },
      () => undefined,
      new AbortController().signal,
      { spawn: tool.spawn }
    )
    expect(r).toEqual({
      ok: false,
      message: 'The compile failed: skipping unsupported pipeline 12'
    })
  })

  it('writes the recorder switch through the settings deps and explains a failed write', async () => {
    const writes: string[] = []
    const io = {
      readFile: async (): Promise<string> => '{"RecordAllGames":true}',
      writeFile: async (_path: string, text: string): Promise<void> => {
        writes.push(text)
      }
    }
    const tool = fakeTool({ scan: { stdout: [gpu] }, 'status steam:10': ready })
    const target = { steamAppId: '10', installDir: 'D:\\G', title: 'Game' }
    const signal = new AbortController().signal
    expect(
      (
        await compileShaders(exe, target, () => undefined, signal, {
          spawn: tool.spawn,
          settingsIo: io
        })
      ).ok
    ).toBe(true)
    expect(JSON.parse(writes[0]!).RecordAllGames).toBe(false)
    await expect(fs.access(scsKillerDataDir(exe))).rejects.toThrow()

    const locked = {
      readFile: io.readFile,
      writeFile: async (): Promise<void> => {
        throw new Error('EBUSY: resource busy or locked')
      }
    }
    const tool2 = fakeTool({ scan: { stdout: [gpu] } })
    const r = await compileShaders(exe, target, () => undefined, signal, {
      spawn: tool2.spawn,
      settingsIo: locked
    })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/recorder off.*close SCSKiller/)
    expect(tool2.calls.map((c) => c[0])).toEqual(['scan'])
  })

  it('returns Cancelled even when the killed tree never ends', async () => {
    const controller = new AbortController()
    const killed: string[][] = []
    const spawn: SpawnTool = (_file, args, options) => {
      if (args[0] === 'scan') options.onLine(gpu, 'stdout')
      if (args[0] === 'status') for (const l of ready.stdout) options.onLine(l, 'stdout')
      if (args[0] === 'compile') setTimeout(() => controller.abort(), 0)
      return {
        exited:
          args[0] === 'compile' ? new Promise<number | null>(() => undefined) : Promise.resolve(0),
        killTree: () => killed.push(args)
      }
    }
    const r = await compileShaders(
      exe,
      { steamAppId: '10', installDir: 'D:\\G', title: 'Game' },
      () => undefined,
      controller.signal,
      {
        spawn,
        killWaitMs: 10,
        settingsIo: { readFile: async () => null, writeFile: async () => undefined }
      }
    )
    expect(r).toEqual({ ok: false, message: 'Cancelled' })
    expect(killed).toEqual([['compile', 'steam:10']])
  })

  it("says so when SCSKiller doesn't list the game", async () => {
    const tool = fakeTool({ scan: { stdout: [gpu] } })
    const r = await compileShaders(
      exe,
      { installDir: 'D:\\G', title: 'Missing' },
      () => undefined,
      new AbortController().signal,
      { spawn: tool.spawn }
    )
    expect(r).toEqual({ ok: false, unsupported: true, message: "SCSKiller doesn't list this game" })
  })

  it('kills the process tree when aborted', async () => {
    const controller = new AbortController()
    const tool = fakeTool({
      scan: { stdout: [gpu] },
      'status steam:10': ready,
      'compile steam:10': { stdout: ['21:05:30 steam:10 Warming 1/100 (0 failed) 1/s'], hang: true }
    })
    const r = await compileShaders(
      exe,
      { steamAppId: '10', installDir: 'D:\\G', title: 'Game' },
      (p) => {
        if (p.message.startsWith('Compiling')) controller.abort()
      },
      controller.signal,
      { spawn: tool.spawn }
    )
    expect(r).toEqual({ ok: false, message: 'Cancelled' })
    expect(tool.killed).toEqual([['compile', 'steam:10']])
  })

  it('does nothing when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = fakeTool({})
    const r = await compileShaders(
      exe,
      { steamAppId: '10', installDir: 'D:\\G', title: 'Game' },
      () => undefined,
      controller.signal,
      { spawn: tool.spawn }
    )
    expect(r).toEqual({ ok: false, message: 'Cancelled' })
    expect(tool.calls).toEqual([])
  })
})

describe('lineSplitter', () => {
  it('splits CRLF, LF and CR across chunks and decodes UTF-8', () => {
    const lines: string[] = []
    const s = lineSplitter((l) => lines.push(l))
    const bytes = Buffer.from('a\r\nb\rcé\nlast', 'utf8')
    for (const b of bytes) s.push(Buffer.from([b]))
    s.end()
    expect(lines).toEqual(['a', 'b', 'cé', 'last'])
  })
})

describe('spawnTool', () => {
  it('streams lines and the exit code', async () => {
    const lines: string[] = []
    const proc = spawnTool(
      process.execPath,
      ['-e', 'console.log("one");console.error("two");process.exit(3)'],
      { cwd: dir, onLine: (l, s) => lines.push(`${s}:${l}`) }
    )
    expect(await proc.exited).toBe(3)
    expect(lines.sort()).toEqual(['stderr:two', 'stdout:one'])
  })

  it('kills a running program', async () => {
    const proc = spawnTool(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: dir,
      onLine: () => undefined
    })
    proc.killTree()
    expect(await proc.exited).not.toBe(0)
  })
})
