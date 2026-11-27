import type { Game, SteamScreenshot } from '@shared/types'
import { useEffect, useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { screenshotUrls } from '../../lib/media'
import { createLog } from '../../lib/log'
import { ScreenshotViewer } from './ScreenshotViewer'

const log = createLog('steam-screenshots')

/** Focus key of the n-th screenshot of the row (the viewer returns focus to the one it opened from). */
const screenshotFocusKey = (index: number): string => `detail:shot:${index}`

/**
 * The game's screenshots, in a row (as many as fit) between the release date line and the action bar. Steam games:
 * the screenshots of the game's Steam store page; the ones saved with the game show at once, and main fetches them
 * from Steam's store the first time (and after a month). ROM games: the screenshots their metadata brought (IGDB,
 * ScreenScraper, TheGamesDB), saved on this PC with the game (Refresh metadata fetches them again). A screenshot
 * pressed (A, Enter, click) opens the full-size viewer. Nothing shows for another game, or one without screenshots.
 */
export function SteamScreenshots({ game }: { game: Game }): ReactElement | null {
  const t = useT()
  const steam = game.source === 'steam' && !game.remote
  const rom = game.source === 'rom' && !game.remote
  // What main answered for this game (it also saves them with the game); before that, what the game has saved.
  const [fetched, setFetched] = useState<{ gameId: string; items: SteamScreenshot[] } | null>(null)
  // A saved thumbnail that does not load (its file gone) falls back to Steam's; one Steam no longer serves either
  // leaves the row rather than showing a broken image.
  const [localFailed, setLocalFailed] = useState<ReadonlySet<string>>(() => new Set())
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const [viewing, setViewing] = useState<number | null>(null)

  useEffect(() => {
    if (!steam) return
    let live = true
    api
      .getSteamScreenshots(game.id)
      .then((items) => {
        if (live && items) setFetched({ gameId: game.id, items })
      })
      .catch((err) => log.warn('getSteamScreenshots failed', err))
    // The background pass saved this game's thumbnails (or a fresh list) while its page is open.
    const off = api.on('steam-screenshots:updated', ({ gameId, items }) => {
      if (live && gameId === game.id) setFetched({ gameId, items })
    })
    return () => {
      live = false
      off()
    }
  }, [game.id, steam])

  if (!steam && !rom) return null
  // A ROM's screenshots are saved full size on this PC: each is its own thumbnail.
  const items: SteamScreenshot[] = rom
    ? screenshotUrls(game).map((url) => ({ thumbnail: url, full: url }))
    : fetched?.gameId === game.id
      ? fetched.items
      : (game.metadata.steamScreenshots?.items ?? [])
  const shown = items
    .filter((s) => !failed.has(s.thumbnail))
    .map((s) => (s.local && localFailed.has(s.local) ? { ...s, local: undefined } : s))
  if (shown.length === 0) return null
  return (
    <>
      <div className="gdetail__shots" role="list" aria-label={t('gameDetail.screenshots.label')}>
        {shown.map((shot, i) => (
          <ScreenshotThumb
            key={shot.thumbnail}
            shot={shot}
            index={i}
            whole={rom}
            onOpen={() => setViewing(i)}
            onError={() =>
              shot.local
                ? setLocalFailed((prev) => new Set(prev).add(shot.local!))
                : setFailed((prev) => new Set(prev).add(shot.thumbnail))
            }
          />
        ))}
      </div>
      {viewing !== null ? (
        <ScreenshotViewer shots={shown} start={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </>
  )
}

function ScreenshotThumb({
  shot,
  index,
  whole,
  onOpen,
  onError
}: {
  shot: SteamScreenshot
  index: number
  /** Shown whole (a ROM's screenshot), not cropped to the tile. */
  whole: boolean
  onOpen: () => void
  onError: () => void
}): ReactElement {
  const t = useT()
  const { ref, props, focused } = useFocusableControl<HTMLButtonElement>({
    focusKey: screenshotFocusKey(index),
    onPress: onOpen,
    scroll: false
  })
  return (
    <button
      ref={ref}
      {...props}
      type="button"
      role="listitem"
      className={cx(
        'gdetail__shot',
        whole && 'gdetail__shot--whole',
        focused && 'gdetail__shot--focused'
      )}
      aria-label={t('gameDetail.screenshots.item', { number: index + 1 })}
    >
      {/* The thumbnail saved on this PC once the background pass has it; Steam's CDN until then. */}
      <img
        src={shot.local ?? shot.thumbnail}
        alt=""
        loading="lazy"
        draggable={false}
        onError={onError}
      />
    </button>
  )
}
