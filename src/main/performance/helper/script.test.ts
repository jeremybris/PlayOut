import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { elevatedScript, encodedPowerShellArgs, quoteWindowsArg } from '../../emulator-setup/run'
import {
  helperScript,
  HELPER_TASK,
  importModules,
  FOLDER_FUNCTIONS,
  INSTALL_MODULES,
  PS_MODULE_PATH_RESET,
  TASK_DEFINITION,
  installExitText,
  installScript,
  INSTALL_EXIT,
  removeScript,
  type InstallScriptOptions
} from './script'

const SID = 'S-1-5-21-3656239912-250964603-1012508381-1001'
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const H3 = 'c'.repeat(64)

const options = (over: Partial<InstallScriptOptions> = {}): InstallScriptOptions => ({
  helper: {
    path: "C:\\Users\\O'Brien\\AppData\\Roaming\\PlayOut\\performance\\downloads\\helper.ps1",
    sha256: H1
  },
  modules: {
    path: 'C:\\Users\\x\\AppData\\Roaming\\PlayOut\\performance\\downloads\\modules\\0.2.11\\release_0_2_11.zip',
    sha256: H2,
    module: 'IntelMSR.bin'
  },
  setup: { path: 'C:\\Users\\x\\cache\\setup\\2.2.0\\PawnIO_setup.exe', sha256: H3 },
  userSid: SID,
  ...over
})

/** The whole command line runElevated starts (outer powershell.exe with the Start-Process script). */
function elevatedCommandLine(script: string): string {
  const inner = encodedPowerShellArgs(script)
  const outer = encodedPowerShellArgs(elevatedScript('powershell.exe', inner))
  return ['powershell.exe', ...outer].map(quoteWindowsArg).join(' ')
}

/** PowerShell's own parser (nothing runs): the parse errors of each script, read from temp files. */
function parseErrors(scripts: string[]): string[][] {
  const dir = mkdtempSync(join(tmpdir(), 'playout-ps-parse-'))
  const files = scripts.map((s, i) => {
    const f = join(dir, `s${i}.ps1`)
    writeFileSync(f, s, 'utf8')
    return f
  })
  const check = [
    '$out = @()',
    `foreach ($f in @(${files.map((f) => `'${f}'`).join(',')})) {`,
    '  $t = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)',
    '  $tokens = $null; $errors = $null',
    '  [void][Management.Automation.Language.Parser]::ParseInput($t, [ref]$tokens, [ref]$errors)',
    '  $out += ,@($errors | ForEach-Object { $_.Message })',
    '}',
    'ConvertTo-Json -InputObject $out -Compress'
  ].join('\n')
  const ps = spawnSync('powershell.exe', encodedPowerShellArgs(check), {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true
  })
  rmSync(dir, { recursive: true, force: true })
  if (ps.status !== 0) throw new Error(ps.stderr || String(ps.error))
  return JSON.parse(ps.stdout.trim()) as string[][]
}

