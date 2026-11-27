import { promises as fs } from 'fs'
import { join } from 'path'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type { ClientInfo, ScannedGame } from '../../shared/types'
import { createLogger } from '../logger'
import { asArray, runPowerShellJson } from '../system/powershell'
import { isFile } from '../util/fs'
import { removeTrademarks } from '../util/text'
import type { GameProvider, ScanContext } from './types'
import { tMain } from '../i18n'

const log = createLogger('providers:xbox')

const XBOX_APP_NAME = 'Microsoft.GamingApp'
const STORE_APP_NAME = 'Microsoft.WindowsStore'

/** Packages that carry gaming markers but are platform components, not games. */
const NOT_GAMES = new Set([
  'Microsoft.GamingApp',
  'Microsoft.GamingServices',
  'Microsoft.XboxApp',
  'Microsoft.XboxIdentityProvider',
  'Microsoft.XboxGamingOverlay',
  'Microsoft.XboxGameOverlay',
  'Microsoft.XboxGameCallableUI',
  'Microsoft.XboxSpeechToTextOverlay',
  'Microsoft.Xbox.TCUI',
  'Microsoft.WindowsStore',
  'Microsoft.StorePurchaseApp'
])

// ---------------------------------------------------------------------------
// PowerShell: list packages with the manifest facts PlayOut needs (one process for everything)
// ---------------------------------------------------------------------------

/** One row per package as produced by the enumeration script. */
export interface AppxPackageRecord {
  name: string
  packageFamilyName: string
  packageFullName: string
  publisher: string
  publisherId?: string
  version?: string
  installLocation: string
  signatureKind: string
  hasGameConfig: boolean
  gameConfigDisplayName?: string | null
  gameConfigExecutable?: string | null
  titleId?: string | null
  storeId?: string | null
  /** Package DisplayName with ms-resource: strings resolved (null when unresolvable). */
  displayName?: string | null
  publisherDisplayName?: string | null
  appId?: string | null
  appDisplayName?: string | null
  protocols?: string[] | string | null
  /** Existing logo files in priority order, each already the largest scale variant found. */
  logos?: string[] | string | null
  error?: string | null
  /** Filled by the provider: the install location with junctions resolved. */
  realInstallLocation?: string
}

const SHLWAPI_TYPE = `
if (-not ('PlayOut.Shlwapi' -as [type])) {
  Add-Type -Namespace PlayOut -Name Shlwapi -MemberDefinition '[DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] public static extern int SHLoadIndirectString(string pszSource, System.Text.StringBuilder pszOutBuf, int cchOutBuf, IntPtr ppvReserved);'
}
function Resolve-MsResource([string]$full, [string]$name, [string]$value) {
  if (-not $value) { return $null }
  if (-not $value.StartsWith('ms-resource', [StringComparison]::OrdinalIgnoreCase)) { return $value }
  $key = $value.Substring(12).TrimStart('/')
  $cands = @()
  if ($value.StartsWith('ms-resource://', [StringComparison]::OrdinalIgnoreCase)) { $cands += ('@{' + $full + '?' + $value + '}') }
  else {
    $cands += ('@{' + $full + '?ms-resource://' + $name + '/resources/' + $key + '}')
    $cands += ('@{' + $full + '?ms-resource://' + $name + '/' + $key + '}')
  }
  foreach ($c in $cands) {
    $sb = New-Object System.Text.StringBuilder 2048
    try { $hr = [PlayOut.Shlwapi]::SHLoadIndirectString($c, $sb, 2048, [IntPtr]::Zero) } catch { $hr = -1 }
    if ($hr -eq 0 -and $sb.Length -gt 0) { return $sb.ToString() }
  }
  return $null
}
`

const RESOLVE_LOGO = `
function Resolve-Logo([string]$dir, [string]$rel) {
  if (-not $rel) { return $null }
  $p = Join-Path $dir ($rel -replace '/', '\\')
  if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
  $d = Split-Path $p -Parent
  if (-not (Test-Path -LiteralPath $d)) { return $null }
  $leaf = Split-Path $p -Leaf
  $stem = [IO.Path]::GetFileNameWithoutExtension($leaf)
  $ext = [IO.Path]::GetExtension($leaf)
  $pattern = '^' + [regex]::Escape($stem) + '\\.(scale|targetsize)-(\\d+)(_[^.]*)?' + [regex]::Escape($ext) + '$'
  $best = $null; $bestScore = -1
  foreach ($f in Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue) {
    if ($f.Name -match $pattern) {
      $score = [int]$matches[2]; if ($matches[1] -eq 'scale') { $score += 100000 }
      if ($score -gt $bestScore) { $bestScore = $score; $best = $f.FullName }
    }
  }
  return $best
}
`

