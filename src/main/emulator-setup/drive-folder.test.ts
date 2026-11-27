import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import type { HttpDeps } from './download'
import {
  downloadDriveFolder,
  listDriveFolder,
  safeSegment,
  type DriveFolderProgress,
  type DriveFolderSource
} from './drive-folder'

const warnings: string[] = []
const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: (m: string) => void warnings.push(m),
  error: () => {}
}

interface Entry {
  id: string
  name: string
  folder?: boolean
}

/** A fake public Drive: folder id -> entries, file id -> content. Answers like embeddedfolderview / usercontent. */
function fakeDrive(
  folders: Record<string, Entry[]>,
  files: Record<string, string>,
  override?: (url: string, n: number) => Response | null
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    const forced = override?.(url, calls.filter((c) => c === url).length)
    if (forced) return forced
    const id = new URL(url).searchParams.get('id') ?? ''
    if (url.startsWith('https://drive.google.com/embeddedfolderview?')) {
      const entries = folders[id]
      if (!entries) return new Response('not found', { status: 404 })
      const html = entries
        .map(
          (e) =>
            `<div class="flip-entry" id="entry-${e.id}" tabindex="0" role="link"><div class="flip-entry-info">` +
            `<a href="https://drive.google.com/${e.folder ? `drive/folders/${e.id}` : `file/d/${e.id}/view?usp=drive_web`}" target="_blank">` +
            `<div aria-label="${e.folder ? 'Folder' : 'Binary'}"></div><div class="flip-entry-title">${e.name}</div></a></div></div>`
        )
        .join('')
      return new Response(`<html><div class="flip-entries">${html}</div></html>`, {
        headers: { 'content-type': 'text/html' }
      })
    }
    if (url.startsWith('https://drive.usercontent.google.com/download?')) {
      const body = files[id]
      if (body === undefined) return new Response('nope', { status: 404 })
      return new Response(body, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(Buffer.byteLength(body))
        }
      })
    }
    return new Response('?', { status: 500 })
  }
  return { fetch: fn as typeof fetch, calls }
}

const deps = (f: typeof fetch): HttpDeps => ({ fetch: f, log, retryDelayMs: 0 })

/** The RPCS3-like tree used by most tests. */
const TREE: Record<string, Entry[]> = {
  top: [
    { id: 'cfg', name: 'config', folder: true },
    { id: 'df', name: 'dev_flash', folder: true },
    { id: 'logs', name: 'log', folder: true },
    { id: 'exe', name: 'rpcs3.exe' },
    { id: 'qt', name: 'Qt6Core.dll' }
  ],
  cfg: [
    { id: 'vfs', name: 'vfs.yml' },
    { id: 'cfgyml', name: 'config.yml' }
  ],
  df: [{ id: 'vsh', name: 'vsh', folder: true }],
  vsh: [
    { id: 'mod', name: 'module', folder: true },
    // A nested folder named like a skipped top-level one is kept.
    { id: 'nlog', name: 'log', folder: true }
  ],
  mod: [{ id: 'self', name: 'vsh.self' }],
  nlog: [{ id: 'nl', name: 'keep.txt' }],
  logs: [{ id: 'l1', name: 'RPCS3.log' }]
}
const FILES: Record<string, string> = {
  exe: 'MZ-exe',
  qt: 'qt',
  vfs: '/dev_hdd0/: x\n',
  cfgyml: 'Core: {}\n',
  self: 'SCE',
  nl: 'n',
  l1: 'old log'
}
const SOURCE: DriveFolderSource = { kind: 'drive-folder', folderId: 'top', skip: ['LOG'] }

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-drive-folder-'))
  warnings.length = 0
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(join(d, e.name), r)
      else out[r] = await fs.readFile(join(d, e.name), 'utf8')
    }
  }
  await walk(root, '')
  return out
}

describe('safeSegment', () => {
  it('keeps ordinary names and makes the rest safe for Windows', () => {
    expect(safeSegment('Qt6Core.dll')).toBe('Qt6Core.dll')
    expect(safeSegment('a:b*c?.txt')).toBe('a_b_c_.txt')
    expect(safeSegment('../evil')).toBe('.._evil')
    expect(safeSegment('..\\evil')).toBe('.._evil')
    expect(safeSegment('name. ')).toBe('name')
    expect(safeSegment('CON')).toBe('_CON')
    expect(safeSegment('nul.txt')).toBe('_nul.txt')
    expect(safeSegment('console.txt')).toBe('console.txt')
    expect(safeSegment('..')).toBeNull()
    expect(safeSegment('.')).toBeNull()
    expect(safeSegment('   ')).toBeNull()
  })
})

