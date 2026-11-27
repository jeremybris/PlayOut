import type { Game } from '@shared/types'
import { Search as SearchIcon, SearchX } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { ButtonHints, type Hint } from '../../components/ButtonHints'
import { EmptyState } from '../../components/EmptyState'
import { GameCard } from '../../components/GameCard'
import { Modal } from '../../components/Modal'
import { OnScreenKeyboard } from '../../components/OnScreenKeyboard'
import { TextField } from '../../components/TextField'
import { useT, type Translate } from '../../i18n'
import { cx } from '../../lib/cx'
import { collapsedWithRemote, hostGamesShown, withRemoteGames } from '../../lib/streaming'
import { visibleGames } from '../../lib/library'
import { useLibraryStore } from '../../state/library'
import { useSettingsStore } from '../../state/settings'
import { useStreamingStore } from '../../state/streaming'
import { useUiStore } from '../../state/ui'
import { searchLibrary } from './query'
import './search.css'

const ROW_ID = 'search'
const FIELD_KEY = 'search:field'
const OSK_KEY = 'search:osk'

/** The sheet's button hints: the gamepad's include the on-screen keyboard's X and Y. Built per language. */
function searchHints(t: Translate, gamepad: boolean): Hint[] {
  const open: Hint = { button: 'a', label: t('search.hints.open') }
  const close: Hint = { button: 'b', label: t('search.hints.close') }
  return gamepad
    ? [
        open,
        { button: 'x', label: t('search.hints.backspace') },
        { button: 'y', label: t('search.hints.space') },
        close
      ]
    : [open, close]
}

export interface SearchOverlayProps {
  onClose: () => void
}

/**
 * Search sheet dropping from the top: a large text field (on-screen keyboard beside it for gamepad users,
 * the Windows touch keyboard on touch) and a live-filtered grid of cards. A / Enter on a card opens the
 * detail panel on top; B closes.
 */
export function SearchOverlay({ onClose }: SearchOverlayProps): ReactElement {
  const t = useT()
  const games = useLibraryStore((s) => s.games)
  const platforms = useLibraryStore((s) => s.platforms)
  const platformsById = useLibraryStore((s) => s.platformsById)
  const settings = useSettingsStore((s) => s.settings)
  const inputMethod = useUiStore((s) => s.inputMethod)
  const openModal = useUiStore((s) => s.openModal)
  const [query, setQuery] = useState('')

  const gamepad = inputMethod === 'gamepad'
  const trimmed = query.trim()
  // A game owned in several stores is one result, as in the Library (lib/copies.ts); a paired host's games are
  // found too (Streaming), each its own result.
  const remote = useStreamingStore((s) => s.remote)
  const showHostGames = settings?.streaming.showHostGames ?? true
  const collapsed = useMemo(
    () =>
      collapsedWithRemote(
        withRemoteGames(
          visibleGames(games, settings),
          hostGamesShown(games, remote, showHostGames)
        ),
        { showDuplicates: settings?.library.showDuplicates ?? false }
      ),
    [games, settings, remote, showHostGames]
  )
  const results = useMemo(
    () => searchLibrary(collapsed.games, platforms, trimmed),
    [collapsed, platforms, trimmed]
  )

  const open = useCallback(
    (game: Game) => {
      openModal({ type: 'detail', gameId: game.id })
    },
    [openModal]
  )
  const hints = useMemo(() => searchHints(t, gamepad), [t, gamepad])

  return (
    <Modal
      size="sheet"
      focusKey="search"
      preferredChildFocusKey={gamepad ? OSK_KEY : FIELD_KEY}
      title={t('search.title')}
      subtitle={
        trimmed.length === 0
          ? t('search.subtitle')
          : results.length === 0
            ? t('search.noMatches')
            : t('search.results', { count: results.length })
      }
      onClose={onClose}
      className="search-sheet"
      bodyClassName="search__body"
    >
      <TextField
        focusKey={FIELD_KEY}
        className="search__field"
        size="lg"
        icon={<SearchIcon />}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        value={query}
        onChange={setQuery}
        clearable
        autoFocus={!gamepad}
      />
      <div className={cx('search__layout', gamepad && 'search__layout--keyboard')}>
        {gamepad ? (
          <div className="search__keyboard">
            {/* No autoFocus: the keyboard also mounts when the input method flips to gamepad mid-session
                (first D-pad press in a sheet opened with the mouse or '/') and must not steal focus from the
                results then. On a gamepad open the Modal's preferredChildFocusKey={OSK_KEY} plus the
                keyboard's own preferred child land on 'q'. */}
            <OnScreenKeyboard
              inline
              focusKey={OSK_KEY}
              value={query}
              placeholder={t('search.placeholder')}
              onChange={setQuery}
              onDone={() => undefined}
            />
          </div>
        ) : null}
        <div className="search__results">
          {trimmed.length === 0 ? (
            <EmptyState
              className="search__empty"
              icon={<SearchIcon />}
              title={t('search.empty.title')}
              description={gamepad ? t('search.empty.gamepad') : t('search.empty.keyboard')}
            />
          ) : results.length === 0 ? (
            <EmptyState
              className="search__empty"
              icon={<SearchX />}
              title={t('search.noGames.title')}
              description={t('search.noGames.description', { query: trimmed })}
            />
          ) : (
            <div className="search__grid" role="list" aria-label={t('search.resultsLabel')}>
              {results.map((game) => (
                <GameCard
                  key={game.id}
                  game={game}
                  rowId={ROW_ID}
                  platform={platformsById.get(game.platformId)}
                  onSelect={open}
                  copies={collapsed.copies.get(game.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <ButtonHints hints={hints} />
    </Modal>
  )
}
