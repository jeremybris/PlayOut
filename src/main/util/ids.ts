import { createHash } from 'crypto'
import type { SourceId } from '../../shared/types'

/** 16-char base64url SHA-1 of a string. */
export function hashShort(input: string): string {
  return createHash('sha1').update(input).digest('base64url').slice(0, 16)
}

/**
 * Stable game id. Store games: `${source}:${externalId}`. ROMs: `rom:${systemId}:${hash}` where the hash is taken
 * from the ROM path relative to the ROM root (forward slashes), so the id survives moving the ROM root.
 */
export function makeGameId(source: SourceId, externalId: string, platformId: string): string {
  if (source === 'rom') return `rom:${platformId}:${hashShort(externalId.replace(/\\/g, '/'))}`
  return `${source}:${externalId}`
}

export function newId(prefix = ''): string {
  const rand = createHash('sha1')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('base64url')
    .slice(0, 10)
  return prefix ? `${prefix}_${rand}` : rand
}