describe('helper.ps1', () => {
  const text = helperScript()

  it('is plain ASCII (PowerShell 5.1 reads a BOM-less script in the ANSI code page)', () => {
    const odd = [...text].filter((c) => {
      const code = c.charCodeAt(0)
      return code > 0x7e || (code < 0x20 && c !== '\t' && c !== '\n' && c !== '\r')
    })
    expect(odd).toEqual([])
  })

  it('compiles the C# from a single-quoted here-string and runs the server', () => {
    const lines = text.split('\r\n')
    expect(
      lines.filter((l) =>
        l.startsWith(
          "Add-Type -ReferencedAssemblies System.Core, System.Web.Extensions -TypeDefinition @'"
        )
      )
    ).toHaveLength(1)
    // The here-string ends exactly once: no C# line may start with '@.
    expect(lines.filter((l) => l.startsWith("'@"))).toEqual(["'@"])
    // Run again a minute after a crash; only what a retry cannot fix (2, 3) ends the script.
    const loop = lines.slice(lines.indexOf('while ($true) {'))
    expect(loop.find((l) => l.includes('[PlayOutPower.Server]::Run('))).toContain(
      "$r = [PlayOutPower.Server]::Run($dir, $pawn, 'PlayOut', $sid)"
    )
    expect(loop).toContain('  if ($r -eq 2 -or $r -eq 3) { exit $r }')
    expect(loop).toContain('  Start-Sleep -Seconds 60')
    expect(lines.at(-2)).toBe('}')
    expect(text).toContain('Uninstall\\PawnIO')
  })

  it('trusts nothing from the environment: system modules only, imported by full path', () => {
    const code = text.split('\r\n').filter((l) => l && !l.startsWith('#'))
    // The very first statement resets PSModulePath to the system folders.
    expect(code[0]).toBe(PS_MODULE_PATH_RESET)
    expect(PS_MODULE_PATH_RESET).toBe(
      "$env:PSModulePath=$PSHOME+'\\Modules;'+[Environment]::SystemDirectory+'\\WindowsPowerShell\\v1.0\\Modules'"
    )
    const imports = importModules(['Microsoft.PowerShell.Utility'])
    expect(text).toContain(imports)
    expect(text.indexOf(imports)).toBeLessThan(text.indexOf('Add-Type'))
    // No cmdlets of other modules (they would autoload by name), no %ProgramFiles% / %ProgramData%.
    for (const cmdlet of ['Split-Path', 'Join-Path', 'New-Item', 'Get-ItemProperty', 'Get-Content'])
      expect(text).not.toContain(cmdlet)
    expect(text).not.toMatch(/\$env:Program/i)
    expect(text).toContain("[IO.Path]::Combine($dir, 'user.sid')")
  })
})

