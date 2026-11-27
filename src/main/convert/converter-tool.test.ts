import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONVERTER_EXE, converterEntryPath, installedConverter } from './converter-tool'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-gfc-tool-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('the converter download', () => {
  it("drops the release zip's top folder, whichever slashes it uses", () => {
    expect(
      converterEntryPath(['Game Format Converter', 'chdman.exe'].join(String.fromCharCode(92)))
    ).toBe('chdman.exe')
    expect(converterEntryPath('Game Format Converter/sub/x.txt')).toBe('sub/x.txt')
    expect(converterEntryPath('README.md')).toBe('README.md')
  })

  it('counts as installed only with its marker and its program in place', async () => {
    expect(await installedConverter(root)).toBeNull()
    await fs.mkdir(join(root, '2.1.0'))
    await fs.writeFile(
      join(root, 'playout-converter.json'),
      JSON.stringify({ version: '2.1.0', dir: '2.1.0' })
    )
    expect(await installedConverter(root)).toBeNull()
    await fs.writeFile(join(root, '2.1.0', CONVERTER_EXE), '')
    expect(await installedConverter(root)).toEqual({
      version: '2.1.0',
      exe: join(root, '2.1.0', CONVERTER_EXE)
    })
  })
})
