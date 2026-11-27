import { describe, expect, it } from 'vitest'
import type { Ps3UpdateProgress } from '@shared/types'
import {
  artScanBar,
  emulatorSetupBar,
  hltbScanBar,
  ps3UpdateBar,
  ratingsScanBar,
  sizeScanBar
} from './scanBars'

describe('scan bars', () => {
  it('shows nothing while a pass is idle', () => {
    expect(sizeScanBar({ done: 0, total: 0, paused: false })).toBeNull()
    expect(ratingsScanBar({ done: 0, total: 0, stage: 'steam' })).toBeNull()
  })

  it('says what the review scores pass is doing: Steam, an IGDB search, or paused', () => {
    expect(ratingsScanBar({ done: 1200, total: 5470, stage: 'steam' })).toMatchObject({
      label: 'Reading review scores from Steam · 1,200 of 5,470',
      done: 1200,
      paused: false
    })
    expect(
      ratingsScanBar({ done: 5100, total: 5470, stage: 'igdb', current: 'Fuzion Frenzy' })?.label
    ).toBe('Reading review scores from IGDB · 5,100 of 5,470 · Fuzion Frenzy')
    expect(ratingsScanBar({ done: 5170, total: 5470, stage: 'igdb', paused: true })).toMatchObject({
      label:
        'Review scores paused: Steam or IGDB is not answering. 300 left, trying again in 15 min',
      paused: true
    })
  })

  it('says which game the HowLongToBeat pass is matching, and hides when idle', () => {
    expect(hltbScanBar({ done: 0, total: 0 })).toBeNull()
    // The H.L.T.B. sort's lookups show in the Library's header instead.
    expect(hltbScanBar({ done: 1, total: 5, source: 'sort' })).toBeNull()
    expect(
      hltbScanBar({ done: 41, total: 141, current: 'KINGDOM HEARTS -HD 1.5+2.5 ReMIX-' })
    ).toMatchObject({
      label: 'Matching HowLongToBeat times · 41 of 141 · KINGDOM HEARTS -HD 1.5+2.5 ReMIX-',
      done: 41,
      total: 141
    })
  })

  it('keeps the install-size wording', () => {
    expect(sizeScanBar({ done: 3, total: 10, paused: false, current: 'Elden Ring' })?.label).toBe(
      'Checking install sizes · 3 of 10 · measuring Elden Ring'
    )
  })

  it('says whether covers or the remaining game art are downloading, and hides when idle', () => {
    expect(artScanBar({ stage: 'cover', done: 0, total: 0 })).toBeNull()
    expect(artScanBar({ stage: 'cover', done: 1200, total: 3104 })).toMatchObject({
      key: 'art',
      name: 'Game art downloads',
      label: 'Downloading cover art · 1,200 of 3,104',
      done: 1200,
      total: 3104,
      paused: false
    })
    expect(artScanBar({ stage: 'art', done: 12, total: 3104 })?.label).toBe(
      'Downloading game art · 12 of 3,104'
    )
  })

  it('says which emulators are being set up, with the MB downloaded, and hides when idle', () => {
    expect(emulatorSetupBar({ done: 0, total: 0 })).toBeNull()
    expect(
      emulatorSetupBar({
        done: 3,
        total: 14,
        stage: 'emulators',
        current: ['RPCS3', 'Dolphin'],
        bytesDone: 120_400_000,
        bytesTotal: 450_000_000
      })
    ).toMatchObject({
      key: 'emulator-setup',
      name: 'Emulator setup',
      label: 'Setting up emulators · RPCS3, Dolphin · 3 of 14 · 120 of 450 MB',
      done: 3,
      total: 14,
      paused: false
    })
    expect(emulatorSetupBar({ done: 0, total: 14, stage: 'emulators' })?.label).toBe(
      'Setting up emulators · 0 of 14'
    )
    expect(
      emulatorSetupBar({
        done: 2,
        total: 14,
        stage: 'emulators',
        current: ['RPCS3'],
        filesDone: 1200,
        filesTotal: 1603
      })?.label
    ).toBe('Setting up emulators · RPCS3 · 2 of 14 · 1,200 of 1,603 files')
    expect(emulatorSetupBar({ done: 0, total: 14, stage: 'runtimes' })?.label).toBe(
      'Installing Visual C++ / DirectX runtimes'
    )
    expect(emulatorSetupBar({ done: 14, total: 14, stage: 'bios' })?.label).toBe(
      'Linking BIOS files · 14 of 14'
    )
  })

  it("says which PS3 game's update is being checked, downloaded or installed", () => {
    const p = (over: Partial<Ps3UpdateProgress>): Ps3UpdateProgress => ({
      gameId: 'rom:a',
      title: 'The Last of Us',
      manual: true,
      phase: 'checking',
      version: null,
      bytes: null,
      total: null,
      message: null,
      ...over
    })
    expect(ps3UpdateBar(null)).toBeNull()
    expect(ps3UpdateBar(p({}))).toEqual({
      key: 'ps3-update',
      name: 'PS3 update',
      label: 'Checking The Last of Us for PS3 updates',
      done: 0,
      total: 1,
      paused: false
    })
    expect(
      ps3UpdateBar(
        p({ phase: 'downloading', version: '01.11', bytes: 142_000_000, total: 284_414_928 })
      )
    ).toEqual({
      key: 'ps3-update',
      name: 'PS3 update',
      label: "Downloading The Last of Us's update 01.11 · 142 of 284 MB",
      done: 142_000_000,
      total: 284_414_928,
      paused: false
    })
    // Bytes past the size are shown as the size.
    expect(
      ps3UpdateBar(p({ phase: 'downloading', bytes: 3_000_000, total: 2_000_000 }))?.label
    ).toBe("Downloading The Last of Us's update · 2 of 2 MB")
    expect(ps3UpdateBar(p({ phase: 'installing', version: '01.11' }))?.label).toBe(
      "Installing The Last of Us's update 01.11 with RPCS3"
    )
    expect(ps3UpdateBar(p({ phase: 'installing' }))?.label).toBe(
      "Installing The Last of Us's update with RPCS3"
    )
  })
})