describe('listDriveFolder', () => {
  it('walks subfolders (told apart from files by their link) and leaves out skipped top-level entries', async () => {
    const { fetch } = fakeDrive(TREE, FILES)
    const files = await listDriveFolder(SOURCE, deps(fetch))
    expect(files.map((f) => f.path.replace(/\\/g, '/')).sort()).toEqual([
      'Qt6Core.dll',
      'config/config.yml',
      'config/vfs.yml',
      'dev_flash/vsh/log/keep.txt',
      'dev_flash/vsh/module/vsh.self',
      'rpcs3.exe'
    ])
    expect(files.find((f) => f.path === 'rpcs3.exe')?.id).toBe('exe')
  })

  it('skips unusable and duplicate names, and sanitises the others', async () => {
    const { fetch } = fakeDrive(
      {
        top: [
          { id: 'a', name: '..' },
          { id: 'b', name: '../../escape.dll' },
          { id: 'c', name: 'dup.txt' },
          { id: 'd', name: 'DUP.txt' },
          { id: 'e', name: 'aux' }
        ]
      },
      {}
    )
    const files = await listDriveFolder(SOURCE, deps(fetch))
    expect(files).toEqual([
      { id: 'b', path: '.._.._escape.dll' },
      { id: 'c', path: 'dup.txt' },
      { id: 'e', path: '_aux' }
    ])
    expect(warnings.some((w) => w.includes('cannot be used'))).toBe(true)
    expect(warnings.some((w) => w.includes('second entry named DUP.txt'))).toBe(true)
  })

  it('retries a 429 or 5xx listing, and fails at once on a 404', async () => {
    const flaky = fakeDrive(TREE, FILES, (url, n) =>
      url.includes('embeddedfolderview?id=cfg') && n <= 2
        ? new Response('slow down', { status: n === 1 ? 429 : 503 })
        : null
    )
    expect(await listDriveFolder(SOURCE, deps(flaky.fetch))).toHaveLength(6)
    expect(flaky.calls.filter((c) => c.includes('id=cfg'))).toHaveLength(3)

    const missing = fakeDrive({}, {})
    await expect(listDriveFolder(SOURCE, deps(missing.fetch))).rejects.toThrow(/HTTP 404/)
    expect(missing.calls).toHaveLength(1)
  })

  it('gives up after the attempts run out', async () => {
    const down = fakeDrive(TREE, FILES, () => new Response('', { status: 500 }))
    await expect(listDriveFolder(SOURCE, deps(down.fetch), { attempts: 3 })).rejects.toThrow(
      /HTTP 500/
    )
    expect(down.calls).toHaveLength(3)
  })

  it('refuses a page that is not a folder listing (not shared publicly)', async () => {
    const signIn = fakeDrive(TREE, FILES, () => new Response('<html>Sign in</html>'))
    await expect(listDriveFolder(SOURCE, deps(signIn.fetch))).rejects.toThrow(/shared publicly/)
  })

  it('stops at the file, folder and depth caps', async () => {
    const { fetch } = fakeDrive(TREE, FILES)
    await expect(listDriveFolder(SOURCE, deps(fetch), { maxFiles: 3 })).rejects.toThrow(
      /more than 3 files/
    )
    await expect(listDriveFolder(SOURCE, deps(fetch), { maxDepth: 2 })).rejects.toThrow(
      /more than 2 folders deep/
    )
    await expect(listDriveFolder(SOURCE, deps(fetch), { maxFolders: 3 })).rejects.toThrow(
      /more than 3 folders/
    )
    // A folder that contains itself never loops: the depth cap ends it.
    const loop = fakeDrive({ top: [{ id: 'top', name: 'again', folder: true }] }, {})
    await expect(listDriveFolder(SOURCE, deps(loop.fetch))).rejects.toThrow(/deep|folders/)
  })
})

