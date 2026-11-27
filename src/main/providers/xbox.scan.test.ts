import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/defaults'

const runPowerShellJson = vi.hoisted(() => vi.fn())
vi.mock('../system/powershell', async (original) => ({
  ...(await original<typeof import('../system/powershell')>()),
  runPowerShellJson
}))

import { xboxProvider } from './xbox'

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const context = {
  settings: defaultSettings(),
  log: quiet,
  resourcesDir: '',
  progress: () => {}
}

describe('xbox scan failures', () => {
  beforeEach(() => runPowerShellJson.mockReset())

  it('throws when the enumeration gives no answer, so the merge keeps the installed games', async () => {
    runPowerShellJson.mockResolvedValue(null)
    await expect(xboxProvider.scanInstalled(context)).rejects.toThrow(/Xbox packages/)
  })

  it('still reports no games when the packages listed are not games', async () => {
    runPowerShellJson.mockResolvedValue({
      name: 'Microsoft.WindowsCalculator',
      packageFamilyName: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe',
      packageFullName: 'Microsoft.WindowsCalculator_11.0_x64__8wekyb3d8bbwe',
      publisher: 'CN=Microsoft Corporation',
      installLocation: 'C:\\Program Files\\WindowsApps\\Calculator',
      signatureKind: 'Store',
      hasGameConfig: false,
      protocols: ['calculator']
    })
    await expect(xboxProvider.scanInstalled(context)).resolves.toEqual([])
  })
})