const ENUMERATE_SCRIPT = `${SHLWAPI_TYPE}${RESOLVE_LOGO}
$out = @()
foreach ($p in (Get-AppxPackage -PackageTypeFilter Main)) {
  if ($p.IsFramework -or $p.IsResourcePackage) { continue }
  if ([string]$p.SignatureKind -notin @('Store', 'Developer')) { continue }
  $loc = [string]$p.InstallLocation
  if (-not $loc -or -not (Test-Path -LiteralPath $loc)) { continue }
  $manifestPath = Join-Path $loc 'AppxManifest.xml'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
  $rec = [ordered]@{
    name = [string]$p.Name; packageFamilyName = [string]$p.PackageFamilyName; packageFullName = [string]$p.PackageFullName
    publisher = [string]$p.Publisher; publisherId = [string]$p.PublisherId; version = [string]$p.Version
    installLocation = $loc; signatureKind = [string]$p.SignatureKind
    hasGameConfig = $false; gameConfigDisplayName = $null; gameConfigExecutable = $null; titleId = $null; storeId = $null
    displayName = $null; publisherDisplayName = $null; appId = $null; appDisplayName = $null
    protocols = @(); logos = @(); error = $null
  }
  try {
    $x = New-Object System.Xml.XmlDocument
    $x.Load($manifestPath)
    $props = $x.Package.Properties
    $rec.displayName = Resolve-MsResource $p.PackageFullName $p.Name ([string]$props.DisplayName)
    $rec.publisherDisplayName = Resolve-MsResource $p.PackageFullName $p.Name ([string]$props.PublisherDisplayName)
    $logoRels = @()
    $apps = @($x.Package.Applications.Application | Where-Object { $_ })
    if ($apps.Count -gt 0) {
      $app = $apps[0]
      $rec.appId = [string]$app.GetAttribute('Id')
      $ve = $app.VisualElements
      if ($ve) {
        $rec.appDisplayName = Resolve-MsResource $p.PackageFullName $p.Name ([string]$ve.GetAttribute('DisplayName'))
        foreach ($a in 'Square150x150Logo', 'Square70x70Logo', 'Square44x44Logo') { $v = $ve.GetAttribute($a); if ($v) { $logoRels += $v } }
      }
      foreach ($ext in @($app.Extensions.Extension | Where-Object { $_ })) {
        if ($ext.GetAttribute('Category') -eq 'windows.protocol' -and $ext.Protocol) { $rec.protocols += [string]$ext.Protocol.GetAttribute('Name') }
      }
    }
    if ($props.Logo) { $logoRels += [string]$props.Logo }
    foreach ($r in $logoRels) { $f = Resolve-Logo $loc $r; if ($f -and $rec.logos -notcontains $f) { $rec.logos += $f } }
  } catch { $rec.error = $_.Exception.Message }
  $cfgPath = Join-Path $loc 'MicrosoftGame.config'
  if (Test-Path -LiteralPath $cfgPath -PathType Leaf) {
    $rec.hasGameConfig = $true
    try {
      $g = New-Object System.Xml.XmlDocument
      $g.Load($cfgPath)
      $sv = $g.Game.ShellVisuals
      if ($sv) { $rec.gameConfigDisplayName = [string]$sv.GetAttribute('DefaultDisplayName') }
      $exe = @($g.Game.ExecutableList.Executable | Where-Object { $_ })
      if ($exe.Count -gt 0) { $rec.gameConfigExecutable = [string]$exe[0].GetAttribute('Name') }
      $rec.titleId = [string]$g.Game.TitleId
      $rec.storeId = [string]$g.Game.StoreId
    } catch { if (-not $rec.error) { $rec.error = $_.Exception.Message } }
  }
  $out += [pscustomobject]$rec
}
$out
`

const CLIENT_SCRIPT = `
$apps = @(Get-AppxPackage -Name '${XBOX_APP_NAME}' | Where-Object { $_ })
if ($apps.Count -eq 0) { $apps = @(Get-AppxPackage -Name '${STORE_APP_NAME}' | Where-Object { $_ }) }
if ($apps.Count -gt 0) { [pscustomobject]@{ name = [string]$apps[0].Name; path = [string]$apps[0].InstallLocation; version = [string]$apps[0].Version } }
`

// ---------------------------------------------------------------------------
// Mapping (pure)
// ---------------------------------------------------------------------------

const XBL_PROTOCOL = /^ms-xbl-/i

export function isGamePackage(record: AppxPackageRecord): boolean {
  if (NOT_GAMES.has(record.name)) return false
  if (record.hasGameConfig) return true
  return asArray(record.protocols).some((p) => XBL_PROTOCOL.test(p))
}