describe('install script', () => {
  it('checks the installer hash and signature before running it silently', () => {
    const s = installScript(options())
    expect(s).toContain(`if((Sha $s) -ne '${H3}'){exit ${INSTALL_EXIT.SETUP_CHANGED}}`)
    expect(s).toContain("$g.Status -ne 'Valid'")
    expect(s).toContain("-ArgumentList '-install -silent'")
    expect(s.indexOf('Get-AuthenticodeSignature')).toBeLessThan(s.indexOf('Start-Process'))
    // Run from the admin-only folder (copied there, then checked), never from the user-writable cache.
    expect(s).toContain(
      "$s=Join-Path $d PawnIO_setup.exe;Copy-Item -LiteralPath 'C:\\Users\\x\\cache\\setup\\2.2.0\\PawnIO_setup.exe' -Destination $s -Force"
    )
    expect(s.indexOf("M $d 'OICI'")).toBeLessThan(s.indexOf('PawnIO_setup.exe'))
    expect(s).toContain("-notmatch '(^|,\\s*)CN=namazso\\.eu(,|$)'")
  })

  it('skips PawnIO when it is installed', () => {
    const s = installScript(options({ setup: null }))
    expect(s).not.toContain('PawnIO_setup')
    expect(s).not.toContain('Start-Process')
  })

  it('starts with the system module path and imports every module it uses by full path', () => {
    const s = installScript(options())
    const lines = s.split('\n')
    expect(lines[0]).toBe(PS_MODULE_PATH_RESET)
    const imports = importModules(INSTALL_MODULES)
    expect(imports).toBe(
      "foreach($n in 'Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security','Microsoft.PowerShell.Archive','ScheduledTasks'){Import-Module \"$PSHOME\\Modules\\$n\\$n.psd1\" -EA Stop}"
    )
    // Imported before the first statement that runs a cmdlet of those modules (function lines only define).
    const firstUse = lines.findIndex(
      (l) => !l.startsWith('function ') && /Join-Path|Get-FileHash|New-Item|Get-Item|^M /.test(l)
    )
    expect(lines.indexOf(imports)).toBeGreaterThan(0)
    expect(lines.indexOf(imports)).toBeLessThan(firstUse)
    expect(() => importModules(['x;calc'])).toThrow(/module/)
    // System programs from the system folder, not through PATH or %SystemRoot% / %windir%.
    expect(s).not.toMatch(/\$env:(SystemRoot|windir|ProgramData|ProgramFiles)/i)
    expect(s).toContain("$cmd=[Environment]::SystemDirectory+'\\cmd.exe'")
    expect(s).toContain(
      "$e=[Environment]::SystemDirectory+'\\WindowsPowerShell\\v1.0\\powershell.exe'"
    )
    expect(s).toContain('& $cmd /d /c rmdir /s /q $p')
  })

  it('finds ProgramData itself and takes no folder from PlayOut', () => {
    const s = installScript(options())
    expect(s).toContain(
      "$pd=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PlayOut';$d=Join-Path $pd 'PowerHelper'"
    )
    expect(s).not.toContain('ProgramData\\PlayOut')
  })

  it('checks each folder it made is a real, admin-owned directory before using it', () => {
    const s = installScript(options())
    expect(FOLDER_FUNCTIONS).toContain(
      'function M($p,$i){U $p;New-Item -ItemType Directory -Force -Path $p|Out-Null;V $p;A $p $i;V $p}'
    )
    for (const f of FOLDER_FUNCTIONS) expect(s).toContain(f)
    // ProgramData\PlayOut (this folder only), then PowerHelper (inherited by everything in it).
    expect(s).toContain("M $pd '';M $d 'OICI'")
    expect(s).toContain(`}catch{exit ${INSTALL_EXIT.FILES}}`)
    // Nothing is logged into a folder before it passed the check (the log could land in a junction's target).
    expect(s).toContain('function L($m){if($ok){')
    expect(s.indexOf('$ok=$true')).toBeGreaterThan(s.indexOf("M $pd '';M $d 'OICI'"))
  })

  it('locks the folder down before copying, then checks every copied file', () => {
    const s = installScript(options())
    expect(s.indexOf("M $d 'OICI'")).toBeLessThan(s.indexOf('Copy-Item'))
    // SYSTEM and Administrators full control, Users read and execute, owner Administrators, protected.
    expect(s).toContain('"O:BAD:P(A;$i;FA;;;SY)(A;$i;FA;;;BA)(A;$i;0x1200a9;;;BU)"')
    expect(s).toContain(`if((Sha $t) -ne '${H1}'){throw 'helper.ps1 changed'}`)
    expect(s).toContain(`if((Sha $z) -ne '${H2}'){throw 'modules changed'}`)
    // PresentMon (Dynamic TDP) comes from next to helper.ps1 into the admin-only folder.
    expect(s).toContain(
      'Copy-Item -LiteralPath (Join-Path $cd PresentMon.exe) -Destination $d -Force'
    )
    expect(s).toContain("$_.Name -eq 'IntelMSR.bin'")
    // Quotes in paths are doubled inside PowerShell literals.
    expect(s).toContain("'C:\\Users\\O''Brien\\AppData")
  })

  it('registers a SYSTEM task that starts at boot, restarts on failure, and starts it now', () => {
    const s = installScript(options())
    for (const line of TASK_DEFINITION) expect(s).toContain(line)
    expect(TASK_DEFINITION).toContain(
      "$y=([Security.Principal.SecurityIdentifier]'S-1-5-18').Translate([Security.Principal.NTAccount]).Value"
    )
    expect(TASK_DEFINITION).toContain(
      '$u=New-ScheduledTaskPrincipal -UserId $y -LogonType ServiceAccount -RunLevel Highest'
    )
    expect(s).not.toContain(`-UserId '${SID}'`)
    expect(TASK_DEFINITION).toContain('$b=New-ScheduledTaskTrigger -AtStartup')
    expect(s).toContain('-RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)')
    expect(s).toContain("$tp='\\PlayOut\\';$tn='PowerHelper'")
    expect(s).toContain(
      'Register-ScheduledTask -TaskPath $tp -TaskName $tn -Action $c -Principal $u -Trigger $b -Settings $w -Force'
    )
    expect(s.indexOf('Start-ScheduledTask -TaskPath $tp -TaskName $tn')).toBeGreaterThan(
      s.indexOf('Register-ScheduledTask')
    )
    // The user's SID goes into the admin-only folder, for the pipe's ACL.
    expect(s).toContain(`[IO.File]::WriteAllText((Join-Path $d 'user.sid'),'${SID}')`)
    expect(HELPER_TASK).toBe('\\PlayOut\\PowerHelper')
  })

  it('refuses a bad SID or hash', () => {
    expect(() => installScript(options({ userSid: "S-1-5-21-1-2-3-1001'; calc" }))).toThrow(/SID/)
    expect(() => installScript(options({ helper: { path: 'x', sha256: 'zz' } }))).toThrow(/SHA/)
  })

  it('fits on the command line runElevated builds (32767 characters)', () => {
    const long =
      'C:\\Users\\' + 'a'.repeat(60) + '\\AppData\\Roaming\\PlayOut\\performance\\downloads'
    const s = installScript(
      options({
        helper: { path: `${long}\\helper.ps1`, sha256: H1 },
        modules: {
          path: `${long}\\modules\\0.2.11\\release_0_2_11.zip`,
          sha256: H2,
          module: 'RyzenSMU.bin'
        },
        setup: { path: `${long}\\setup\\2.2.0\\PawnIO_setup.exe`, sha256: H3 }
      })
    )
    expect(elevatedCommandLine(s).length).toBeLessThan(32_000)
  })
})

