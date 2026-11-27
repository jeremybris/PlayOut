// Windows Firewall for hosting (docs/streaming.md, "Firewall"). Other PCs reach the host on TCP <port> (pairing, the
// game list, ROM downloads) and find it on UDP <port + 1> (discovery). Windows only opens a program's ports through
// the "allow access" prompt it shows the first time the program listens, and that prompt covers Private networks
// unless Public is ticked: on a home network Windows calls Public (the default for a new Wi-Fi), or after a dismissed
// prompt (a Block rule for the exe), every connection is dropped. Clients then show the host offline and keep its
// last saved game list, so games the host found since never reach them. Sunshine's installer adds its own rules.
//
// PlayOut adds two inbound Allow rules of its own (group "PlayOut", every network profile, by port so they survive
// updates and the portable build's changing exe path) and switches off the Block rules Windows made for this exe. The
// host server only answers paired PCs over pinned TLS, as Sunshine's ports do.
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { psQuote as quote } from '../system/powershell'
import { tMain } from '../i18n'

export const FIREWALL_GROUP = 'PlayOut'

export type FirewallResult = 'ok' | 'added' | 'declined' | 'failed' | 'unknown'

export interface FirewallState {
  /**
   * `tcp/udp` ports whose admin prompt was declined, timed out or failed: not asked again (at every start and wake)
   * until hosting is switched on again.
   */
  declined?: string
  /** What that attempt gave. */
  outcome?: 'declined' | 'failed'
}

function checkPorts(tcp: number, udp: number): void {
  for (const p of [tcp, udp])
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`invalid port ${p}`)
}

/**
 * Read-only (no admin needed): prints `{"tcp":bool,"udp":bool,"blocks":n}`, whether PlayOut's Allow rules for these
 * ports exist for every profile, and how many enabled inbound Block rules Windows made for this exe from its "allow
 * access" prompt (named "TCP/UDP Query User{…}"; a Block rule the user made on purpose is left alone).
 */