/** Playnite's Xbox name clean-up plus trademark removal. */
export function cleanTitle(name: string): string {
  return removeTrademarks(
    name
      .replace(/\((PC|Windows|Windows 10|Windows 10 \+ Xbox|Xbox)\)/gi, '')
      .replace(/\bfor Windows 10\b/gi, '')
      .replace(/\s+-\s+Windows 10\b/gi, '')
      .replace(/\bWindows 10 Edition\b/gi, '')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function usable(value: string | null | undefined): string | undefined {
  const text = value?.trim()
  if (!text || text.toLowerCase().startsWith('ms-resource')) return undefined
  return text
}

/** Title: package DisplayName, MicrosoftGame.config DefaultDisplayName, application DisplayName, then the package name. */
export function titleFor(record: AppxPackageRecord): string {
  const raw =
    usable(record.displayName) ??
    usable(record.gameConfigDisplayName) ??
    usable(record.appDisplayName) ??
    record.name.split('.').pop() ??
    record.name
  return cleanTitle(raw) || raw
}

export function buildScannedGame(record: AppxPackageRecord, exePath?: string): ScannedGame {
  const installDir = record.realInstallLocation ?? record.installLocation
  const appId = usable(record.appId) ?? 'App'
  const extra: Record<string, string> = { packageFullName: record.packageFullName, appId }
  if (usable(record.titleId)) extra.titleId = record.titleId!.trim()
  if (usable(record.storeId)) extra.storeId = record.storeId!.trim()
  if (usable(record.publisherDisplayName))
    extra.publisherDisplayName = record.publisherDisplayName!.trim()
  const game: ScannedGame = {
    source: 'xbox',
    externalId: record.packageFamilyName,
    platformId: STORE_PLATFORMS.xbox.id,
    title: titleFor(record),
    installDir,
    exePath,
    launch: { kind: 'uwp', aumid: `${record.packageFamilyName}!${appId}` },
    tracking: { mode: 'uwp', packageFamilyName: record.packageFamilyName },
    extra
  }
  const logo = asArray(record.logos).find((l) => l)
  if (logo) game.localMedia = { icon: logo }
  return game
}

export function mapPackages(records: AppxPackageRecord[]): ScannedGame[] {
  const games: ScannedGame[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (!record?.packageFamilyName || !isGamePackage(record) || seen.has(record.packageFamilyName))
      continue
    seen.add(record.packageFamilyName)
    games.push(buildScannedGame(record))
  }
  return games
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

async function realPath(path: string): Promise<string> {
  try {
    return await fs.realpath(path)
  } catch {
    return path
  }
}

async function scan(ctx: ScanContext): Promise<ScannedGame[]> {
  const raw = await runPowerShellJson<AppxPackageRecord | AppxPackageRecord[]>(ENUMERATE_SCRIPT, {
    timeoutMs: 120_000,
    depth: 4
  })
  // No output means PowerShell failed or timed out, not "no games": every Windows install lists some packages, and
  // an empty answer would mark all the source's games uninstalled.
  if (raw === null) throw new Error(tMain('mainApp.scan.xboxPackages'))
  const records = asArray(raw).filter((r) => r && typeof r === 'object')
  ctx.log.debug(`xbox: ${records.length} package(s) enumerated`)
  for (const r of records) if (r.error) ctx.log.warn(`xbox: ${r.name}: ${r.error}`)

  const candidates = records.filter(isGamePackage)
  const games: ScannedGame[] = []
  for (const record of candidates) {
    try {
      // Store packages under WindowsApps are junctions to <drive>:\XboxGames\<game>\Content; track the real folder.
      record.realInstallLocation = await realPath(record.installLocation)
      let exePath: string | undefined
      const exeRel = usable(record.gameConfigExecutable)
      if (exeRel) {
        const candidate = join(record.realInstallLocation, exeRel.replace(/\//g, '\\'))
        if (await isFile(candidate)) exePath = candidate
      }
      const game = buildScannedGame(record, exePath)
      if (games.some((g) => g.externalId === game.externalId)) continue
      games.push(game)
      ctx.progress(games.length, game.title)
    } catch (err) {
      ctx.log.warn(`xbox: skipping ${record.packageFamilyName}: ${(err as Error).message}`)
    }
  }
  ctx.log.info(`xbox: ${games.length} game(s) among ${records.length} package(s)`)
  return games
}

export const xboxProvider: GameProvider = {
  id: 'xbox',
  name: 'Xbox',
  platforms: () => [STORE_PLATFORMS.xbox],
  async detectClient(): Promise<ClientInfo> {
    try {
      const info = await runPowerShellJson<{ name?: string; path?: string; version?: string }>(
        CLIENT_SCRIPT,
        { timeoutMs: 60_000 }
      )
      if (!info || typeof info !== 'object' || !info.name) return { installed: false }
      return { installed: true, path: info.path || undefined, version: info.version || undefined }
    } catch (err) {
      log.warn(`detectClient failed: ${(err as Error).message}`)
      return { installed: false }
    }
  },
  scanInstalled: scan
}
