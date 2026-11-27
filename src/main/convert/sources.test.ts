import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cueFiles, gdiFiles, m3uFiles, sourceFiles } from './sources'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-sources-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const touch = (name: string, text = 'x'): Promise<void> => fs.writeFile(join(dir, name), text)

describe('game image sources', () => {
  it('reads the files of a cue sheet, a gdi and a playlist', () => {
    expect(
      cueFiles(
        'FILE "Game (Track 1).bin" BINARY\r\n  TRACK 01 MODE2/2352\nFILE track2.bin BINARY',
        'D:'
      )
    ).toEqual([join('D:', 'Game (Track 1).bin'), join('D:', 'track2.bin')])
    expect(gdiFiles('3\n1 0 4 2352 track01.bin 0\n2 600 0 2352 "track 02.raw" 0\n', 'D:')).toEqual([
      join('D:', 'track01.bin'),
      join('D:', 'track 02.raw')
    ])
    expect(m3uFiles('# discs\nDisc 1.chd\n\nDisc 2.chd\n', 'D:')).toEqual([
      join('D:', 'Disc 1.chd'),
      join('D:', 'Disc 2.chd')
    ])
  })

  it('gives a cue with its BINs, leaving out what is not there', async () => {
    await touch(
      'Game.cue',
      'FILE "Game (Track 1).bin" BINARY\nFILE "Game (Track 2).bin" BINARY\nFILE "Gone.bin" BINARY'
    )
    await touch('Game (Track 1).bin')
    await touch('Game (Track 2).bin')
    expect(await sourceFiles(join(dir, 'Game.cue'))).toEqual([
      join(dir, 'Game.cue'),
      join(dir, 'Game (Track 1).bin'),
      join(dir, 'Game (Track 2).bin')
    ])
  })

  it('gives a playlist with its discs and their BINs', async () => {
    await touch('Game.m3u', 'Game (Disc 1).cue\nGame (Disc 2).chd\n')
    await touch('Game (Disc 1).cue', 'FILE "Disc1.bin" BINARY')
    await touch('Disc1.bin')
    await touch('Game (Disc 2).chd')
    expect((await sourceFiles(join(dir, 'Game.m3u'))).map((p) => p.slice(dir.length + 1))).toEqual([
      'Game.m3u',
      'Game (Disc 1).cue',
      'Game (Disc 2).chd',
      'Disc1.bin'
    ])
  })

  it('gives every piece of a split PS3 image, and a folder or plain file alone', async () => {
    for (const name of ['Game.iso.0', 'Game.iso.1', 'Game.iso.2', 'Other.iso.1', 'Game.iso'])
      await touch(name)
    expect(
      (await sourceFiles(join(dir, 'Game.iso.0'))).map((p) => p.slice(dir.length + 1)).sort()
    ).toEqual(['Game.iso.0', 'Game.iso.1', 'Game.iso.2'])
    expect(await sourceFiles(join(dir, 'Game.iso'))).toEqual([join(dir, 'Game.iso')])
    await fs.mkdir(join(dir, 'BLUS00001'))
    expect(await sourceFiles(join(dir, 'BLUS00001'))).toEqual([join(dir, 'BLUS00001')])
  })
})
