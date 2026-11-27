import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import {
  battlenetProvider,
  buildScannedGame,
  clientDirFromUninstallEntries,
  detectFromProductDb,
  detectFromUninstallEntries,
  findProductByUid,
  loadProductTable,
  parseProductDb,
  productDbType,
  type BattlenetProduct,
  type UninstallEntry
} from './battlenet'

const RESOURCES = resolve('resources/systems')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const verbose = { debug: () => {}, info: console.info, warn: console.warn, error: console.error }

function entry(partial: Partial<UninstallEntry>): UninstallEntry {
  return {
    keyName: partial.keyName ?? 'key',
    hive: 'HKLM',
    view: 'x86',
    displayName: '',
    installLocation: '',
    uninstallString: '',
    publisher: '',
    displayIcon: '',
    displayVersion: '',
    ...partial
  }
}

const TABLE: BattlenetProduct[] = [
  {
    code: 'WoW',
    uid: 'wow',
    name: 'World of Warcraft',
    type: 'default',
    executables: ['_retail_\\Wow.exe'],
    processNames: ['Wow', 'WowClassic']
  },
  {
    code: 'Pro',
    uid: 'prometheus',
    name: 'Overwatch 2',
    type: 'default',
    processNames: ['Overwatch']
  },
  {
    code: 'D2',
    uid: 'Diablo II',
    name: 'Diablo II',
    type: 'classic',
    classicExecutable: 'Diablo II.exe',
    processNames: ['Diablo II', 'Game']
  },
  {
    code: 'D2X',
    uid: 'Diablo II',
    name: 'Diablo II: Lord of Destruction',
    type: 'classic',
    classicExecutable: 'Diablo II.exe',
    processNames: ['Diablo II', 'Game']
  },
  { code: 'W1R', uid: 'w1r', name: 'Warcraft: Remastered', type: 'default', processNames: [] },
  { code: 'W1', uid: 'w1', name: 'Warcraft: Orcs & Humans', type: 'default' }
]

describe('product.db parsing', () => {
  it('decodes product installs from a protobuf fixture', () => {
    const type = productDbType()
    const fixture = type
      .encode(
        type.create({
          product_installs: [
            {
              uid: 'wow',
              product_code: 'WoW',
              settings: { install_path: 'C:/Program Files (x86)/World of Warcraft/' },
              cached_product_state: { base_product_state: { installed: true, playable: true } }
            },
            {
              uid: 'battle.net',
              product_code: 'bna',
              settings: { install_path: 'C:/Program Files (x86)/Battle.net' }
            },
            { uid: 'agent', product_code: 'agent' }
          ],
          active_processes: [{ process_name: 'Agent.exe', pid: 1234, uri: ['x'] }],
          product_configs: [{ product_code: 'WoW', metadata_hash: 'abc', timestamp: '1' }],
          download_settings: { download_limit: 0, backfill_limit: 0 }
        })
      )
      .finish()
    const installs = parseProductDb(fixture)
    expect(installs).toEqual([
      {
        uid: 'wow',
        productCode: 'WoW',
        installPath: 'C:\\Program Files (x86)\\World of Warcraft',
        installed: true,
        playable: true
      },
      {
        uid: 'battle.net',
        productCode: 'bna',
        installPath: 'C:\\Program Files (x86)\\Battle.net',
        installed: undefined,
        playable: undefined
      },
      {
        uid: 'agent',
        productCode: 'agent',
        installPath: '',
        installed: undefined,
        playable: undefined
      }
    ])
  })

  it('throws on garbage so the caller can log and skip', () => {
    expect(() => parseProductDb(new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff]))).toThrow()
  })
})

describe('product table', () => {
  it('loads resources/systems/battlenet-products.json', async () => {
    const products = await loadProductTable(RESOURCES, log)
    expect(products.length).toBe(35)
    expect(new Set(products.map((p) => p.code)).size).toBe(35)
    for (const p of products) {
      expect(p.name.length).toBeGreaterThan(0)
      if (p.type === 'classic') expect(p.classicExecutable).toMatch(/\.exe$/)
      expect(Array.isArray(p.processNames)).toBe(true)
    }
    expect(products.find((p) => p.code === 'WoW')?.processNames).toContain('Wow')
    expect(products.find((p) => p.code === 'Pro')?.uid).toBe('prometheus')
  })

  it('returns an empty list for a missing table', async () => {
    expect(await loadProductTable(resolve('does-not-exist'), log)).toEqual([])
  })
})

describe('uid matching', () => {
  it('matches exactly, then by prefix, and keeps w1 / w1r apart', () => {
    expect(findProductByUid(TABLE, 'wow_enus')?.code).toBe('WoW')
    expect(findProductByUid(TABLE, 'WOW')?.code).toBe('WoW')
    expect(findProductByUid(TABLE, 'w1r')?.code).toBe('W1R')
    expect(findProductByUid(TABLE, 'w1')?.code).toBe('W1')
    expect(findProductByUid(TABLE, 'pro_beta')).toBeUndefined()
    expect(findProductByUid(TABLE, 'battle.net')).toBeUndefined()
    expect(findProductByUid(TABLE, 'Diablo II')).toBeUndefined()
  })
})

