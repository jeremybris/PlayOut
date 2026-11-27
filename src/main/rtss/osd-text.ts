/**
 * The performance overlay's text, drawn by RTSS from PlayOut's OSD slot (szOSDEx). PlayOut's own levels:
 *
 *   1  120 FPS
 *   2  120 FPS
 *      8.3 ms  CPU 35%  GPU 80%  15 W
 *   3  (level 2, then) RAM 62%  BAT 80%  21:04
 *
 * Missing values show '—'. No temperatures (nothing on this PC reads them reliably). Plain text only: RTSS draws it
 * with its own font and colours, and the text reads the same with or without RTSS's tags.
 */

export interface OsdStats {
  fps: number | null
  frameTimeMs: number | null
  cpuPercent: number | null
  gpuPercent: number | null
  watts: number | null
  ramPercent: number | null
  batteryPercent: number | null
}

const DASH = '—'
const GAP = '  '

const ok = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n)

function whole(n: number | null, suffix: string): string {
  return ok(n) ? `${Math.round(n)}${suffix}` : `${DASH}${suffix}`
}

function percent(label: string, n: number | null): string {
  return `${label} ${ok(n) ? `${Math.round(Math.max(0, Math.min(100, n)))}%` : DASH}`
}

function clock(now: Date, clock24h: boolean): string {
  const m = String(now.getMinutes()).padStart(2, '0')
  const h = now.getHours()
  if (clock24h) return `${String(h).padStart(2, '0')}:${m}`
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`
}

/** RTSS OSD text (szOSDEx) for a level; missing values show '—'. No temperatures. */
export function osdText(level: 1 | 2 | 3, s: OsdStats, now: Date, clock24h: boolean): string {
  const lines = [whole(s.fps, ' FPS')]
  if (level >= 2) {
    const ft =
      ok(s.frameTimeMs) && s.frameTimeMs > 0 ? `${s.frameTimeMs.toFixed(1)} ms` : `${DASH} ms`
    lines.push(
      [ft, percent('CPU', s.cpuPercent), percent('GPU', s.gpuPercent), whole(s.watts, ' W')].join(
        GAP
      )
    )
  }
  if (level >= 3)
    lines.push(
      [percent('RAM', s.ramPercent), percent('BAT', s.batteryPercent), clock(now, clock24h)].join(
        GAP
      )
    )
  return lines.join('\n')
}