export function firewallCheckScript(tcp: number, udp: number, exe: string): string {
  checkPorts(tcp, udp)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$exe = ${quote(exe)}`,
    'function Has($proto, $port) {',
    `  foreach ($r in @(Get-NetFirewallRule -Group ${quote(FIREWALL_GROUP)} -ErrorAction SilentlyContinue)) {`,
    "    if ($r.Direction -ne 'Inbound' -or $r.Action -ne 'Allow' -or \"$($r.Enabled)\" -ne 'True' -or \"$($r.Profile)\" -ne 'Any') { continue }",
    '    $f = $r | Get-NetFirewallPortFilter',
    '    if ("$($f.Protocol)" -eq $proto -and "$($f.LocalPort)" -eq "$port") { return $true }',
    '  }',
    '  return $false',
    '}',
    'function Blocks() {',
    '  @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -and [Environment]::ExpandEnvironmentVariables($_.Program) -eq $exe } |',
    "    Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Name -match '^(TCP|UDP) Query User\\{' -and \"$($_.Enabled)\" -eq 'True' })",
    '}',
    `[pscustomobject]@{ tcp = (Has 'TCP' ${tcp}); udp = (Has 'UDP' ${udp}); blocks = @(Blocks).Count } | ConvertTo-Json -Compress`,
    // compressedPowerShellArgs reports a script without an exit code as failed.
    'exit 0'
  ].join('\n')
}

/**
 * Run elevated: PlayOut's two rules (replacing older ones, another port included), and the Block rules Windows made for
 * this exe from a dismissed prompt switched off (not deleted; a Block rule the user made is not touched).
 */
export function firewallApplyScript(tcp: number, udp: number, exe: string): string {
  checkPorts(tcp, udp)
  const group = quote(FIREWALL_GROUP)
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $exe = ${quote(exe)}`,
    `  Get-NetFirewallRule -Group ${group} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `  New-NetFirewallRule -DisplayName 'PlayOut hosting (TCP ${tcp})' -Group ${group} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${tcp} -Profile Any | Out-Null`,
    `  New-NetFirewallRule -DisplayName 'PlayOut discovery (UDP ${udp})' -Group ${group} -Direction Inbound -Action Allow -Protocol UDP -LocalPort ${udp} -Profile Any | Out-Null`,
    '  Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -and [Environment]::ExpandEnvironmentVariables($_.Program) -eq $exe } |',
    "    Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Name -match '^(TCP|UDP) Query User\\{' } | Disable-NetFirewallRule",
    '} catch { exit 1 }',
    'exit 0'
  ].join('\n')
}

export function parseFirewallCheck(
  stdout: string
): { tcp: boolean; udp: boolean; blocks: number } | null {
  try {
    const v = JSON.parse(stdout.trim()) as Record<string, unknown>
    if (typeof v.tcp !== 'boolean' || typeof v.udp !== 'boolean' || typeof v.blocks !== 'number')
      return null
    return { tcp: v.tcp, udp: v.udp, blocks: v.blocks }
  } catch {
    return null
  }
}

export interface HostFirewallDeps {
  /** The running exe (process.execPath): the one Windows' Block rules name. */
  exe: string
  /** Run a script without elevation; stdout and exit code. */
  runScript(script: string): Promise<{ code: number | null; stdout: string }>
  /** Run a script elevated (one UAC prompt); its exit code, 1223 when declined, null when it could not run. */
  runElevatedScript(script: string): Promise<number | null>
  /** userData/streaming/firewall.json */
  stateFile: string
  log: { info(m: string): void; warn(m: string): void }
}

export interface HostFirewall {
  /** Make sure other PCs can reach these ports; asks for admin once when the rules are missing. */
  ensure(tcp: number, udp: number): Promise<FirewallResult>
  /** Hosting switched on by the user: a declined prompt is asked again. */
  forgetDeclined(): Promise<void>
}

export function createHostFirewall(deps: HostFirewallDeps): HostFirewall {
  async function readState(): Promise<FirewallState> {
    try {
      const v = JSON.parse(await fs.readFile(deps.stateFile, 'utf8')) as FirewallState
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  }
  async function writeState(state: FirewallState): Promise<void> {
    await fs.mkdir(dirname(deps.stateFile), { recursive: true })
    await fs.writeFile(deps.stateFile, JSON.stringify(state))
  }
  async function check(tcp: number, udp: number): Promise<boolean | null> {
    const r = await deps
      .runScript(firewallCheckScript(tcp, udp, deps.exe))
      .catch(() => ({ code: null, stdout: '' }))
    const v = r.code === 0 ? parseFirewallCheck(r.stdout) : null
    if (!v) return null
    return v.tcp && v.udp && v.blocks === 0
  }

  /** One check-and-prompt at a time: a host start overtaken while its prompt is up must not open a second one. */
  let pending: { key: string; result: Promise<FirewallResult> } | null = null
  /** Bumped by forgetDeclined: an attempt started before it does not record its outcome. */
  let epoch = 0

  async function attempt(tcp: number, udp: number, key: string): Promise<FirewallResult> {
    const open = await check(tcp, udp)
    if (open === null) {
      deps.log.warn('firewall: could not read the Windows Firewall rules')
      return 'unknown'
    }
    if (open) return 'ok'
    const state = await readState()
    if (state.declined === key) return state.outcome ?? 'declined'
    const started = epoch
    deps.log.info(`firewall: opening TCP ${tcp} and UDP ${udp} for other PCs (admin prompt)`)
    const code = await deps
      .runElevatedScript(firewallApplyScript(tcp, udp, deps.exe))
      .catch(() => null)
    let outcome: 'declined' | 'failed' | null = null
    if (code === 1223) {
      outcome = 'declined'
      deps.log.warn('firewall: the admin prompt was declined')
    } else if (code !== 0 || !(await check(tcp, udp))) {
      // Not answered in time, could not run, or still blocked: not asked again at every start either.
      outcome = 'failed'
      deps.log.warn(`firewall: adding the rules failed (exit ${code})`)
    }
    if (epoch === started)
      await writeState(outcome ? { declined: key, outcome } : {}).catch(() => undefined)
    if (outcome) return outcome
    deps.log.info('firewall: other PCs can reach this one')
    return 'added'
  }

  return {
    ensure(tcp, udp) {
      const key = `${tcp}/${udp}`
      if (pending?.key === key) return pending.result
      const result = attempt(tcp, udp, key).finally(() => {
        if (pending?.result === result) pending = null
      })
      pending = { key, result }
      return result
    },
    async forgetDeclined() {
      epoch++
      if ((await readState()).declined) await writeState({})
    }
  }
}

/** The host status text for a firewall that still blocks other PCs, or null. */
export function firewallProblem(result: FirewallResult, tcp: number): string | null {
  if (result === 'declined') return tMain('mainStreaming.firewall.blockedRetry', { port: tcp })
  if (result === 'failed') return tMain('mainStreaming.firewall.blocked', { tcp, udp: tcp + 1 })
  return null
}
