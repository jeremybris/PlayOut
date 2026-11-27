import { spawnSync } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compressedPowerShellArgs } from '../emulator-setup/run'
import {
  createHostFirewall,
  firewallApplyScript,
  firewallCheckScript,
  firewallProblem,
  parseFirewallCheck
} from './firewall'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-fw-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const log = { info: vi.fn(), warn: vi.fn() }
const EXE = "C:\\Users\\O'Brien\\AppData\\Local\\Programs\\PlayOut\\PlayOut.exe"

function firewall(
  checks: string[],
  elevated: (number | null)[]
): {
  fw: ReturnType<typeof createHostFirewall>
  runScript: ReturnType<typeof vi.fn>
  runElevatedScript: ReturnType<typeof vi.fn>
} {
  const runScript = vi.fn(async () => ({ code: 0, stdout: checks.shift() ?? '' }))
  const runElevatedScript = vi.fn(async () => elevated.shift() ?? null)
  const fw = createHostFirewall({
    exe: EXE,
    runScript,
    runElevatedScript,
    stateFile: join(dir, 'firewall.json'),
    log
  })
  return { fw, runScript, runElevatedScript }
}

const OPEN = '{"tcp":true,"udp":true,"blocks":0}'
const CLOSED = '{"tcp":false,"udp":false,"blocks":0}'

describe('the host firewall', () => {
  it('asks nothing when the rules are there', async () => {
    const { fw, runElevatedScript } = firewall([OPEN], [])
    expect(await fw.ensure(47900, 47901)).toBe('ok')
    expect(runElevatedScript).not.toHaveBeenCalled()
  })

  it('adds the rules once, with one admin prompt, when they are missing or a Block rule names the exe', async () => {
    const { fw, runElevatedScript } = firewall([CLOSED, OPEN], [0])
    expect(await fw.ensure(47900, 47901)).toBe('added')
    expect(runElevatedScript).toHaveBeenCalledWith(firewallApplyScript(47900, 47901, EXE))
    const blocked = firewall(['{"tcp":true,"udp":true,"blocks":1}', OPEN], [0])
    expect(await blocked.fw.ensure(47900, 47901)).toBe('added')
  })

  it('does not ask again after a declined prompt, until hosting is switched on again', async () => {
    const { fw, runElevatedScript } = firewall([CLOSED, CLOSED, CLOSED, OPEN], [1223, 0])
    expect(await fw.ensure(47900, 47901)).toBe('declined')
    expect(await fw.ensure(47900, 47901)).toBe('declined')
    expect(runElevatedScript).toHaveBeenCalledTimes(1)
    await fw.forgetDeclined()
    expect(await fw.ensure(47900, 47901)).toBe('added')
  })

  it('does not ask again after a failed or unanswered prompt either', async () => {
    const { fw, runElevatedScript } = firewall([CLOSED, CLOSED, CLOSED], [null])
    expect(await fw.ensure(47900, 47901)).toBe('failed')
    expect(await fw.ensure(47900, 47901)).toBe('failed')
    expect(runElevatedScript).toHaveBeenCalledTimes(1)
  })

  it('opens one prompt for overlapping starts, and a decline from before hosting was switched on again is not kept', async () => {
    let answer!: (code: number) => void
    const runElevatedScript = vi.fn(() => new Promise<number>((r) => (answer = r)))
    const checks = [CLOSED, CLOSED]
    const fw = createHostFirewall({
      exe: EXE,
      runScript: async () => ({ code: 0, stdout: checks.shift() ?? CLOSED }),
      runElevatedScript,
      stateFile: join(dir, 'firewall.json'),
      log
    })
    const first = fw.ensure(47900, 47901)
    const second = fw.ensure(47900, 47901)
    await vi.waitFor(() => expect(runElevatedScript).toHaveBeenCalledTimes(1))
    await fw.forgetDeclined()
    answer(1223)
    expect(await first).toBe('declined')
    expect(await second).toBe('declined')
    expect(runElevatedScript).toHaveBeenCalledTimes(1)
    // Switched on again while that prompt was up: the next start asks again.
    expect(fw.ensure(47900, 47901)).toBeInstanceOf(Promise)
    await vi.waitFor(() => expect(runElevatedScript).toHaveBeenCalledTimes(2))
    answer(1223)
  })

  it('reports an unreadable check', async () => {
    expect(await firewall(['oops'], []).fw.ensure(47900, 47901)).toBe('unknown')
    expect(firewallProblem('declined', 47900)).toMatch(/switch hosting off and on/)
    expect(firewallProblem('failed', 47900)).toMatch(/TCP 47900 and UDP 47901/)
    expect(firewallProblem('ok', 47900)).toBeNull()
    expect(firewallProblem('unknown', 47900)).toBeNull()
  })

  it('builds rules for every network profile, by port, and quotes the exe path', () => {
    const s = firewallApplyScript(47900, 47901, EXE)
    expect(s).toContain('-Protocol TCP -LocalPort 47900 -Profile Any')
    expect(s).toContain('-Protocol UDP -LocalPort 47901 -Profile Any')
    expect(s).toContain("$exe = 'C:\\Users\\O''Brien\\")
    expect(s).toContain('Disable-NetFirewallRule')
    // Only the Block rules Windows made from its prompt; a rule the user made stays.
    expect(s).toContain("$_.Name -match '^(TCP|UDP) Query User\\{'")
    expect(firewallCheckScript(47900, 47901, EXE)).toContain('Query User\\{')
    // Curly apostrophes end a PowerShell literal too.
    expect(firewallApplyScript(47900, 47901, 'C:\\Users\\O’Brien\\PlayOut.exe')).toContain(
      "'C:\\Users\\O’’Brien\\PlayOut.exe'"
    )
    expect(s).not.toContain('Remove-NetFirewallRule -Program')
    expect(() => firewallApplyScript(0, 1, EXE)).toThrow(/invalid port/)
    expect(parseFirewallCheck(OPEN)).toEqual({ tcp: true, udp: true, blocks: 0 })
    expect(parseFirewallCheck('{"tcp":1}')).toBeNull()
  })
})

describe.skipIf(process.platform !== 'win32')('the firewall scripts on real PowerShell', () => {
  it('parse without errors (nothing is run)', () => {
    const curly = 'C:\\Users\\O’Brien\\PlayOut.exe'
    const scripts = [
      firewallCheckScript(47900, 47901, EXE),
      firewallApplyScript(47900, 47901, EXE),
      firewallCheckScript(47900, 47901, curly),
      firewallApplyScript(47900, 47901, curly)
    ]
    const check = [
      '$out = @()',
      ...scripts.map(
        (s) =>
          `$t = $null; $e = $null; [void][Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(s, 'utf8').toString('base64')}')), [ref]$t, [ref]$e); $out += ,@($e | ForEach-Object { $_.Message })`
      ),
      'ConvertTo-Json -InputObject $out -Compress',
      'exit 0'
    ].join('\n')
    const ps = spawnSync('powershell.exe', compressedPowerShellArgs(check), {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    expect(JSON.parse(ps.stdout.trim())).toEqual([[], [], [], []])
  }, 60_000)

  it('reads this PC’s rules without admin rights (read-only)', () => {
    const ps = spawnSync(
      'powershell.exe',
      compressedPowerShellArgs(firewallCheckScript(47900, 47901, process.execPath)),
      { encoding: 'utf8', timeout: 120_000, windowsHide: true }
    )
    expect(ps.status).toBe(0)
    expect(parseFirewallCheck(ps.stdout)).not.toBeNull()
  }, 120_000)
})
