import { mkdtempSync, promises as fs, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deflateRawSync } from 'zlib'
import { extractZip, listZip, readZipEntry, safeEntryPath } from '../util/zip'
import { isToolEntry } from './tools'
import {
  createHandlerPack,
  INDEX_VERSION,
  extractedPaths,
  handlerScriptEntry,
  parseDriveListing
} from './handler-pack'
import { parseDevices, jobDevice } from './helper'

/** A minimal zip writer for tests: deflated entries (folders as names ending with "/"). */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const raw = Buffer.from(text)
    const data = name.endsWith('/') ? Buffer.alloc(0) : deflateRawSync(raw)
    const method = name.endsWith('/') ? 0 : 8
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const SCRIPT =
  'Hub.Handler.Id = "abc";\nGame.GameName = "Left 4 Dead: 2";\nGame.ExecutableName = "left4dead2.exe";\n'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'playout-coop-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('zip', () => {
  it('lists, reads and extracts entries', async () => {
    const path = join(dir, 'a.zip')
    writeFileSync(path, makeZip({ 'handler.js': SCRIPT, 'L4D2/': '', 'L4D2/sub/x.txt': 'hello' }))
    const entries = await listZip(path)
    expect(entries.map((e) => e.name)).toEqual(['handler.js', 'L4D2/', 'L4D2/sub/x.txt'])
    expect((await readZipEntry(path, entries[0]!)).toString()).toBe(SCRIPT)
    const out = await extractZip(path, join(dir, 'out'))
    expect(out).toHaveLength(2)
    expect(readFileSync(join(dir, 'out', 'L4D2', 'sub', 'x.txt'), 'utf8')).toBe('hello')
  })

  it('refuses paths that leave the folder', async () => {
    expect(safeEntryPath('../evil.dll')).toBeNull()
    expect(safeEntryPath('C:/Windows/x.dll')).toBeNull()
    expect(safeEntryPath('/abs')).toBeNull()
    expect(safeEntryPath('a/./b')).toBe(join('a', 'b'))
    const path = join(dir, 'bad.zip')
    writeFileSync(path, makeZip({ '../x.txt': 'no' }))
    await expect(extractZip(path, join(dir, 'out'))).rejects.toThrow(/unsafe/)
  })
})