describe('remove script', () => {
  it('stops and deletes the task and the folder, and leaves PawnIO alone', () => {
    const s = removeScript()
    expect(s).toContain(
      "Unregister-ScheduledTask -TaskPath '\\PlayOut\\' -TaskName 'PowerHelper' -Confirm:$false"
    )
    expect(s).toContain('& $cmd /d /c rmdir /s /q $d')
    expect(s).not.toContain('Remove-Item')
    expect(s).not.toMatch(/PawnIO/i)
    expect(s.split('\n')[0]).toBe(PS_MODULE_PATH_RESET)
    expect(s).toContain(importModules(['Microsoft.PowerShell.Management', 'ScheduledTasks']))
    expect(s).toContain("[Environment]::GetFolderPath('CommonApplicationData')")
  })

  it('keeps the RivaTuner records in the admin-only parent before deleting the folder', () => {
    const s = removeScript()
    const keep = s.indexOf(
      "Move-Item -LiteralPath $rk -Destination (Join-Path $pd 'rtss-limits.json')"
    )
    expect(keep).toBeGreaterThan(-1)
    expect(keep).toBeLessThan(s.indexOf('rmdir /s /q $d'))
    // Never into (or out of) a junction.
    expect(s).toContain('-not ((Get-Item -LiteralPath $pd -Force).Attributes -band 1024)')
  })
})

describe('exit codes', () => {
  it('explains each one', () => {
    expect(installExitText(INSTALL_EXIT.CANCELLED)).toMatch(/declined/)
    expect(installExitText(INSTALL_EXIT.SETUP_UNSIGNED)).toMatch(/signed/)
    expect(installExitText(null)).toMatch(/did not finish/)
    expect(installExitText(77)).toMatch(/exit 77/)
  })
})

describe.skipIf(process.platform !== 'win32')('PowerShell parser', () => {
  it('parses every generated script without errors (nothing is run)', () => {
    const errors = parseErrors([
      helperScript(),
      installScript(options()),
      installScript(options({ setup: null })),
      removeScript()
    ])
    expect(errors).toEqual([[], [], [], []])
  }, 60_000)
})

