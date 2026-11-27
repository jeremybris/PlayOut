import { describe, expect, it } from 'vitest'
import type { Game } from '../../shared/types'
import { peerPartyEligibility, type PeerPartyProbe } from './eligibility'

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    platformId: 'windows',
    title: 'Portal 2',
    sortTitle: 'portal 2',
    installed: true,
    installDir: 'D:\\Games\\Portal 2',
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { mode: 'installDir', installDir: 'D:\\Games\\Portal 2' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: { steamTags: { tags: ['Puzzle', 'Online Co-Op'], vac: false } } as Game['metadata'],
    media: {},
    metadataStatus: 'done',
    user: {},
    ...overrides
  }
}

const clean: PeerPartyProbe = {
  antiCheat: [],
  antiCheatComplete: true,
  exe: 'D:\\Games\\Portal 2\\portal2.exe',
  services: ['steamworks']
}

describe('peerPartyEligibility', () => {
  it('offers an installed multiplayer game with a supported service and no anti-cheat', () => {
    expect(peerPartyEligibility(makeGame(), clean)).toEqual({
      blocked: null,
      reason: null,
      services: ['steamworks'],
      antiCheat: [],
      exe: clean.exe,
      needsScan: false
    })
  })

  it('asks for a folder scan only once the metadata checks pass', () => {
    expect(peerPartyEligibility(makeGame()).needsScan).toBe(true)
    expect(peerPartyEligibility(makeGame({ installed: false })).needsScan).toBe(false)
  })

  it('checks in order: remote, ROM, recompilation, installed, folder, tags, multiplayer', () => {
    const block = (g: Partial<Game>): string | null =>
      peerPartyEligibility(makeGame(g), clean).blocked
    expect(block({ remote: {} as Game['remote'], installed: false })).toBe('remote')
    expect(block({ source: 'rom' })).toBe('rom')
    expect(block({ launch: { kind: 'emulator', systemId: 'snes', romPath: 'x.sfc' } })).toBe('rom')
    expect(block({ extra: { recompOnly: 'sm64' }, installed: false })).toBe('recomp')
    expect(block({ installed: false })).toBe('not-installed')
    expect(block({ installDir: undefined })).toBe('no-folder')
    expect(
      block({
        metadata: { steamTags: { tags: ['Competitive', 'Online Co-Op'] } } as Game['metadata']
      })
    ).toBe('competitive')
    // Ricochet (Call of Duty since 2019) leaves no files: known by the title.
    expect(block({ title: 'Call of Duty®: Modern Warfare® III' })).toBe('anti-cheat')
    // An Xbox 360 game in Windows' emulator.
    expect(
      block({ source: 'xbox', externalId: 'Xbox360BackwardCompatibil.PrimaryFuzion_ksqcvrsvwz2jp' })
    ).toBe('no-service')
    expect(
      block({ metadata: { genres: ['Free to Play', 'Multiplayer'] } as Game['metadata'] })
    ).toBe('competitive')
    expect(block({ metadata: { steamTags: { tags: ['Puzzle'] } } as Game['metadata'] })).toBe(
      'no-multiplayer'
    )
  })

  it('treats local multiplayer, LAN tags, a Co-Op handler and 2+ players as multiplayer', () => {
    const ok = (metadata: Partial<Game['metadata']>): boolean =>
      peerPartyEligibility(
        makeGame({
          metadata: { steamTags: { tags: [], vac: false }, ...metadata } as Game['metadata']
        }),
        clean
      ).blocked === null
    expect(ok({ tags: ['split screen'] })).toBe(true)
    expect(ok({ genres: ['LAN'] })).toBe(true)
    expect(ok({ coop: {} as Game['metadata']['coop'] })).toBe(true)
    expect(ok({ localPlayers: { max: 4 } } as Partial<Game['metadata']>)).toBe(true)
    expect(ok({ localPlayers: { max: 1 } } as Partial<Game['metadata']>)).toBe(false)
  })

  it('blocks Valve Anti-Cheat from Steam, and a Steam game whose VAC answer is not read yet', () => {
    const tags = (steamTags: object): Game['metadata'] =>
      ({ steamTags: { tags: ['Online Co-Op'], ...steamTags } }) as Game['metadata']
    const vac = peerPartyEligibility(makeGame({ metadata: tags({ vac: true }) }), clean)
    expect(vac.blocked).toBe('anti-cheat')
    expect(vac.reason).toContain('Valve Anti-Cheat')
    expect(peerPartyEligibility(makeGame({ metadata: tags({}) }), clean).blocked).toBe(
      'anti-cheat-unknown'
    )
    // Another store's game: VAC blocks it when its matched Steam app has it; no answer is not a block.
    const epic = { source: 'epic', launch: { kind: 'uri', uri: 'x' } } as Partial<Game>
    expect(
      peerPartyEligibility(makeGame({ ...epic, metadata: tags({ vac: true }) }), clean).blocked
    ).toBe('anti-cheat')
    expect(peerPartyEligibility(makeGame({ ...epic, metadata: tags({}) }), clean).blocked).toBe(
      null
    )
  })

  it('blocks anti-cheat found, an unknown anti-cheat answer, no program and no service', () => {
    const g = makeGame()
    const v = peerPartyEligibility(g, { ...clean, antiCheat: ['Easy Anti-Cheat'] })
    expect(v.blocked).toBe('anti-cheat')
    expect(v.reason).toContain('Easy Anti-Cheat')
    expect(peerPartyEligibility(g, { ...clean, antiCheatComplete: false }).blocked).toBe(
      'anti-cheat-unknown'
    )
    expect(
      peerPartyEligibility(g, { ...clean, antiCheatError: true, antiCheatComplete: false }).blocked
    ).toBe('anti-cheat-unknown')
    expect(peerPartyEligibility(g, { ...clean, exe: null }).blocked).toBe('no-exe')
    expect(peerPartyEligibility(g, { ...clean, services: [] }).blocked).toBe('no-service')
  })
})
