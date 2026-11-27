import { spawnSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import {
  compressedPowerShellArgs,
  elevatedScript,
  encodedPowerShellArgs,
  MAX_COMMAND_LINE,
  quoteWindowsArg
} from '../emulator-setup/run'
import {
  applyScript,
  EMPTY_LEDGER,
  mergeLedgers,
  parseLedger,
  revertScript,
  type PowerChange
} from './wake-sources'

const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e'
const SUB_NONE = 'fea3413e-7e05-4911-9a71-700331f1c294'
const SUB_SLEEP = '238c9fa8-0aad-41ed-83f4-97be242c8f20'
const CONNECTIVITY = 'f15576e8-98b7-4186-b944-eafa664402d9'
const HIBERNATE_IDLE = '9d7815a6-7ee4-497e-8888-515a05f02364'

const standby: PowerChange = {
  scheme: BALANCED,
  sub: SUB_NONE,
  setting: CONNECTIVITY,
  target: 0,
  ac: 1,
  dc: 2
}

describe('the wake-source ledger', () => {
  it('keeps only well-formed entries, and reads 0.1.98 ledgers', () => {
    expect(
      parseLedger(
        `\uFEFF{"devices":["Wi-Fi",3,""],"hibernate":{"scheme":"${BALANCED}","ac":0,"dc":-1}}`
      )
    ).toEqual({
      devices: ['Wi-Fi'],
      power: [
        {
          scheme: BALANCED,
          sub: SUB_SLEEP,
          setting: HIBERNATE_IDLE,
          target: 172800,
          ac: 0,
          dc: null
        }
      ],
      hibernation: false,
      maintenanceWake: null
    })
    expect(
      parseLedger(
        JSON.stringify({
          devices: [],
          power: [standby, { ...standby, sub: 'x; rm' }, { ...standby, ac: null, dc: null }],
          hibernation: true,
          maintenanceWake: 1
        })
      )
    ).toEqual({ devices: [], power: [standby], hibernation: true, maintenanceWake: 1 })
    expect(parseLedger('{"devices":[],"hibernate":{"scheme":"x; rm"}}')).toEqual(EMPTY_LEDGER)
    expect(parseLedger('not json')).toBeNull()
  })

  it('merges an earlier ledger, whose original values win', () => {
    const merged = mergeLedgers(
      { devices: ['A'], power: [standby], hibernation: true, maintenanceWake: null },
      {
        devices: ['A', 'B'],
        power: [{ ...standby, ac: 0 }],
        hibernation: false,
        maintenanceWake: 1
      }
    )
    expect(merged).toEqual({
      devices: ['A', 'B'],
      power: [standby],
      hibernation: true,
      maintenanceWake: 1
    })
    // Per side: what only the new run changed keeps the value it found.
    expect(
      mergeLedgers(
        { ...EMPTY_LEDGER, power: [{ ...standby, ac: 1, dc: null }] },
        { ...EMPTY_LEDGER, power: [{ ...standby, ac: null, dc: 2 }] }
      ).power
    ).toEqual([{ ...standby, ac: 1, dc: 2 }])
  })

  it('quotes device names in the revert script (they are PowerShell literals, never code)', () => {
    const s = revertScript({ ...EMPTY_LEDGER, devices: ["Bob's NIC'; Remove-Item C:\\"] })
    expect(s).toContain("powercfg -deviceenablewake 'Bob''s NIC''; Remove-Item C:\\'")
  })

  it('reverts each setting only while it is still what PlayOut set, and hibernation only when PlayOut turned it on', () => {
    const s = revertScript({
      devices: ['Wi-Fi'],
      power: [standby],
      hibernation: true,
      maintenanceWake: 1
    })
    expect(s).toContain(`if ($vals[0] -eq 0) { powercfg /setacvalueindex '${BALANCED}'`)
    expect(s).toContain(`'${CONNECTIVITY}' 2; if ($LASTEXITCODE -ne 0) { $failed++ } }`)
    expect(s).toContain('powercfg /hibernate off')
    expect(s).toContain("if ($present -contains 'Wi-Fi')")
    expect(s).toContain('-Name WakeUp -Value 1')
    expect(revertScript(EMPTY_LEDGER)).not.toContain('hibernate')
  })

  it('disarms only network adapters and fingerprint readers, and pauses standby, wake timers and away mode', () => {
    const s = applyScript('C:\\Users\\x\\AppData\\Roaming\\playout\\sleep\\wake-sources.json')
    expect(s).toContain("if ($class -ne 'Net' -and $class -ne 'Biometric') { continue }")
    expect(s).toContain(CONNECTIVITY)
    expect(s).toContain('bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d')
    expect(s).toContain('25dfa149-5dd1-4736-b5ab-e8a37b5b8187')
    expect(s).toContain('if ($v -eq 0 -or $v -gt 172800)')
    expect(s).toContain('powercfg /hibernate on')
    expect(s).toContain('($ram * 0.4 + 10GB)')
  })
})

describe.skipIf(process.platform !== 'win32')('the scripts on real PowerShell', () => {
  it('parse without errors (nothing is run)', () => {
    const scripts = [
      applyScript("C:\\Users\\O'Brien\\sleep\\wake-sources.json"),
      revertScript({
        devices: ['Intel(R) Wi-Fi 6E AX211 160MHz'],
        power: [
          standby,
          {
            scheme: BALANCED,
            sub: SUB_SLEEP,
            setting: HIBERNATE_IDLE,
            target: 172800,
            ac: 0,
            dc: null
          }
        ],
        hibernation: true,
        maintenanceWake: 1
      })
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
    if (ps.status !== 0) throw new Error(ps.stderr || String(ps.error))
    expect(JSON.parse(ps.stdout.trim())).toEqual([[], []])
  }, 60_000)

  it('reads the values whatever the Windows language, and the last two for a range setting', () => {
    const s = applyScript('C:\\x.json')
    const line = s.split('\n').find((l) => l.includes(CONNECTIVITY) && l.includes('$vals ='))!
    const script = [
      // powercfg stands in: German labels, and a range setting's minimum, maximum and step first.
      "function powercfg { 'Minimaler möglicher Wert: 0x00000000'; 'Maximaler möglicher Wert: 0xffffffff'; 'Schrittweite: 0x00000001'; 'Aktueller Wechselstrom-Einstellungsindex: 0x00000001'; 'Aktueller Gleichstrom-Einstellungsindex: 0x00000002' }",
      '$scheme = "x"',
      line.trim(),
      '$vals -join ","'
    ].join('\n')
    const ps = spawnSync('powershell.exe', encodedPowerShellArgs(script), {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    expect(ps.stdout.trim()).toBe('1,2')
  }, 60_000)

  it('fits on a Windows command line once wrapped for elevation, and keeps its exit code', () => {
    const args = encodedPowerShellArgs(
      elevatedScript(
        'powershell.exe',
        compressedPowerShellArgs(applyScript("C:\\Users\\O'Brien\\a.json")),
        {
          hidden: true
        }
      )
    )
    expect(['powershell.exe', ...args].map(quoteWindowsArg).join(' ').length).toBeLessThan(
      MAX_COMMAND_LINE * 0.75
    )
    const run = spawnSync('powershell.exe', compressedPowerShellArgs('$x = 1\nexit 2'), {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    expect(run.status).toBe(2)
    // A script that cannot run is a failure, never 0.
    const broken = spawnSync('powershell.exe', compressedPowerShellArgs('if ('), {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    expect(broken.status).toBe(1)
  }, 60_000)

  it('reads the current values of a hidden setting the way the scripts do (read-only)', () => {
    // The readValues line, run against this PC: two values, AC then DC.
    const s = applyScript('C:\\x.json')
    const line = s.split('\n').find((l) => l.includes(CONNECTIVITY) && l.includes('$vals ='))!
    const script = [
      "$scheme = ([regex]'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}').Match((powercfg /getactivescheme) -join ' ').Value",
      line.trim(),
      '"$($vals.Count)"'
    ].join('\n')
    const ps = spawnSync('powershell.exe', encodedPowerShellArgs(script), {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    // Modern Standby PCs have the setting (two values); others have none.
    expect(['0', '2']).toContain(ps.stdout.trim())
  }, 60_000)
})
