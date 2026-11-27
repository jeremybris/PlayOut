import { createHash } from 'crypto'
import { win32 } from 'path'
import { psQuote } from '../../system/powershell'
import { PRESENTMON_FILE } from '../presentmon'
import { helperCSharp } from './csharp'
import { HELPER_PROTOCOL_VERSION } from './protocol'
import { tMain } from '../../i18n'

/**
 * The PowerShell scripts around the power helper:
 * - helper.ps1: the host the scheduled task runs as SYSTEM from boot (compiles the C# and serves the pipe);
 * - the install script, run once elevated (the one UAC prompt);
 * - the remove script, run elevated too.
 *
 * The install script receives every file with its SHA-256 and checks each one after copying it into the admin-only
 * folder: what runs elevated later is exactly what PlayOut downloaded and generated, even though the downloads sit in
 * a user-writable cache until then.
 *
 * Nothing here trusts the user's environment. The task runs as SYSTEM (S-1-5-18), so its process environment is
 * SYSTEM's, not one a user-level process can seed through HKCU\Environment (COR_PROFILER, PSModulePath…); PlayOut
 * only reaches it through the pipe. The elevated install and remove scripts do inherit the user's environment, so they
 * (and helper.ps1) first reset PSModulePath to the system module folders and import every module they use by full
 * path from $PSHOME, take the folder from [Environment]::GetFolderPath('CommonApplicationData') (never a path from
 * PlayOut or %ProgramData%) and run system programs from [Environment]::SystemDirectory.
 */

/** Task Scheduler folder and name. */
export const HELPER_TASK_PATH = '\\PlayOut\\'
export const HELPER_TASK_NAME = 'PowerHelper'
export const HELPER_TASK = `${HELPER_TASK_PATH}${HELPER_TASK_NAME}`

/** Process names the helper watches: it puts the limits back two minutes after the last one is gone. */
export const HELPER_WATCH = 'PlayOut'

/** The file in the helper folder that names the user whose pipe the helper serves. */
export const HELPER_USER_FILE = 'user.sid'

/** Exit codes of the install and remove scripts (runElevated only returns the code). */
export const INSTALL_EXIT = {
  OK: 0,
  FAILED: 1,
  SETUP_CHANGED: 10,
  SETUP_UNSIGNED: 11,
  PAWNIO_FAILED: 12,
  FILES: 13,
  TASK: 14,
  CANCELLED: 1223
} as const

export function installExitText(code: number | null): string {
  switch (code) {
    case INSTALL_EXIT.OK:
      return 'installed'
    case INSTALL_EXIT.CANCELLED:
      return tMain('mainPerformance.install.declined')
    case INSTALL_EXIT.SETUP_CHANGED:
      return tMain('mainPerformance.install.pawnioChanged')
    case INSTALL_EXIT.SETUP_UNSIGNED:
      return tMain('mainPerformance.install.pawnioUnsigned')
    case INSTALL_EXIT.PAWNIO_FAILED:
      return tMain('mainPerformance.install.pawnioFailed')
    case INSTALL_EXIT.FILES:
      return tMain('mainPerformance.install.copyFailed')
    case INSTALL_EXIT.TASK:
      return tMain('mainPerformance.install.taskFailed')
    case null:
      return tMain('mainPerformance.install.unfinished')
    default:
      return tMain('mainPerformance.install.exitCode', { code })
  }
}

/**
 * The first statement of every elevated script: only the system module folders ($PSHOME\Modules is
 * System32\WindowsPowerShell\v1.0\Modules; SystemDirectory instead of %windir%, which a user variable can override).
 */
export const PS_MODULE_PATH_RESET =
  "$env:PSModulePath=$PSHOME+'\\Modules;'+[Environment]::SystemDirectory+'\\WindowsPowerShell\\v1.0\\Modules'"

/** Import-Module by full path from $PSHOME\Modules, so nothing is autoloaded by name. */
export function importModules(names: string[]): string {
  for (const n of names) if (!/^[\w.]+$/.test(n)) throw new Error(`Bad module name: ${n}`)
  return `foreach($n in ${names.map((n) => `'${n}'`).join(',')}){Import-Module "$PSHOME\\Modules\\$n\\$n.psd1" -EA Stop}`
}

/** The helper folder, from the known folder (not %ProgramData%, which the user's environment can override). */
const RESOLVE_DIR =
  "$pd=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PlayOut';$d=Join-Path $pd 'PowerHelper'"

