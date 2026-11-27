import { describe, expect, it } from 'vitest'
import { psQuote, runPowerShellJson } from './powershell'

describe('psQuote', () => {
  it('doubles every character PowerShell treats as a single quote', () => {
    expect(psQuote('plain')).toBe("'plain'")
    expect(psQuote("it's")).toBe("'it''s'")
    expect(psQuote('a\u2018b\u2019c\u201Ad\u201Be')).toBe(
      "'a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be'"
    )
  })

  // Live only: the parallel run already starves the real-machine probes in network.test.ts and status.test.ts.
  it.runIf(process.platform === 'win32' && process.env.PLAYOUT_LIVE === '1')(
    'round-trips through the real parser without running anything embedded',
    async () => {
      const values = [
        "D:\\Games\\Assassin's Creed\\game.exe",
        'D:\\Games\\Assassin\u2019s Creed\\game.exe',
        'a\u2019; Write-Output injected; \u2019b',
        '\u2018\u2019\u201A\u201B'
      ]
      const script = `@(${values.map(psQuote).join(', ')})`
      expect(await runPowerShellJson<string[]>(script, { timeoutMs: 30_000 })).toEqual(values)
    },
    40_000
  )
})