describe('handler pack', () => {
  it('parses the Drive folder listing', () => {
    const html = `<div class="flip-entry" id="entry-1AbC_d-e"><a href="x"></a><div class="flip-entry-title">handler-abc-v2.nc</div></div>
<div class="flip-entry" id="entry-ZZZ"><div class="flip-entry-title">handlers.json</div></div>`
    expect(parseDriveListing(html)).toEqual([
      { id: '1AbC_d-e', name: 'handler-abc-v2.nc' },
      { id: 'ZZZ', name: 'handlers.json' }
    ])
  })

  it('finds handler.js at the root, else the shallowest script', () => {
    const e = (name: string): never => ({ name }) as never
    expect(handlerScriptEntry([e('a/b/x.js'), e('Handler.JS')])).toMatchObject({
      name: 'Handler.JS'
    })
    expect(handlerScriptEntry([e('a/b/x.js'), e('a/y.js')])).toMatchObject({ name: 'a/y.js' })
  })

  it("downloads, indexes and extracts a handler Nucleus's way", async () => {
    const zip = makeZip({
      'handler.js': SCRIPT,
      'Left4Dead2/': '',
      'Left4Dead2/pak01.vpk': 'vpk',
      'readme.txt': 'x'
    })
    const listing = `<div id="entry-F1"><div class="flip-entry-title">handler-abc-v2.nc</div></div>`
    const fake = (async (url: string) => {
      if (url.includes('embeddedfolderview')) return new Response(listing)
      if (url.includes('id=F1')) return new Response(new Uint8Array(zip))
      return new Response('nope', { status: 404 })
    }) as typeof fetch
    const log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    }
    const pack = createHandlerPack({ coopDir: dir, log: log as never, fetch: fake })
    expect(await pack.downloadAll()).toEqual({ downloaded: 1, total: 1, failed: 0 })
    const [entry] = await pack.index()
    expect(entry).toMatchObject({
      archive: 'handler-abc-v2.nc',
      gameName: 'Left 4 Dead: 2',
      exeName: 'left4dead2.exe',
      hubId: 'abc'
    })
    // Nothing is extracted by the download.
    await expect(fs.access(join(dir, 'engine'))).rejects.toThrow()

    const handlers = join(dir, 'engine', 'handlers')
    const script = await pack.extract(entry!, handlers)
    const paths = extractedPaths('Left 4 Dead: 2', handlers)
    expect(script).toBe(paths.script)
    expect(script.endsWith('Left 4 Dead 2.js')).toBe(true)
    expect(readFileSync(join(paths.folder, 'pak01.vpk'), 'utf8')).toBe('vpk')
    await expect(fs.access(join(paths.folder, 'readme.txt'))).rejects.toThrow()
    // A second download skips what is there.
    expect((await pack.downloadAll()).downloaded).toBe(0)
  })

  it('reads the archives again when the index was built by an older reader', async () => {
    const listing = `<div id="entry-F1"><div class="flip-entry-title">handler-abc-v2.nc</div></div>`
    const fake = (async (url: string) => {
      if (url.includes('embeddedfolderview')) return new Response(listing)
      return new Response('nope', { status: 404 })
    }) as typeof fetch
    const log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    }
    await fs.mkdir(join(dir, 'archive'), { recursive: true })
    writeFileSync(join(dir, 'archive', 'handler-abc-v2.nc'), makeZip({ 'handler.js': SCRIPT }))
    // An index from before INDEX_VERSION existed, whose entry misses what the script says.
    const stale = { archive: 'handler-abc-v2.nc', gameName: 'Left 4 Dead: 2', exeNames: [] }
    const indexPath = join(dir, 'handlers-index.json')
    writeFileSync(
      indexPath,
      JSON.stringify({ builtAt: '2026-01-01T00:00:00.000Z', handlers: [stale] })
    )

    const pack = createHandlerPack({ coopDir: dir, log: log as never, fetch: fake })
    // Still usable until it is rebuilt, but due for a rebuild at the next automatic check.
    expect(await pack.index()).toHaveLength(1)
    expect(await pack.builtAt()).toBe('')
    expect(await pack.downloadAll()).toEqual({ downloaded: 0, total: 1, failed: 0 })
    expect((await pack.index())[0]).toMatchObject({ exeName: 'left4dead2.exe', hubId: 'abc' })
    expect(await pack.builtAt()).not.toBe('')
    const written = JSON.parse(readFileSync(indexPath, 'utf8')) as { version?: number }
    expect(written.version).toBe(INDEX_VERSION)

    // An index of this version keeps its entries (the archives are not read again).
    const kept = { ...(await pack.index())[0]!, exeName: 'kept.exe' }
    writeFileSync(indexPath, JSON.stringify({ ...written, handlers: [kept] }))
    const again = createHandlerPack({ coopDir: dir, log: log as never, fetch: fake })
    await again.downloadAll()
    expect((await again.index())[0]).toMatchObject({ exeName: 'kept.exe' })
  })
})

describe('tools', () => {
  it('extracts the tools, not the Nucleus app', () => {
    expect(isToolEntry('utils/GoldbergEmu/x64/steam_api64.dll')).toBe(true)
    expect(isToolEntry('Nucleus.Hook64.dll')).toBe(true)
    expect(isToolEntry('ProtoInputHooks64.dll')).toBe(true)
    expect(isToolEntry('NucleusCoop.exe')).toBe(false)
    expect(isToolEntry('Updater.exe')).toBe(false)
    expect(isToolEntry('webview/x.dll')).toBe(false)
    expect(isToolEntry('gui/theme/a.png')).toBe(false)
    expect(isToolEntry('Nucleus.Gaming.dll')).toBe(false)
  })
})

describe('helper', () => {
  it('reads the devices answer', () => {
    const { devices, screens } = parseDevices({
      gamepads: [
        { kind: 'xinput', index: 1, name: 'Xbox' },
        { kind: 'dinput', guid: '{g}', name: 'DS4' },
        { kind: 'xinput', index: 2, connected: false }
      ],
      keyboards: [{}],
      screens: [{ index: 0, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
    })
    expect(devices.map((d) => d.id)).toEqual(['xinput:1', 'dinput:{g}', 'kb'])
    expect(screens).toHaveLength(1)
    expect(jobDevice(devices[0])).toEqual({ kind: 'xinput', index: 1 })
    expect(jobDevice(devices[2])).toEqual({
      kind: 'keyboard',
      keyboardHandle: '0x0',
      mouseHandle: '0x0'
    })
  })
})
