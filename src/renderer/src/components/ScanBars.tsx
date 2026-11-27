import { useEffect, type CSSProperties, type ReactElement } from 'react'
import {
  artScanBar,
  emulatorSetupBar,
  hltbScanBar,
  playersScanBar,
  ps3UpdateBar,
  ratingsScanBar,
  screenshotsScanBar,
  hostSyncBar,
  sizeScanBar,
  type ScanBar
} from '../lib/scanBars'
import { coopScanBar } from '../lib/coop'
import { useCoopStore } from '../state/coop'
import { useLibraryStore } from '../state/library'
import { usePs3UpdateStore } from '../state/ps3Updates'

/**
 * The background passes' progress along the bottom edge of the window, one thin bar each, stacked: the game art
 * downloads, the install-size scan, the review scores, the HowLongToBeat times, the Steam screenshots, LaunchBox's player counts, the
 * Co-Op downloads and the emulator setup. While any shows, the Library's bottom band and the button hints move up by their height
 * (--scan-bar-h on <html>), so they cover nothing.
 */
export function ScanBars(): ReactElement | null {
  const sizeScan = useLibraryStore((s) => s.sizeScan)
  const ratingsScan = useLibraryStore((s) => s.ratingsScan)
  const hltbScan = useLibraryStore((s) => s.hltbScan)
  const screenshotsScan = useLibraryStore((s) => s.screenshotsScan)
  const playersScan = useLibraryStore((s) => s.playersScan)
  const artScan = useLibraryStore((s) => s.artScan)
  const hostSync = useLibraryStore((s) => s.hostSync)
  const emulatorSetup = useLibraryStore((s) => s.emulatorSetup)
  const coopProgress = useCoopStore((s) => s.progress)
  const ps3Update = usePs3UpdateStore((s) => s.current)
  const bars = [
    emulatorSetupBar(emulatorSetup),
    ps3UpdateBar(ps3Update),
    artScanBar(artScan),
    hostSyncBar(hostSync),
    sizeScanBar(sizeScan),
    ratingsScanBar(ratingsScan),
    hltbScanBar(hltbScan),
    screenshotsScanBar(screenshotsScan),
    playersScanBar(playersScan),
    coopScanBar(coopProgress)
  ].filter((b): b is ScanBar => b !== null)
  const count = bars.length
  useEffect(() => {
    const root = document.documentElement
    if (count) root.style.setProperty('--scan-bar-h', `calc(${count} * var(--scan-bar-size))`)
    else root.style.removeProperty('--scan-bar-h')
    return () => {
      root.style.removeProperty('--scan-bar-h')
    }
  }, [count])
  if (!count) return null
  return (
    <div className="scan-bars">
      {bars.map((bar) => {
        const percent = Math.min(100, Math.max(0, (bar.done / bar.total) * 100))
        return (
          <div
            key={bar.key}
            className={bar.paused ? 'size-scan size-scan--paused' : 'size-scan'}
            role="progressbar"
            aria-label={bar.name}
            aria-valuemin={0}
            aria-valuemax={bar.total}
            aria-valuenow={Math.min(bar.done, bar.total)}
            aria-valuetext={bar.label}
            style={{ '--p': percent } as CSSProperties}
          >
            <span className="size-scan__fill" aria-hidden="true" />
            <span className="size-scan__label">{bar.label}</span>
          </div>
        )
      })}
    </div>
  )
}
