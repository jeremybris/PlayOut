// Per-game playlists (game.user.playlist): paths relative to the music folder, forward slashes. Pure helpers; every
// function returns a new array. Paths are compared without case, since the folder lives on Windows.
import type { MusicTrack } from '@shared/overlay'

/** Forward slashes, no leading './' or '/', no empty segments. */
export function normalizeTrackPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/')
}

function key(p: string): string {
  return normalizeTrackPath(p).toLowerCase()
}

/** Normalized, empty entries dropped, the first of each duplicate kept. */
export function dedupePlaylist(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const p = normalizeTrackPath(raw)
    const k = p.toLowerCase()
    if (!p || seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}

/** Append a track (or insert it at `index`); a track already in the list stays where it is. */
export function addTrack(list: readonly string[], track: string, index?: number): string[] {
  const clean = dedupePlaylist(list)
  const p = normalizeTrackPath(track)
  if (!p || clean.some((x) => x.toLowerCase() === p.toLowerCase())) return clean
  const at = index === undefined ? clean.length : clamp(index, 0, clean.length)
  clean.splice(at, 0, p)
  return clean
}

export function removeTrack(list: readonly string[], track: string): string[] {
  const k = key(track)
  return dedupePlaylist(list).filter((p) => p.toLowerCase() !== k)
}

/** Move a track to position `to` (clamped); unchanged when the track is not in the list. */
export function moveTrack(list: readonly string[], track: string, to: number): string[] {
  const clean = dedupePlaylist(list)
  const from = clean.findIndex((p) => p.toLowerCase() === key(track))
  if (from < 0) return clean
  const [item] = clean.splice(from, 1)
  clean.splice(clamp(to, 0, clean.length), 0, item)
  return clean
}

/** Move a track one place up (-1) or down (+1): what the overlay's controller buttons do. */
export function shiftTrack(list: readonly string[], track: string, delta: number): string[] {
  const from = dedupePlaylist(list).findIndex((p) => p.toLowerCase() === key(track))
  return from < 0 ? dedupePlaylist(list) : moveTrack(list, track, from + delta)
}

/** Drop paths no longer in the library; the kept ones take the library's spelling (case). */
export function prunePlaylist(list: readonly string[], tracks: readonly MusicTrack[]): string[] {
  const byKey = new Map(tracks.map((t) => [t.path.toLowerCase(), t.path]))
  const out: string[] = []
  for (const p of dedupePlaylist(list)) {
    const hit = byKey.get(p.toLowerCase())
    if (hit) out.push(hit)
  }
  return out
}

/** The playlist's tracks in playlist order, skipping paths the library does not have. */
export function playlistTracks(
  list: readonly string[],
  tracks: readonly MusicTrack[]
): MusicTrack[] {
  const byKey = new Map(tracks.map((t) => [t.path.toLowerCase(), t]))
  return dedupePlaylist(list).flatMap((p) => byKey.get(p.toLowerCase()) ?? [])
}

/** True when two playlists hold the same paths in the same order (to skip saving an unchanged one). */
export function samePlaylist(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i])
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(Number.isFinite(n) ? n : hi)))
}
