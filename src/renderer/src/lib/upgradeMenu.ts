// What the Upgrade menu (screens/GameDetail/UpgradeMenu.tsx) shows for a status and the live progress, kept apart
// from the component so it can be tested without a DOM.
import type {
  DllKindSummary,
  UpgradeId,
  UpgradeProgress,
  UpgradeStatus,
  UpscalerDllKind
} from '@shared/upgrades'
import { t } from '../i18n'

/**
 * The line the menu shows instead of its rows, or null when it shows the rows. A blocked game shows only the reason,
 * except while an upgrade of it runs (the game was started meanwhile): then the rows stay, all disabled, so the
 * running line and Stop are still there.
 */
export function blockedOnly(
  status: Pick<UpgradeStatus, 'blocked' | 'busy'>,
  running: UpgradeProgress | null
): string | null {
  if (!status.blocked) return null
  return status.busy || running ? null : status.blocked
}

/** The running upgrade the menu offers Stop for (precompiling shaders, compressing), else null. */
export function stoppableUpgrade(
  status: Pick<UpgradeStatus, 'busy'> | null,
  running: UpgradeProgress | null
): UpgradeId | null {
  const upgrade = running?.upgrade ?? status?.busy ?? null
  return upgrade === 'shaders' || upgrade === 'compress' ? upgrade : null
}

/**
 * The shaders row's hint: why it is not offered, else why the last run could not be done (the row stays enabled),
 * else when it was last done (`done` formats the date), else what it does.
 */
export function shaderHint(
  shaders: UpgradeStatus['shaders'],
  done: (iso: string) => string
): string {
  return (
    shaders.unavailable ??
    shaders.note ??
    (shaders.compiledAt
      ? t('lib.upgrades.shadersDone', { date: done(shaders.compiledAt) })
      : t('lib.upgrades.shadersHint'))
  )
}

/** The short names of the upscaler files in the DLL row (the Vulkan / DirectX 11 variants share a name). */
const DLL_SHORT_NAMES: Record<UpscalerDllKind, string> = {
  dlss: 'DLSS',
  dlssg: 'DLSS Frame Gen',
  dlssd: 'DLSS Ray Reconstruction',
  'fsr-dx12': 'FSR',
  'fsr-vk': 'FSR',
  xess: 'XeSS',
  'xess-dx11': 'XeSS',
  'xess-fg': 'XeSS Frame Gen',
  xell: 'XeLL'
}

/**
 * A version and the newest one, shortened to two parts ("3.5 → 310.9"), or in full when the short forms would read
 * the same (FSR "3.1.1 → 3.1.4").
 */
function versionChange(from: string | null, to: string): string {
  const short = (v: string): string => v.split('.').slice(0, 2).join('.')
  if (!from) return `→ ${short(to)}`
  return short(from) === short(to) ? `${from} → ${to}` : `${short(from)} → ${short(to)}`
}

/**
 * The DLL row's hint across every kind in the game: the kinds that can be updated with their versions first, then the
 * others by name ("DLSS 3.5 → 310.9 · FSR · XeSS"); "Up to date" when the newest version of every kind is known and
 * none can be updated; "Newest versions unknown" when some newest version is not known yet (offline) and none can be.
 */
export function dllHint(dlls: Pick<UpgradeStatus['dlls'], 'found' | 'kinds'>): string {
  if (!dlls.found.length) return t('lib.upgrades.dllsNone')
  const kinds: DllKindSummary[] = dlls.kinds
  if (!kinds.some((k) => k.updatable))
    return kinds.some((k) => k.latest === null)
      ? t('lib.upgrades.dllsUnknown')
      : t('lib.upgrades.dllsUpToDate')
  const parts: string[] = []
  const named = new Set<string>()
  for (const k of [...kinds].sort((a, b) => Number(b.updatable) - Number(a.updatable))) {
    const name = DLL_SHORT_NAMES[k.kind]
    if (k.updatable && k.latest) {
      parts.push(`${name} ${versionChange(k.version, k.latest)}`)
      named.add(name)
    } else if (!named.has(name)) {
      parts.push(name)
      named.add(name)
    }
  }
  return parts.join(' · ')
}
