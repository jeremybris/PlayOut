import { beforeEach, describe, expect, it, vi } from 'vitest'

const readRegistryKey = vi.fn()
vi.mock('./registry', () => ({ readRegistryKey: (...a: unknown[]) => readRegistryKey(...a) }))
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { readUninstallEntries, resetUninstallEntriesCache } from './uninstall'

const key = (
  leaf: string
): { leaf: string; values: object; subkeys: { leaf: string; values: object; subkeys: [] }[] } => ({
  leaf,
  values: {},
  subkeys: [{ leaf, values: { DisplayName: leaf }, subkeys: [] }]
})

describe('readUninstallEntries', () => {
  beforeEach(() => {
    resetUninstallEntriesCache()
    readRegistryKey.mockReset()
  })

  it('rejects a partial read when a complete list is asked for, but still serves it otherwise', async () => {
    readRegistryKey.mockImplementation(async (hive: string, _path: string, o: { view: string }) => {
      if (hive === 'HKLM' && o.view === 'x86') throw new Error('timed out')
      return key(`${hive}-${o.view}`)
    })
    await expect(readUninstallEntries({ complete: true })).rejects.toThrow('HKLM/x86')
    expect((await readUninstallEntries()).map((e) => e.keyName)).toEqual([
      'HKLM-x64',
      'HKCU-default'
    ])
  })

  it('treats a missing Uninstall key as a complete (empty) hive', async () => {
    readRegistryKey.mockImplementation(async (hive: string, _path: string, o: { view: string }) =>
      hive === 'HKCU' ? null : key(`${hive}-${o.view}`)
    )
    expect(await readUninstallEntries({ complete: true })).toHaveLength(2)
  })

  it("counts no answer for HKLM's Uninstall key (it always exists) as a failed read", async () => {
    // runPowerShellJson answers null for empty or unparsable output, not only for a missing key.
    readRegistryKey.mockImplementation(async (hive: string, _path: string, o: { view: string }) =>
      hive === 'HKLM' && o.view === 'x86' ? null : key(`${hive}-${o.view}`)
    )
    await expect(readUninstallEntries({ complete: true })).rejects.toThrow('HKLM/x86')
    expect(await readUninstallEntries()).toHaveLength(2)
  })
})