describe('registry detection', () => {
  const entries = [
    entry({
      keyName: 'World of Warcraft',
      displayName: 'World of Warcraft',
      installLocation: 'C:\\Games\\World of Warcraft\\',
      uninstallString:
        '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=wow_enus --displayname="World of Warcraft"'
    }),
    entry({
      keyName: 'World of Warcraft Beta',
      displayName: 'World of Warcraft Beta',
      installLocation: 'C:\\Games\\World of Warcraft Beta\\',
      uninstallString:
        '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=wow_beta --displayname="World of Warcraft Beta"'
    }),
    entry({
      keyName: 'Overwatch',
      displayName: 'Overwatch',
      installLocation: 'C:\\Games\\Overwatch\\',
      uninstallString:
        '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=prometheus --displayname="Overwatch"'
    }),
    entry({
      keyName: 'Diablo II',
      displayName: 'Diablo II',
      publisher: 'Blizzard Entertainment',
      installLocation: 'C:\\Games\\Diablo II',
      uninstallString: 'C:\\Games\\Diablo II\\Unins.exe'
    }),
    entry({
      keyName: 'Battle.net',
      displayName: 'Battle.net',
      installLocation: 'C:\\Program Files (x86)\\Battle.net',
      uninstallString:
        '"C:\\Program Files (x86)\\Battle.net\\Battle.net.exe" --uninstall -uid=battle.net'
    })
  ]
  const existing = new Set([
    'c:\\games\\world of warcraft',
    'c:\\games\\diablo ii\\diablo ii.exe',
    'c:\\games\\world of warcraft beta'
  ])
  const exists = (p: string): boolean => existing.has(p.toLowerCase())

  it('maps uninstall strings to products, skips betas and missing folders, finds classic games', () => {
    const found = detectFromUninstallEntries(entries, TABLE, exists)
    expect(found.map((d) => [d.product.code, d.installDir, d.via])).toEqual([
      ['WoW', 'C:\\Games\\World of Warcraft', 'registry'],
      ['D2', 'C:\\Games\\Diablo II', 'classic'],
      ['D2X', 'C:\\Games\\Diablo II', 'classic']
    ])
    expect(found[0].uid).toBe('wow_enus')
  })

  it('adds product.db rows the registry did not list', () => {
    const already = detectFromUninstallEntries(entries, TABLE, exists)
    const installs = [
      { uid: 'wow', productCode: 'WoW', installPath: 'C:\\Games\\World of Warcraft' },
      { uid: 'prometheus', productCode: 'Pro', installPath: 'C:\\Games\\Overwatch' },
      { uid: 'battle.net', productCode: 'bna', installPath: 'C:\\Program Files (x86)\\Battle.net' },
      { uid: 'wow_ptr', productCode: 'WoWT', installPath: 'C:\\Games\\World of Warcraft Beta' }
    ]
    const found = detectFromProductDb(
      installs,
      TABLE,
      already,
      (p) => exists(p) || p.toLowerCase() === 'c:\\games\\overwatch'
    )
    expect(found.map((d) => [d.product.code, d.via])).toEqual([['Pro', 'product.db']])
  })

  it('finds the client directory', () => {
    expect(clientDirFromUninstallEntries(entries)).toBe('C:\\Program Files (x86)\\Battle.net')
    expect(clientDirFromUninstallEntries([])).toBeNull()
  })
})

describe('scanned games', () => {
  const client = 'C:\\Program Files (x86)\\Battle.net\\Battle.net.exe'

  it('launches default products through the client and tracks by process names', () => {
    const game = buildScannedGame(
      {
        product: TABLE[0],
        installDir: 'C:\\Games\\World of Warcraft',
        uid: 'wow_enus',
        via: 'registry'
      },
      client,
      'C:\\Games\\World of Warcraft\\_retail_\\Wow.exe'
    )
    expect(game.externalId).toBe('WoW')
    expect(game.launch).toEqual({
      kind: 'exec',
      file: client,
      args: ['--exec=launch WoW'],
      cwd: 'C:\\Program Files (x86)\\Battle.net'
    })
    expect(game.tracking).toEqual({ mode: 'process', processNames: ['Wow', 'WowClassic'] })
    expect(game.exePath).toBe('C:\\Games\\World of Warcraft\\_retail_\\Wow.exe')
    expect(game.extra).toMatchObject({
      productCode: 'WoW',
      uid: 'wow_enus',
      installedVia: 'registry',
      launchesViaClient: true,
      clientPath: client
    })
  })

  it('falls back to install-directory tracking without process names', () => {
    const game = buildScannedGame(
      { product: TABLE[5], installDir: 'C:\\Games\\Warcraft I', via: 'product.db' },
      client
    )
    expect(game.tracking).toEqual({ mode: 'installDir', installDir: 'C:\\Games\\Warcraft I' })
  })

  it('runs classic games directly', () => {
    const game = buildScannedGame(
      { product: TABLE[3], installDir: 'C:\\Games\\Diablo II', via: 'classic' },
      client
    )
    expect(game.launch).toEqual({
      kind: 'exec',
      file: 'C:\\Games\\Diablo II\\Diablo II.exe',
      args: [],
      cwd: 'C:\\Games\\Diablo II'
    })
    expect(game.title).toBe('Diablo II: Lord of Destruction')
    expect(game.tracking).toEqual({ mode: 'process', processNames: ['Diablo II', 'Game'] })
  })
})

describe('battlenet integration (this machine)', () => {
  it('detects the client and scans without throwing', async () => {
    const client = await battlenetProvider.detectClient()
    console.info(`[battlenet] client: ${JSON.stringify(client)}`)
    if (!client.installed) {
      console.info('[battlenet] Battle.net is not installed on this machine; scan skipped')
      return
    }
    const games = await battlenetProvider.scanInstalled({
      settings: defaultSettings(),
      log: verbose,
      resourcesDir: RESOURCES,
      progress: () => {}
    })
    console.info(
      `[battlenet] ${games.length} game(s): ${games.map((g) => `${g.title} [${g.externalId}] ${g.installDir}`).join('; ')}`
    )
    for (const g of games) {
      expect(g.source).toBe('battlenet')
      expect(g.platformId).toBe('battlenet')
      expect(g.title).toBeTruthy()
      expect(g.installDir).toBeTruthy()
    }
  }, 60_000)
})