/**
 * Runs pieces of the install script as this (non-elevated) user, on temp folders only: the folder checks, the ACL the
 * A function builds (built, never applied), the module imports and the task objects (built locally, never
 * registered). Nothing on the PC changes.
 */
describe.skipIf(process.platform !== 'win32')('install script pieces (run, harmless)', () => {
  it('rejects a junction and a user-owned folder, builds the admin ACL and the SYSTEM task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playout-folders-'))
    try {
      const check = [
        PS_MODULE_PATH_RESET,
        "$ErrorActionPreference='Stop'",
        importModules(INSTALL_MODULES),
        ...FOLDER_FUNCTIONS,
        `$root='${dir}'`,
        "$real=Join-Path $root 'real';New-Item -ItemType Directory -Path $real|Out-Null",
        "$target=Join-Path $root 'target';New-Item -ItemType Directory -Path $target|Out-Null",
        "$link=Join-Path $root 'link';cmd.exe /d /c mklink /J $link $target|Out-Null",
        '$r=@{}',
        '$r.ownerReal=O $real',
        '$r.me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        '$r.ownerLink=O $link',
        'try{V $real;$r.vReal="ok"}catch{$r.vReal=$_.Exception.Message}',
        'try{V $link;$r.vLink="ok"}catch{$r.vLink=$_.Exception.Message}',
        '$a=New-Object Security.AccessControl.DirectorySecurity',
        '$i=\'OICI\';$a.SetSecurityDescriptorSddlForm("O:BAD:P(A;$i;FA;;;SY)(A;$i;FA;;;BA)(A;$i;0x1200a9;;;BU)")',
        '$r.protected=$a.AreAccessRulesProtected',
        '$r.owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value',
        '$r.rules=@($a.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])|ForEach-Object{$_.IdentityReference.Value+" "+[string]$_.FileSystemRights+" "+[string]$_.InheritanceFlags})',
        "$t=Join-Path $root 'helper.ps1'",
        ...TASK_DEFINITION,
        '$r.taskUser=$u.UserId',
        '$r.taskLogon=[string]$u.LogonType',
        '$r.trigger=$b.CimClass.CimClassName',
        '$r.restart=@($w.RestartCount,$w.RestartInterval,$w.ExecutionTimeLimit)',
        '$r.exe=$c.Execute',
        'cmd.exe /d /c rmdir $link',
        '$r|ConvertTo-Json -Depth 4 -Compress'
      ].join('\n')
      const ps = spawnSync('powershell.exe', encodedPowerShellArgs(check), {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true
      })
      if (ps.status !== 0) throw new Error(ps.stderr || String(ps.error))
      const r = JSON.parse(ps.stdout.trim()) as Record<string, unknown>
      // A folder this user made is the user's: the install would remove it, and refuses it after New-Item.
      expect(r.ownerReal).toBe(r.me)
      expect(r.vReal).toMatch(/^bad /)
      // A junction is never trusted, whoever owns it.
      expect(r.ownerLink).toBe('')
      expect(r.vLink).toMatch(/^bad /)
      expect(r.protected).toBe(true)
      expect(r.owner).toBe('S-1-5-32-544')
      expect(r.rules).toEqual([
        'S-1-5-18 FullControl ContainerInherit, ObjectInherit',
        'S-1-5-32-544 FullControl ContainerInherit, ObjectInherit',
        'S-1-5-32-545 ReadAndExecute, Synchronize ContainerInherit, ObjectInherit'
      ])
      expect(r.taskUser).toMatch(/SYSTEM$/i)
      expect(r.taskLogon).toBe('ServiceAccount')
      expect(r.trigger).toBe('MSFT_TaskBootTrigger')
      expect(r.restart).toEqual([999, 'PT1M', 'PT0S'])
      expect(String(r.exe).toLowerCase()).toMatch(
        /\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

/** The PowerShell functions a script defines (`function Name(`). */
const definedFunctions = (script: string): string[] => [
  ...new Set([...script.matchAll(/function ([\w-]+)\(/g)].map((m) => m[1]!))
]

describe.skipIf(process.platform !== 'win32')('install script on real PowerShell', () => {
  it('defines no function an alias or command would shadow (aliases win over functions)', () => {
    const names = [
      ...definedFunctions(installScript(options())),
      ...definedFunctions(removeScript())
    ]
    expect(names.length).toBeGreaterThan(5)
    const check = [
      PS_MODULE_PATH_RESET,
      importModules(INSTALL_MODULES),
      `$r=@(foreach($n in @(${names.map((n) => `'${n}'`).join(',')})){$c=Get-Command $n -EA 0;if($c){"$n is $($c.CommandType) $($c.Definition)"}})`,
      'ConvertTo-Json -InputObject $r -Compress'
    ].join('\n')
    const ps = spawnSync('powershell.exe', encodedPowerShellArgs(check), {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    if (ps.status !== 0) throw new Error(ps.stderr || String(ps.error))
    // `h` is Get-History: a function named H was never called.
    expect(JSON.parse(ps.stdout.trim() || '[]')).toEqual([])
  }, 60_000)

  it('copies, checks and unpacks the files (the steps after the folder is made, run in a temp folder)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playout-install-'))
    try {
      const src = join(dir, 'downloads')
      const dest = join(dir, 'PowerHelper')
      const make = [
        "$ErrorActionPreference='Stop'",
        `$s='${src}';$d='${dest}'`,
        'New-Item -ItemType Directory -Path $s,$d,(Join-Path $s "zip/release/x64")|Out-Null',
        "Set-Content -LiteralPath (Join-Path $s 'helper.ps1') -Value 'helper' -Encoding ascii",
        "Set-Content -LiteralPath (Join-Path $s 'zip/release/x64/IntelMSR.bin') -Value 'module' -Encoding ascii",
        "Set-Content -LiteralPath (Join-Path $s 'PresentMon.exe') -Value 'presentmon' -Encoding ascii",
        "Compress-Archive -Path (Join-Path $s 'zip/*') -DestinationPath (Join-Path $s 'release_0_2_11.zip')",
        "foreach($f in 'helper.ps1','release_0_2_11.zip'){(Get-FileHash -LiteralPath (Join-Path $s $f)).Hash.ToLower()}"
      ].join('\n')
      const made = spawnSync('powershell.exe', encodedPowerShellArgs(make), {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true
      })
      if (made.status !== 0) throw new Error(made.stderr || String(made.error))
      const [helperHash, zipHash] = made.stdout.trim().split(/\r?\n/)
      const script = installScript(
        options({
          helper: { path: join(src, 'helper.ps1'), sha256: helperHash! },
          modules: {
            path: join(src, 'release_0_2_11.zip'),
            sha256: zipHash!,
            module: 'IntelMSR.bin'
          },
          setup: null
        })
      )
      // The generated file steps, as they are: from the helper copy to the user file.
      const start = script.indexOf('$t=Join-Path $d helper.ps1')
      const end = script.indexOf('\n', script.indexOf('[IO.File]::WriteAllText('))
      expect(start).toBeGreaterThan(0)
      const lines = script.split('\n')
      const sha = lines.find((l) => l.startsWith('function Sha('))!
      const check = [
        lines[0],
        "$ErrorActionPreference='Stop';$ProgressPreference=0",
        importModules(INSTALL_MODULES),
        sha,
        lines.find((l) => l.startsWith('$cd='))!,
        `$d='${dest}'`,
        script.slice(start, end),
        '(Get-ChildItem -LiteralPath $d -Name|Sort-Object) -join ","'
      ].join('\n')
      const ps = spawnSync('powershell.exe', encodedPowerShellArgs(check), {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true
      })
      if (ps.status !== 0) throw new Error(ps.stderr || String(ps.error))
      expect(ps.stdout.trim()).toBe('helper.ps1,IntelMSR.bin,PresentMon.exe,user.sid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