/** helper.ps1: what the scheduled task runs as SYSTEM. */
export function helperScript(): string {
  return [
    `# PlayOut power helper, protocol ${HELPER_PROTOCOL_VERSION}. Run as SYSTEM by the scheduled task ${HELPER_TASK}.`,
    `# Serves \\\\.\\pipe\\PlayOutPower-<SID in ${HELPER_USER_FILE}> to that user, SYSTEM and Administrators.`,
    PS_MODULE_PATH_RESET,
    "$ErrorActionPreference = 'Stop'",
    importModules(['Microsoft.PowerShell.Utility']),
    '$dir = [IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path)',
    '$pawn = $null',
    "try { $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PawnIO'); if ($k) { $pawn = [string]$k.GetValue('InstallLocation'); $k.Close() } } catch { }",
    "if (-not $pawn) { $pawn = [IO.Path]::Combine([Environment]::GetFolderPath('ProgramFiles'), 'PawnIO') }",
    '# Add-Type compiles through %TEMP%: use a folder only administrators can write.',
    "$tmp = [IO.Path]::Combine($dir, 'tmp')",
    '[void][IO.Directory]::CreateDirectory($tmp)',
    '$env:TMP = $tmp',
    '$env:TEMP = $tmp',
    '$sid = $null',
    `try { $sid = [IO.File]::ReadAllText([IO.Path]::Combine($dir, '${HELPER_USER_FILE}')) } catch { }`,
    "Add-Type -ReferencedAssemblies System.Core, System.Web.Extensions -TypeDefinition @'",
    helperCSharp(),
    "'@",
    // Task Scheduler restarts a task only when it cannot start, not when it exits: a crash is retried here, once a
    // minute. Run only returns by itself on what a retry cannot fix (3: no valid user.sid, 2: the pipe is taken).
    'while ($true) {',
    '  $r = 1',
    `  try { $r = [PlayOutPower.Server]::Run($dir, $pawn, ${psQuote(HELPER_WATCH)}, $sid) } catch { try { Add-Content -LiteralPath ([IO.Path]::Combine($dir, 'helper.log')) -Value ((Get-Date -Format s) + ' crashed: ' + $_.Exception.Message) } catch { } }`,
    '  if ($r -eq 2 -or $r -eq 3) { exit $r }',
    '  Start-Sleep -Seconds 60',
    '}',
    ''
  ].join('\r\n')
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

export interface InstallScriptOptions {
  /**
   * The generated helper.ps1 in the cache, and its SHA-256. PresentMon.exe (presentmon.ts) waits next to it: it is
   * copied in too, without a hash check here (the command line has little room left for another hash), because the
   * helper checks its pinned hash with the file open deny-write before every start, so a swapped copy never runs.
   */
  helper: { path: string; sha256: string }
  /** The PawnIO.Modules release zip and its SHA-256, and the module to take from it. */
  modules: { path: string; sha256: string; module: 'IntelMSR.bin' | 'RyzenSMU.bin' }
  /** PawnIO_setup.exe and its SHA-256, when PawnIO is not installed yet. */
  setup: { path: string; sha256: string } | null
  /** The user signed in to PlayOut: the only user (with SYSTEM and Administrators) the pipe lets in. */
  userSid: string
}

const SID = /^S-1-5-21(-\d+){3,4}$/
const SHA = /^[0-9a-f]{64}$/

/** The modules the install script uses (everything else it calls is core or .NET). */
export const INSTALL_MODULES = [
  'Microsoft.PowerShell.Management',
  'Microsoft.PowerShell.Utility',
  'Microsoft.PowerShell.Security',
  'Microsoft.PowerShell.Archive',
  'ScheduledTasks'
]

/** The owners an admin-made folder may have: Administrators, SYSTEM. */
const ADMIN_OWNERS = "$k='S-1-5-32-544','S-1-5-18'"

/**
 * The install script's folder functions (exported for tests, which run O and V on real folders):
 * - O: the owner SID of a path that is not a reparse point ('' for a junction or link);
 * - U: remove a folder a user-level process made (a junction, or not owned by Administrators / SYSTEM);
 * - V: a real directory (not a reparse point) owned by Administrators or SYSTEM, else stop;
 * - A: SYSTEM and Administrators full control, Users read and execute, owner Administrators, nothing inherited from
 *   above ($i: 'OICI' to pass it on to everything inside, '' for this folder only);
 * - M: make a folder: U, New-Item, V, A, V (checked right after New-Item, before its ACL is set).
 */
export const FOLDER_FUNCTIONS = [
  ADMIN_OWNERS,
  "function O($p){if((Get-Item -LiteralPath $p -Force).Attributes -band 1024){return ''};(Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value}",
  `function U($p){if((Test-Path -LiteralPath $p) -and (O $p) -notin $k){& $cmd /d /c rmdir /s /q $p;if(Test-Path -LiteralPath $p){throw "rm $p"}}}`,
  `function V($p){if(-not (Get-Item -LiteralPath $p -Force).PSIsContainer -or (O $p) -notin $k){throw "bad $p"}}`,
  'function A($p,$i){$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetSecurityDescriptorSddlForm("O:BAD:P(A;$i;FA;;;SY)(A;$i;FA;;;BA)(A;$i;0x1200a9;;;BU)");Set-Acl -LiteralPath $p -AclObject $a}',
  'function M($p,$i){U $p;New-Item -ItemType Directory -Force -Path $p|Out-Null;V $p;A $p $i;V $p}'
]

/** The scheduled task: SYSTEM (by SID: the account name is localized), at startup, restarted when it fails. */
export const TASK_DEFINITION = [
  "$e=[Environment]::SystemDirectory+'\\WindowsPowerShell\\v1.0\\powershell.exe'",
  `$c=New-ScheduledTaskAction -Execute $e -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$t+'"')`,
  "$y=([Security.Principal.SecurityIdentifier]'S-1-5-18').Translate([Security.Principal.NTAccount]).Value",
  '$u=New-ScheduledTaskPrincipal -UserId $y -LogonType ServiceAccount -RunLevel Highest',
  '$b=New-ScheduledTaskTrigger -AtStartup',
  '$w=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)'
]

/**
 * The elevated install: the admin-only folder first (users may read), then PawnIO when missing (its installer is
 * copied into that folder and its hash and Authenticode signature checked there, so a user process cannot swap it
 * between the check and the run), helper.ps1, the module and user.sid copied in and checked, then the task (SYSTEM,
 * at startup, restarted on failure), started at once. Short on purpose: it travels on the command line
 * (-EncodedCommand), so no file a user process could swap is ever run.
 *
 * Users may create folders in ProgramData. A PlayOut or PowerHelper folder there that is a junction, or that is not
 * owned by Administrators or SYSTEM, was made by a user-level process (which could later rename or refill it), so it
 * is removed (rmdir does not follow junctions) and made again elevated. A user process may race that and plant a
 * junction between the removal and New-Item, so each folder is checked again right after it is made (a real
 * directory, owned by Administrators or SYSTEM) before its ACL is set or anything is written, and the install stops
 * otherwise. The log is only written once the folder passed that check. The PlayOut parent gets a protected ACL of its
 * own too: otherwise a user could rename the helper folder away and put another helper.ps1 where the task looks.
 */
export function installScript(o: InstallScriptOptions): string {
  if (!SID.test(o.userSid)) throw new Error(`Not a user SID: ${o.userSid}`)
  for (const h of [o.helper.sha256, o.modules.sha256, o.setup?.sha256 ?? '0'.repeat(64)])
    if (!SHA.test(h)) throw new Error('Bad SHA-256')
  const E = INSTALL_EXIT
  const q = psQuote
  // The cache folder ($cd, helper.ps1's): files under it are named relative to it, which keeps the command line short.
  const cache = win32.dirname(o.helper.path)
  const src = (p: string): string => {
    const rel = win32.relative(cache, p)
    return rel && !rel.startsWith('..') && !win32.isAbsolute(rel)
      ? `(Join-Path $cd ${q(rel)})`
      : q(p)
  }
  return [
    PS_MODULE_PATH_RESET,
    "$ErrorActionPreference='Stop';$ProgressPreference=0",
    `$cd=${q(cache)}`,
    'function Sha($p){(Get-FileHash -LiteralPath $p).Hash.ToLower()}',
    'function L($m){if($ok){try{Add-Content -LiteralPath (Join-Path $d install.log) -Value ((Get-Date -Format s)+" $m")}catch{}}}',
    ...FOLDER_FUNCTIONS,
    'try{',
    importModules(INSTALL_MODULES),
    "$cmd=[Environment]::SystemDirectory+'\\cmd.exe'",
    RESOLVE_DIR,
    'try{',
    // PlayOut's own parent only, and its entries do not inherit, so nothing below it is walked or changed.
    "M $pd '';M $d 'OICI'",
    '$ok=$true',
    `}catch{exit ${E.FILES}}`,
    o.setup
      ? [
          `$s=Join-Path $d PawnIO_setup.exe;Copy-Item -LiteralPath ${src(o.setup.path)} -Destination $s -Force`,
          `if((Sha $s) -ne '${o.setup.sha256}'){exit ${E.SETUP_CHANGED}}`,
          '$g=Get-AuthenticodeSignature -LiteralPath $s',
          `if($g.Status -ne 'Valid' -or $g.SignerCertificate.Subject -notmatch '(^|,\\s*)CN=namazso\\.eu(,|$)'){exit ${E.SETUP_UNSIGNED}}`,
          "$p=Start-Process -FilePath $s -ArgumentList '-install -silent' -Wait -PassThru",
          'Remove-Item -LiteralPath $s -Force -EA 0',
          // 3010 = ERROR_SUCCESS_REBOOT_REQUIRED: installed, a restart finishes it.
          `if($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010){exit ${E.PAWNIO_FAILED}}`
        ].join('\n')
      : '',
    // An older helper still serving the pipe would keep running the old code: stop it (its state.json stays, so the
    // new one still restores the firmware's limits).
    `$tp=${q(HELPER_TASK_PATH)};$tn=${q(HELPER_TASK_NAME)}`,
    'try{Stop-ScheduledTask -TaskPath $tp -TaskName $tn}catch{}',
    'try{',
    `$t=Join-Path $d helper.ps1;Copy-Item -LiteralPath ${src(o.helper.path)} -Destination $t -Force`,
    `if((Sha $t) -ne '${o.helper.sha256}'){throw 'helper.ps1 changed'}`,
    `$z=Join-Path $d modules.zip;Copy-Item -LiteralPath ${src(o.modules.path)} -Destination $z -Force`,
    `if((Sha $z) -ne '${o.modules.sha256}'){throw 'modules changed'}`,
    '$x=Join-Path $d modules;Remove-Item -LiteralPath $x -Recurse -Force -EA 0',
    'Expand-Archive -LiteralPath $z -DestinationPath $x -Force',
    `$m=Get-ChildItem -LiteralPath $x -Recurse -File|Where-Object{$_.Name -eq ${q(o.modules.module)}}|Select-Object -First 1`,
    "if(-not $m){throw 'module missing'}",
    `Copy-Item -LiteralPath $m.FullName -Destination (Join-Path $d ${q(o.modules.module)}) -Force`,
    'Remove-Item -LiteralPath $x,$z -Recurse -Force -EA 0',
    // Dynamic TDP's frame-rate source, from next to helper.ps1 (the helper checks its pinned hash before every start).
    `Copy-Item -LiteralPath (Join-Path $cd ${PRESENTMON_FILE}) -Destination $d -Force`,
    `[IO.File]::WriteAllText((Join-Path $d ${q(HELPER_USER_FILE)}),'${o.userSid}')`,
    `}catch{L $_.Exception.Message;exit ${E.FILES}}`,
    'try{',
    ...TASK_DEFINITION,
    'Register-ScheduledTask -TaskPath $tp -TaskName $tn -Action $c -Principal $u -Trigger $b -Settings $w -Force|Out-Null',
    'Start-ScheduledTask -TaskPath $tp -TaskName $tn',
    `}catch{L $_.Exception.Message;exit ${E.TASK}}`,
    `exit ${E.OK}`,
    `}catch{L $_.Exception.Message;exit ${E.FAILED}}`
  ]
    .filter(Boolean)
    .join('\n')
}

/** The helper's record of the RivaTuner profiles it changed (csharp.ts Rtss), in its folder. */
export const RTSS_RECORDS_FILE = 'rtss-limits.json'

/**
 * The elevated removal: stop and delete the task, delete the folder. PawnIO itself stays installed. PlayOut asks the
 * helper to put every RivaTuner profile back first (rtssRestore); when it could not, the helper's record of them is
 * kept in the admin-only PlayOut folder (a real folder, never a junction): a helper installed later takes it back when it starts, so the
 * limits can still be put back instead of being re-recorded as the "original".
 */
export function removeScript(): string {
  return [
    PS_MODULE_PATH_RESET,
    "$ErrorActionPreference='SilentlyContinue'",
    importModules(['Microsoft.PowerShell.Management', 'ScheduledTasks']),
    `Stop-ScheduledTask -TaskPath ${psQuote(HELPER_TASK_PATH)} -TaskName ${psQuote(HELPER_TASK_NAME)}`,
    `Unregister-ScheduledTask -TaskPath ${psQuote(HELPER_TASK_PATH)} -TaskName ${psQuote(HELPER_TASK_NAME)} -Confirm:$false`,
    RESOLVE_DIR,
    "$cmd=[Environment]::SystemDirectory+'\\cmd.exe'",
    `$rk=Join-Path $d ${psQuote(RTSS_RECORDS_FILE)}`,
    'if((Test-Path -LiteralPath $rk) -and -not ((Get-Item -LiteralPath $pd -Force).Attributes -band 1024) -and -not ((Get-Item -LiteralPath $d -Force).Attributes -band 1024)){Move-Item -LiteralPath $rk -Destination (Join-Path $pd ' +
      psQuote(RTSS_RECORDS_FILE) +
      ') -Force}',
    // rmdir, not Remove-Item -Recurse: Windows PowerShell 5.1 can follow a junction and empty its target.
    'if(Test-Path -LiteralPath $d){& $cmd /d /c rmdir /s /q $d}',
    `if(Test-Path -LiteralPath $d){exit ${INSTALL_EXIT.FILES}}`,
    `exit ${INSTALL_EXIT.OK}`
  ].join('\n')
}
