import type { Game } from '@shared/types'
import { steamWorkshopUnknown, type SteamLinkKind } from '@shared/web-viewer'
import { siSteam } from 'simple-icons'
import { BookOpen, ScrollText, Wrench } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { FocusContext, useFocusable } from '../../input/focus'
import { cx } from '../../lib/cx'
import { STEAM_LINK_FOCUS, steamLinksOf } from './steamLinks'
import { WebViewer } from './WebViewer'

/** Steam's own mark (simple-icons), drawn in the text colour like the lucide glyphs beside it. */
function SteamMark(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={siSteam.path} />
    </svg>
  )
}

const ICONS: Record<SteamLinkKind, () => ReactElement> = {
  store: () => <SteamMark />,
  workshop: () => <Wrench aria-hidden="true" />,
  pcgamingwiki: () => <BookOpen aria-hidden="true" />,
  guides: () => <ScrollText aria-hidden="true" />
}

/** The four squares in grid order (the shared STEAM_LINK_KINDS order). */
const SLOTS: readonly SteamLinkKind[] = ['store', 'workshop', 'pcgamingwiki', 'guides']

/**
 * The Steam links of a Steam game, a second four-square grid right of the feature grid (right of Play when the game
 * has no features), the same squares: Steam store page, Workshop, PCGamingWiki and Steam Guides, top left to bottom
 * right. Workshop leaves its square empty unless Steam says the game has one; when that is not known yet the page
 * asks main (api.steamWorkshopCheck, once per game per run there) and the square appears with the game's next
 * update if Steam says yes. A square opens its page in the in-app web viewer (WebViewer.tsx), so the user stays in
 * PlayOut. Right from the feature grid (or Play) enters it on the last square used, else the first one. Nothing
 * shows for any other game.
 */
export function SteamLinksGrid({ game }: { game: Game }): ReactElement | null {
  const t = useT()
  const links = steamLinksOf(game)
  const unknown = steamWorkshopUnknown(game)
  useEffect(() => {
    if (!unknown) return
    // The answer comes back as the game's own update; no answer leaves the square empty.
    void Promise.resolve()
      .then(() => api.steamWorkshopCheck(game.id))
      .catch(() => undefined)
  }, [game.id, unknown])
  const [viewing, setViewing] = useState<SteamLinkKind | null>(null)
  const first = links?.kinds[0]
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: STEAM_LINK_FOCUS.links,
    focusable: !!links,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: first ? STEAM_LINK_FOCUS[first] : undefined
  })
  if (!links) return null
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="gdetail__features gdetail__steam-links"
        role="group"
        aria-label={t('webViewer.links.label')}
      >
        {SLOTS.map((kind) =>
          links.kinds.includes(kind) ? (
            <LinkSquare
              key={kind}
              kind={kind}
              open={viewing === kind}
              onPress={() => setViewing(kind)}
            />
          ) : (
            <span key={kind} className="gdetail__features-empty" aria-hidden="true" />
          )
        )}
      </div>
      {viewing ? (
        <WebViewer
          kind={viewing}
          appId={links.appId}
          title={t(`webViewer.links.${viewing}`)}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </FocusContext.Provider>
  )
}

function LinkSquare({
  kind,
  open,
  onPress
}: {
  kind: SteamLinkKind
  open: boolean
  onPress: () => void
}): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey: STEAM_LINK_FOCUS[kind],
    onPress,
    scroll: false
  })
  const Icon = ICONS[kind]
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'gdetail__feature',
        `gdetail__steam-link--${kind}`,
        open && 'gdetail__feature--open'
      )}
      aria-label={t(`webViewer.links.${kind}`)}
      title={t(`webViewer.links.${kind}Title`)}
      aria-haspopup="dialog"
      {...props}
    >
      <Icon />
    </button>
  )
}
