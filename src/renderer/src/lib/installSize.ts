import { recompInPlaceOf } from '@shared/recomp-play'
import type { Game } from '@shared/types'
import { t } from '../i18n'
import { formatBytes } from './format'

/** What the size helpers read of a game. */
type SizedGame = Pick<Game, 'installed' | 'installSize' | 'metadata' | 'user'> &
  Partial<Pick<Game, 'source' | 'romRemoved' | 'remote'>>

/**
 * The size measured on this PC: an installed game's, or for a game played from its recompilation (its disc image
 * deleted or moved: recompInPlaceOf) the recompilation folder's, else the disc image's last size until that is
 * measured. undefined when there is none (a folder that could not be added up counts as none).
 */
export function measuredSize(game: SizedGame): NonNullable<Game['installSize']> | undefined {
  const inPlace = !!game.source && recompInPlaceOf({ ...game, source: game.source }) !== null
  if (!game.installed && !inPlace) return undefined
  const size = game.installSize ?? (inPlace ? game.romRemoved?.installSize : undefined)
  return size && !size.unmeasurable ? size : undefined
}

/** The game is played on this PC (installed, or through its recompilation) and its size can be measured. */
function measurable(game: SizedGame): boolean {
  if (game.installed) return !game.installSize?.unmeasurable
  return !!game.source && recompInPlaceOf({ ...game, source: game.source }) !== null
}

/**
 * The size shown right of Play / Install: what the installed game takes on disk, or for a game that is not installed
 * the store's storage requirement, marked as an estimate. null when neither is known (the stat is left out).
 */
export function installSizeText(
  game: SizedGame
): { label: string; value: string; estimate: boolean } | null {
  const label = t('lib.installSize.label')
  // The size the user entered wins over anything PlayOut found.
  if (game.user.installSize)
    return { label, value: formatBytes(game.user.installSize), estimate: false }
  if (measurable(game)) {
    const size = measuredSize(game)
    return { label, value: size ? formatBytes(size.bytes) : '—', estimate: false }
  }
  const storage = game.metadata.storage
  if (!storage?.bytes) return null
  // What Steam or Epic installs for this very game is exact; another store's copy, an installer or a requirement is not.
  const estimate = (storage.how !== 'steam' && storage.how !== 'epic') || !!storage.approximate
  return {
    label,
    value: estimate
      ? t('lib.installSize.about', { size: formatBytes(storage.bytes) })
      : formatBytes(storage.bytes),
    estimate
  }
}

const UNITS: Record<string, number> = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }

/**
 * A size the user typed ("45 GB", "800mb", "1.5 TB", "45" = GB) in bytes; undefined for an empty field, NaN for
 * text that is not a size.
 */
export function parseSizeInput(text: string): number | undefined {
  const t = text.trim().toLowerCase()
  if (!t) return undefined
  // A unit is k / m / g / t with an optional b ("45 GB", "45g"); a bare "b" is not one. No unit means GB.
  const m = /^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*(?:([kmgt])b?)?$/.exec(t)
  if (!m) return Number.NaN
  const unit = `${m[2] ?? 'g'}b`
  // "1,200 MB" groups thousands; "1,5 GB" is a decimal comma.
  const digits = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(m[1])
    ? m[1].replace(/,/g, '')
    : m[1].replace(',', '.')
  const bytes = Math.round(Number.parseFloat(digits) * UNITS[unit])
  return bytes > 0 ? bytes : Number.NaN
}

const GB = 1024 ** 3

/**
 * The size the Library sorts and filters by: the one the user entered, else what the installed game takes on disk,
 * else the store's size of the game (also for an installed game whose folder could not be measured). undefined when
 * none is known.
 */
export function installSizeBytes(game: SizedGame): number | undefined {
  if (game.user.installSize) return game.user.installSize
  // A folder measured at 0 bytes (a stub) says nothing: the store's size, if any, stands in.
  const size = measuredSize(game)
  if (size && size.bytes > 0) return size.bytes
  return game.metadata.storage?.bytes || undefined
}

/** The Filters > Size sub-menu's "All Sizes" value; every other value is a SIZE_BUCKETS id. */
export const ALL_SIZES = 'all'

/** Size bands of Filters > Size and of the Install size sort's sections, smallest first; `max` is exclusive. */
export const SIZE_BUCKETS: readonly {
  id: string
  label: string
  short: string
  min: number
  max: number
}[] = [
  { id: 'gb-0-1', label: '0-1 GB', short: '<1 GB', min: 0, max: 1 * GB },
  { id: 'gb-1-5', label: '1-5 GB', short: '1 GB', min: 1 * GB, max: 5 * GB },
  { id: 'gb-5-15', label: '5-15 GB', short: '5 GB', min: 5 * GB, max: 15 * GB },
  { id: 'gb-15-30', label: '15-30 GB', short: '15 GB', min: 15 * GB, max: 30 * GB },
  { id: 'gb-30-60', label: '30-60 GB', short: '30 GB', min: 30 * GB, max: 60 * GB },
  { id: 'gb-60-100', label: '60-99 GB', short: '60 GB', min: 60 * GB, max: 100 * GB },
  { id: 'gb-100', label: '100+ GB', short: '100 GB', min: 100 * GB, max: Number.POSITIVE_INFINITY }
]

/** The SIZE_BUCKETS id of a size in bytes; undefined for an unknown size. */
export function sizeBucketOf(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !(bytes > 0)) return undefined
  return SIZE_BUCKETS.find((b) => bytes >= b.min && bytes < b.max)?.id
}