describe('downloadDriveFolder', () => {
  it('downloads the tree into the folder, reporting files done', async () => {
    const { fetch } = fakeDrive(TREE, FILES)
    const dest = join(dir, 'out')
    const progress: DriveFolderProgress[] = []
    const result = await downloadDriveFolder(SOURCE, dest, deps(fetch), (p) => progress.push(p))
    expect(result).toEqual({ files: 6, downloaded: 6 })
    expect(await tree(dest)).toEqual({
      'Qt6Core.dll': 'qt',
      'config/config.yml': 'Core: {}\n',
      'config/vfs.yml': '/dev_hdd0/: x\n',
      'dev_flash/vsh/log/keep.txt': 'n',
      'dev_flash/vsh/module/vsh.self': 'SCE',
      'rpcs3.exe': 'MZ-exe'
    })
    expect(progress.at(-1)).toMatchObject({ filesDone: 6, filesTotal: 6 })
    expect(progress.at(-1)!.bytesDone).toBe(
      Object.entries(FILES)
        .filter(([id]) => id !== 'l1')
        .reduce((n, [, b]) => n + b.length, 0)
    )
  })

  it('resumes: files already there are kept, a leftover partial file is downloaded again', async () => {
    const dest = join(dir, 'out')
    await fs.mkdir(join(dest, 'config'), { recursive: true })
    await fs.writeFile(join(dest, 'rpcs3.exe'), 'MZ-exe')
    await fs.writeFile(join(dest, 'config', 'vfs.yml.playout-part'), 'half')
    const { fetch, calls } = fakeDrive(TREE, FILES)
    const result = await downloadDriveFolder(SOURCE, dest, deps(fetch))
    expect(result).toEqual({ files: 6, downloaded: 5 })
    expect(calls.some((c) => c.includes('download?id=exe'))).toBe(false)
    expect(await fs.readFile(join(dest, 'config', 'vfs.yml'), 'utf8')).toBe('/dev_hdd0/: x\n')
    expect(await fs.readdir(join(dest, 'config'))).not.toContain('vfs.yml.playout-part')
  })

  it('retries a short or refused file download, and leaves no partial file after a failure', async () => {
    const short = fakeDrive(TREE, FILES, (url, n) =>
      url.includes('download?id=qt') && n === 1
        ? new Response('q', { headers: { 'content-length': '2' } })
        : url.includes('download?id=self') && n === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '1' } })
          : null
    )
    const dest = join(dir, 'out')
    await downloadDriveFolder(SOURCE, dest, deps(short.fetch))
    expect(await fs.readFile(join(dest, 'Qt6Core.dll'), 'utf8')).toBe('qt')
    expect(await fs.readFile(join(dest, 'dev_flash', 'vsh', 'module', 'vsh.self'), 'utf8')).toBe(
      'SCE'
    )

    // Drive's download-limit page (HTML for a binary) is an error once the attempts run out.
    const limited = fakeDrive(TREE, FILES, (url) =>
      url.includes('download?id=exe')
        ? new Response('<html>quota</html>', { headers: { 'content-type': 'text/html' } })
        : null
    )
    const dest2 = join(dir, 'out2')
    await expect(
      downloadDriveFolder(SOURCE, dest2, deps(limited.fetch), undefined, { attempts: 2 })
    ).rejects.toThrow(/web page instead of the file/)
    expect(limited.calls.filter((c) => c.includes('download?id=exe'))).toHaveLength(2)
    const left = Object.keys(await tree(dest2))
    expect(left.some((p) => p.endsWith('.playout-part'))).toBe(false)
    expect(left).not.toContain('rpcs3.exe')
  })

  it('takes a compressed answer whose Content-Length is the size on the wire', async () => {
    // fetch decompresses it; the header still gives the compressed size.
    const { fetch, calls } = fakeDrive(TREE, FILES, (url) =>
      url.includes('download?id=cfgyml')
        ? new Response('Core: {}\n', {
            headers: { 'content-encoding': 'gzip', 'content-length': '3' }
          })
        : null
    )
    const dest = join(dir, 'out')
    await downloadDriveFolder(SOURCE, dest, deps(fetch), undefined, { attempts: 2 })
    expect(await fs.readFile(join(dest, 'config', 'config.yml'), 'utf8')).toBe('Core: {}\n')
    expect(calls.filter((c) => c.includes('download?id=cfgyml'))).toHaveLength(1)
  })

  it('fails for an empty folder', async () => {
    const { fetch } = fakeDrive({ top: [] }, {})
    await expect(downloadDriveFolder(SOURCE, join(dir, 'out'), deps(fetch))).rejects.toThrow(
      /empty/
    )
  })
})
