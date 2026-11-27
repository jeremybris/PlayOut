import type {
  RecompBrowseEntry,
  RecompBrowseSort,
  RecompBrowseTitle,
  RecompBrowseView
} from '@shared/recomp'
import {
  ArrowBigUp,
  ArrowDownUp,
  Check,
  Download,
  ExternalLink,
  Gamepad2,
  Heart,
  ListFilter,
  LibraryBig,
  Plus,
  RotateCcw,
  UserPlus,
  Search,
  Sparkles,
  Star,
  Trash2
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { IconButton } from '../../components/IconButton'
import { Modal } from '../../components/Modal'
import { SelectField } from '../../components/SelectField'
import { Spinner } from '../../components/Spinner'
import { TextField } from '../../components/TextField'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useLanguage, useT, type Translate } from '../../i18n'
import {
  doesFocusableExist,
  FocusContext,
  getCurrentFocusKey,
  setFocus,
  useFocusable
} from '../../input/focus'
import { cx } from '../../lib/cx'
import { formatBytes, formatDate } from '../../lib/format'
import { createLog } from '../../lib/log'
import { ipcErrorMessage } from '../../state/coop'
import { recompBusy, useRecompStore } from '../../state/recomp'
import { useLibraryStore } from '../../state/library'
import { useUiStore } from '../../state/ui'
import { catalogSourceName, progressText } from '../Settings/sections/recompText'
import {
  addedMark,
  addedMarkText,
  removeAddedMessage,
  browseFilters,
  browseSorts,
  favoriteTitles,
  searchTitles,
  sortTitles,
  titleIndexOf,
  type RecompBrowseFilter
} from './browseView'
import { RecompAddDialog } from './RecompAddDialog'
import './recompBrowser.css'

const log = createLog('recomp-browser')
const FK = 'recomp-browser'
const key = (...parts: string[]): string => [FK, ...parts].join(':')
/** Games listed at a time; "Show more" adds this many again. */
const PAGE = 60

/**
 * The recompilation browser (Settings › Recompilations › Browse recompilations): every recompilation in the
 * decomp-buddy and RecompLauncher catalogs, by game. Search, sort (recently added, recently updated, GitHub stars),
 * and a game's recompilations side by side with Install, its GitHub page and the game's own Recompilation page. Add
 * (RecompAddDialog) puts a GitHub repository in the browser: "Added by you" at once, sent for approval by main.
 */
export function RecompBrowser({ onClose }: { onClose: () => void }): ReactElement {
  const t = useT()
  const language = useLanguage()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const version = useRecompStore((s) => s.version)
  const progress = useRecompStore((s) => s.progress)
  const [view, setView] = useState<RecompBrowseView | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<RecompBrowseSort>('added')
  const [shown, setShown] = useState(PAGE)
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  /** A recompilation to show once the list has it (just added, or Show it). */
  const [reveal, setReveal] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .browseRecomps()
      .then((next) => {
        setView(next)
        setFailed(false)
      })
      .catch((err) => {
        log.error('browseRecomps failed', err)
        setFailed(true)
      })
  }, [])
  // Read again when main says something changed (an install finished, the catalog was checked).
  useEffect(load, [load, version])

  // Games with a favourited recompilation come first, in the chosen order; then the rest. The favourites are the ones
  // there when the browser opened (or the sort or search changed): a heart pressed now does not move the game away
  // from under the focus.
  // Favorites (the filter) lists only those, from the same snapshot.
  const [filter, setFilter] = useState<RecompBrowseFilter>('all')
  const [favorites, setFavorites] = useState<{
    keys: ReadonlySet<string>
    ids: ReadonlySet<string>
  } | null>(null)
  if (view && favorites === null) {
    const ids = new Set(
      view.titles.flatMap((t) => t.entries.filter((e) => e.favorite).map((e) => e.id))
    )
    setFavorites({
      ids,
      keys: new Set(
        view.titles.filter((t) => t.entries.some((e) => ids.has(e.id))).map((t) => t.key)
      )
    })
  }
  const list = useMemo(() => {
    if (!view) return []
    const titles =
      filter === 'favorites'
        ? favoriteTitles(view.titles, favorites?.ids ?? new Set())
        : view.titles
    const sorted = sortTitles(searchTitles(titles, query), sort)
    if (filter === 'favorites') return sorted
    const favourite = (t: RecompBrowseTitle): boolean => !!favorites?.keys.has(t.key)
    return [...sorted.filter(favourite), ...sorted.filter((t) => !favourite(t))]
  }, [view, query, sort, filter, favorites])
  const refreshFavourites = (): void => setFavorites(null)
  // Show a recompilation (just added, or Show it) once the list has it: its game selected, the list long enough to
  // hold it, and a pad's focus on its row.
  const [revealed, setRevealed] = useState<{ key: string; n: number } | null>(null)
  const revealAt = reveal ? titleIndexOf(list, reveal) : null
  if (revealAt) {
    setReveal(null)
    setSelected(revealAt.key)
    if (revealAt.index >= shown) setShown(revealAt.index + 1)
    setRevealed((r) => ({ key: revealAt.key, n: (r?.n ?? 0) + 1 }))
  }
  useEffect(() => {
    if (!revealed) return undefined
    const timer = setTimeout(() => {
      if (doesFocusableExist(key('title', revealed.key))) void setFocus(key('title', revealed.key))
    }, 0)
    return () => clearTimeout(timer)
  }, [revealed])
  const showEntry = (id: string): void => {
    setQuery('')
    setFilter('all')
    refreshFavourites()
    setReveal(id)
  }
  // The game shown on the right is always one of the listed rows.
  const visible = list.slice(0, shown)
  const current = visible.find((t) => t.key === selected) ?? visible[0] ?? null
  const entryCount = view?.titles.reduce((n, t) => n + t.entries.length, 0) ?? 0

  // Once the catalogs are read, a pad starts on the search field (the modal focused Close while it was loading).
  const focusedOnce = useRef(false)
  useEffect(() => {
    if (focusedOnce.current || !view) return undefined
    focusedOnce.current = true
    const timer = setTimeout(() => {
      const cur = getCurrentFocusKey()
      const stray = !cur || cur === FK || cur === key('close') || cur === key('retry')
      if (stray && doesFocusableExist(key('search'))) void setFocus(key('search'))
    }, 0)
    return () => clearTimeout(timer)
  }, [view])

  // "Show more" moves focus to the first row it added (the button moves down, or goes on the last page).
  const focusRow = useRef<string | null>(null)
  useEffect(() => {
    const row = focusRow.current
    focusRow.current = null
    if (row && doesFocusableExist(key('title', row))) void setFocus(key('title', row))
  }, [shown])

  const install = (e: RecompBrowseEntry): void => {
    if (recompBusy(progress[e.id])) return
    // Listed only because someone added it: nobody virus-scanned it, said before the first install.
    if (e.unscanned && !e.installed) {
      openModal({
        type: 'confirm',
        title: t('recomp.browser.unscannedTitle', { name: e.name }),
        message: t('recomp.browser.unscannedMessage', { repo: e.repo }),
        confirmLabel: t('recomp.browser.unscannedConfirm'),
        onConfirm: () => startInstall(e)
      })
      return
    }
    startInstall(e)
  }
  const startInstall = (e: RecompBrowseEntry): void => {
    if (recompBusy(progress[e.id])) return
    // Install turns into a progress line: keep a pad's focus on this recompilation's card.
    if (getCurrentFocusKey() === key('install', e.id)) void setFocus(key('repo', e.id))
    api.installRecomp(e.id).catch((err) => {
      log.error('installRecomp failed', err)
      toast(
        t('recomp.browser.installFailed', {
          name: e.name,
          error: ipcErrorMessage(err) || t('recomp.browser.unknownError')
        }),
        'error'
      )
    })
    toast(t('recomp.browser.installing', { name: e.name }))
  }
  // Favourite: this recompilation only (not its game); its own library card, when it has one, follows.
  // The heart changes at once; main's 'recomp:changed' re-reads the list once it is saved (a second read here made
  // every press wait on two).
  const setEntryFavorite = (id: string, favorite: boolean): void =>
    setView((v) =>
      v
        ? {
            ...v,
            titles: v.titles.map((t) =>
              t.entries.some((x) => x.id === id)
                ? {
                    ...t,
                    entries: t.entries.map((x) => (x.id === id ? { ...x, favorite } : x))
                  }
                : t
            )
          }
        : v
    )
  const toggleFavorite = (e: RecompBrowseEntry): void => {
    const favorite = !e.favorite
    setEntryFavorite(e.id, favorite)
    api.setRecompFavorite(e.id, favorite).catch((err) => {
      log.error('setRecompFavorite failed', err)
      setEntryFavorite(e.id, !favorite)
      toast(t('recomp.browser.favouriteFailed'), 'error')
    })
  }
  // Add to library: the recompilation's own card, not installed (whatever else is in the library).
  const removeFromStore = useLibraryStore((s) => s.removeGame)
  const toggleLibrary = (e: RecompBrowseEntry): void => {
    if (e.libraryGameId) {
      const gameId = e.libraryGameId
      // Only a card whose recompilation is not installed (an installed one is deleted from its page): asked first.
      openModal({
        type: 'confirm',
        title: t('recomp.browser.removeTitle'),
        message: t('recomp.browser.removeMessage', { name: e.name }),
        confirmLabel: t('recomp.browser.removeConfirm'),
        danger: true,
        onConfirm: () => {
          api
            .removeGame(gameId)
            .then(() => {
              removeFromStore(gameId)
              toast(t('recomp.browser.removed', { name: e.name }))
              load()
            })
            .catch((err) => {
              log.error('removeGame failed', err)
              toast(t('recomp.browser.removeFailed'), 'error')
            })
        }
      })
      return
    }
    api
      .addRecompToLibrary(e.id)
      .then(() => {
        toast(t('recomp.browser.added', { name: e.name }))
        load()
      })
      .catch((err) => {
        log.error('addRecompToLibrary failed', err)
        toast(
          t('recomp.browser.addFailed', {
            name: e.name,
            error: ipcErrorMessage(err) || t('recomp.browser.unknownError')
          }),
          'error'
        )
      })
  }
  // Remove: a recompilation added on this PC leaves the browser (a waiting suggestion is not sent); an installed one
  // may go to the Recycle Bin too, or stay installed.
  const removeAdded = (e: RecompBrowseEntry): void => {
    openModal({
      type: 'confirm',
      title: t('recomp.browser.removeAddedTitle'),
      message: removeAddedMessage(e),
      confirmLabel: t('recomp.browser.removeAddedConfirm'),
      danger: true,
      ...(e.installed
        ? {
            option: {
              label: t('recomp.browser.removeAddedUninstall'),
              description: t('recomp.browser.removeAddedUninstallHint'),
              checked: false
            }
          }
        : {}),
      onConfirm: (uninstall) => {
        api
          .removeAddedRecomp(e.id, e.installed && uninstall)
          .then(() => {
            toast(t('recomp.browser.removedAdded', { name: e.name }))
            load()
          })
          .catch((err) => {
            log.error('removeAddedRecomp failed', err)
            toast(
              t('recomp.browser.removeAddedFailed', {
                name: e.name,
                error: ipcErrorMessage(err) || t('recomp.browser.unknownError')
              }),
              'error'
            )
          })
      }
    })
  }
  const openRepo = (e: RecompBrowseEntry): void => {
    api.openExternal(e.repoUrl).catch((err) => {
      log.error('openExternal failed', err)
      toast(t('recomp.browser.openRepoFailed'), 'error')
    })
  }

  let subtitle: string | undefined
  if (view) {
    const counts = {
      recompilations: t('recomp.recompilationCount', { count: entryCount }),
      games: t('recomp.browser.games', { count: view.titles.length })
    }
    subtitle = view.newCount
      ? t('recomp.browser.subtitleNew', { ...counts, newCount: view.newCount })
      : t('recomp.browser.subtitle', counts)
  }

  return (
    <Modal
      size="panel"
      scrim
      focusKey={FK}
      preferredChildFocusKey={key('search')}
      title={t('recomp.browser.title')}
      subtitle={subtitle}
      onClose={onClose}
      bodyClassName="recomp-browser"
    >
      {view === null ? (
        failed ? (
          <div className="recomp-browser__empty" role="status">
            {t('recomp.browser.readFailed')}
            <Button focusKey={key('retry')} variant="ghost" icon={<RotateCcw />} onPress={load}>
              {t('recomp.tryAgain')}
            </Button>
          </div>
        ) : (
          <Spinner label={t('recomp.browser.reading')} className="recomp-browser__spinner" />
        )
      ) : (
        <>
          {adding ? (
            <RecompAddDialog
              onClose={() => {
                setAdding(false)
                setTimeout(() => {
                  if (doesFocusableExist(key('add'))) void setFocus(key('add'))
                }, 0)
              }}
              onAdded={(id) => {
                load()
                showEntry(id)
              }}
              onShow={showEntry}
            />
          ) : null}
          <div className="recomp-browser__bar">
            <TextField
              focusKey={key('search')}
              className="recomp-browser__search"
              icon={<Search />}
              placeholder={t('recomp.browser.searchPlaceholder')}
              oskTitle={t('recomp.browser.searchTitle')}
              clearable
              value={query}
              onChange={(q) => {
                setQuery(q)
                setShown(PAGE)
                refreshFavourites()
              }}
            />
            <Button focusKey={key('add')} icon={<Plus />} onPress={() => setAdding(true)}>
              {t('recomp.browser.add')}
            </Button>
            <SelectField
              focusKey={key('sort')}
              variant="pill"
              icon={<ArrowDownUp />}
              label={t('recomp.browser.sortBy')}
              value={sort}
              options={browseSorts()}
              onChange={(next) => {
                setSort(next)
                setShown(PAGE)
                refreshFavourites()
              }}
            />
            <SelectField
              focusKey={key('filter')}
              variant="pill"
              icon={filter === 'favorites' ? <Heart /> : <ListFilter />}
              label={t('recomp.browser.show')}
              value={filter}
              options={browseFilters()}
              onChange={(next) => {
                setFilter(next)
                setShown(PAGE)
                setSelected(null)
                refreshFavourites()
              }}
            />
          </div>
          {view.catalog.offline.length ? (
            <p className="recomp-browser__note">
              {t('recomp.browser.offline', {
                // "A and B" in the language shown.
                sources: new Intl.ListFormat(language, { type: 'conjunction' }).format(
                  view.catalog.offline.map(catalogSourceName)
                )
              })}
            </p>
          ) : null}
          {list.length === 0 ? (
            <div className="recomp-browser__empty" role="status">
              {filter === 'favorites'
                ? query.trim()
                  ? t('recomp.browser.noFavouriteMatch', { query: query.trim() })
                  : t('recomp.browser.noFavourites')
                : view.titles.length
                  ? t('recomp.browser.noMatch', { query: query.trim() })
                  : t('recomp.browser.notRead')}
            </div>
          ) : (
            <div className="recomp-browser__split">
              <GameList preferred={current ? key('title', current.key) : undefined}>
                {visible.map((t) => (
                  <TitleRow
                    key={t.key}
                    title={t}
                    sort={sort}
                    selected={current?.key === t.key}
                    onSelect={() => setSelected(t.key)}
                  />
                ))}
                {list.length > shown ? (
                  <Button
                    focusKey={key('more')}
                    variant="ghost"
                    className="recomp-browser__more"
                    onPress={() => {
                      focusRow.current = list[shown]?.key ?? null
                      setShown((n) => n + PAGE)
                    }}
                  >
                    {t('recomp.browser.showMore', { count: list.length - shown })}
                  </Button>
                ) : null}
              </GameList>
              {current ? (
                <TitleDetail
                  title={current}
                  progress={progress}
                  onInstall={install}
                  onRepo={openRepo}
                  onFavorite={toggleFavorite}
                  onLibrary={toggleLibrary}
                  onRemove={removeAdded}
                  onOpenGame={(gameId) => openModal({ type: 'recomp', gameId })}
                />
              ) : null}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

/**
 * The list of games as one focus group: coming back to it (D-pad Left from the recompilations) lands on the game
 * being shown, not on whichever row is level with the button left.
 */
function GameList({
  preferred,
  children
}: {
  preferred: string | undefined
  children: ReactNode
}): ReactElement {
  const t = useT()
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: key('games'),
    trackChildren: true,
    saveLastFocusedChild: false,
    preferredChildFocusKey: preferred
  })
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="recomp-browser__games"
        role="listbox"
        aria-label={t('recomp.browser.gamesLabel')}
      >
        {children}
      </div>
    </FocusContext.Provider>
  )
}

function bestOf(title: RecompBrowseTitle, sort: RecompBrowseSort, t: Translate): string {
  if (sort === 'stars') {
    const stars = Math.max(-1, ...title.entries.map((e) => e.stars ?? -1))
    return stars >= 0 ? stars.toLocaleString() : ''
  }
  const dates = title.entries
    .map((e) => (sort === 'added' ? e.addedAt : e.updatedAt))
    .filter((d): d is string => !!d)
    .sort()
  const last = dates.at(-1)
  if (!last) return ''
  const date = formatDate(last, 'short')
  return sort === 'added'
    ? t('recomp.browser.bestAdded', { date })
    : t('recomp.browser.bestUpdated', { date })
}

/** One game in the list: focusing it shows its recompilations on the right. */
function TitleRow({
  title,
  sort,
  selected,
  onSelect
}: {
  title: RecompBrowseTitle
  sort: RecompBrowseSort
  selected: boolean
  onSelect: () => void
}): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLDivElement>({
    focusKey: key('title', title.key),
    onFocus: onSelect,
    onPress: onSelect
  })
  const [artFailed, setArtFailed] = useState(false)
  const fresh = title.entries.some((e) => e.isNew)
  const installed = title.entries.some((e) => e.installed)
  const favourite = title.entries.some((e) => e.favorite)
  const meta = bestOf(title, sort, t)
  return (
    <div
      ref={ref}
      className={cx('recomp-browser-game', selected && 'recomp-browser-game--selected')}
      role="option"
      aria-selected={selected}
      {...props}
    >
      <span className="recomp-browser-game__art" aria-hidden="true">
        {title.coverUrl && !artFailed ? (
          <img
            src={title.coverUrl}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setArtFailed(true)}
          />
        ) : (
          <ArrowBigUp />
        )}
      </span>
      <span className="recomp-browser-game__text">
        <span className="recomp-browser-game__name">{title.game}</span>
        <span className="recomp-browser-game__sub">
          {title.console} · {t('recomp.recompilationCount', { count: title.entries.length })}
        </span>
        {meta ? (
          <span className="recomp-browser-game__value">
            {sort === 'stars' ? <Star aria-hidden="true" /> : null}
            {sort === 'stars' ? t('recomp.browser.stars', { stars: meta }) : meta}
          </span>
        ) : null}
      </span>
      {fresh || installed || favourite ? (
        <span className="recomp-browser-game__meta">
          {favourite ? (
            <Heart
              className="recomp-browser-game__check"
              fill="currentColor"
              aria-label={t('recomp.browser.favourite')}
            />
          ) : null}
          {fresh ? <Chip accent>{t('recomp.browser.new')}</Chip> : null}
          {installed ? (
            <Check
              className="recomp-browser-game__check"
              aria-label={t('recomp.browser.installed')}
            />
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

/** The chosen game's recompilations, side by side. */
function TitleDetail({
  title,
  progress,
  onInstall,
  onRepo,
  onFavorite,
  onLibrary,
  onRemove,
  onOpenGame
}: {
  title: RecompBrowseTitle
  progress: ReturnType<typeof useRecompStore.getState>['progress']
  onInstall: (e: RecompBrowseEntry) => void
  onRepo: (e: RecompBrowseEntry) => void
  onFavorite: (e: RecompBrowseEntry) => void
  onLibrary: (e: RecompBrowseEntry) => void
  onRemove: (e: RecompBrowseEntry) => void
  onOpenGame: (gameId: string) => void
}): ReactElement {
  const t = useT()
  const gameId = title.gameIds[0]
  return (
    <DetailPane label={title.game}>
      <header className="recomp-browser__detail-head">
        <div className="u-grow">
          <h3 className="recomp-browser__detail-title">{title.game}</h3>
          <p className="recomp-browser__detail-sub">
            {[
              title.console,
              title.entries.length > 1
                ? t('recomp.browser.toChooseFrom', { count: title.entries.length })
                : t('recomp.browser.one'),
              gameId ? t('recomp.browser.inYourLibrary') : null
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {gameId ? (
          <Button
            focusKey={key('open-game', title.key)}
            icon={<Gamepad2 />}
            onPress={() => onOpenGame(gameId)}
          >
            {t('recomp.browser.openGame')}
          </Button>
        ) : null}
      </header>
      <div className="recomp-browser__versions">
        {title.entries.map((e) => (
          <EntryCard
            key={e.id}
            entry={e}
            progress={progress[e.id]}
            onInstall={() => onInstall(e)}
            onRepo={() => onRepo(e)}
            onFavorite={() => onFavorite(e)}
            onLibrary={() => onLibrary(e)}
            onRemove={() => onRemove(e)}
          />
        ))}
      </div>
      {!gameId ? <p className="recomp-browser__note">{t('recomp.browser.notInLibrary')}</p> : null}
    </DetailPane>
  )
}

/** The right column as one focus group, so D-pad Right from the list enters it (not the sort menu above). */
function DetailPane({ label, children }: { label: string; children: ReactNode }): ReactElement {
  const { ref, focusKey } = useFocusable<object, HTMLElement>({
    focusKey: key('detail'),
    trackChildren: true
  })
  return (
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} className="recomp-browser__detail" aria-label={label}>
        {children}
      </section>
    </FocusContext.Provider>
  )
}

function EntryCard({
  entry,
  progress,
  onInstall,
  onRepo,
  onFavorite,
  onLibrary,
  onRemove
}: {
  entry: RecompBrowseEntry
  progress: ReturnType<typeof useRecompStore.getState>['progress'][string] | undefined
  onInstall: () => void
  onRepo: () => void
  onFavorite: () => void
  onLibrary: () => void
  onRemove: () => void
}): ReactElement {
  const t = useT()
  const busy = recompBusy(progress)
  const mine = addedMark(entry)
  const facts = [
    entry.latestTag,
    entry.updatedAt
      ? t('recomp.browser.updated', { date: formatDate(entry.updatedAt, 'short') })
      : null,
    entry.addedAt ? t('recomp.browser.listed', { date: formatDate(entry.addedAt, 'short') }) : null,
    entry.downloadBytes ? formatBytes(entry.downloadBytes) : null
  ].filter(Boolean)
  return (
    <article className="recomp-browser-entry">
      <div className="recomp-browser-entry__head">
        <div className="u-grow recomp-browser-entry__titles">
          <span className="recomp-browser-entry__name">{entry.name}</span>
          <span className="recomp-browser-entry__author">
            {t('recomp.by', { author: entry.author })}
          </span>
        </div>
        <span className="recomp-browser-entry__stars" title={t('recomp.browser.githubStars')}>
          <Star aria-hidden="true" />
          {entry.stars !== null ? entry.stars.toLocaleString() : '—'}
        </span>
        <IconButton
          focusKey={key('favorite', entry.id)}
          size="sm"
          variant="ghost"
          icon={<Heart fill={entry.favorite ? 'currentColor' : 'none'} />}
          aria-label={
            entry.favorite
              ? t('recomp.browser.removeFavourite', { name: entry.name })
              : t('recomp.browser.addFavourite', { name: entry.name })
          }
          active={entry.favorite}
          onPress={onFavorite}
        />
      </div>
      {entry.blurb ? <p className="recomp-browser-entry__blurb">{entry.blurb}</p> : null}
      <div className="recomp-browser-entry__chips">
        {mine ? (
          <Chip accent icon={<UserPlus />} title={mine.title ?? undefined}>
            {addedMarkText(mine)}
          </Chip>
        ) : entry.isNew ? (
          <Chip accent icon={<Sparkles />}>
            {t('recomp.browser.new')}
          </Chip>
        ) : null}
        {entry.recommended ? <Chip accent>{t('recomp.browser.recommended')}</Chip> : null}
        {entry.installed ? <Chip icon={<Check />}>{t('recomp.browser.installed')}</Chip> : null}
        {entry.tags.slice(0, 6).map((tag) => (
          <Chip
            key={tag.label}
            className={cx(tag.kind === 'warning' && 'recomp-browser-entry__warn')}
          >
            {tag.label}
          </Chip>
        ))}
      </div>
      {facts.length ? <p className="recomp-browser-entry__facts">{facts.join(' · ')}</p> : null}
      <div className="recomp-browser-entry__actions">
        {busy && progress ? (
          <span className="recomp-browser-entry__progress" role="status">
            <Spinner size="sm" /> {progressText(progress)}
          </span>
        ) : entry.installed ? null : (
          <Button
            focusKey={key('install', entry.id)}
            variant="primary"
            icon={<Download />}
            onPress={onInstall}
          >
            {t('recomp.browser.install')}
          </Button>
        )}
        {/* Add to library; Remove only while it is not installed (or installing): an installed one is deleted from its
            page, which takes its card with it. */}
        {!entry.libraryGameId ? (
          <Button focusKey={key('library', entry.id)} icon={<LibraryBig />} onPress={onLibrary}>
            {t('recomp.browser.addToLibrary')}
          </Button>
        ) : !entry.installed && !busy ? (
          <Button focusKey={key('library', entry.id)} icon={<Trash2 />} onPress={onLibrary}>
            {t('recomp.browser.removeFromLibrary')}
          </Button>
        ) : (
          <Chip icon={<Check />}>{t('recomp.browser.inLibrary')}</Chip>
        )}
        <Button focusKey={key('repo', entry.id)} icon={<ExternalLink />} onPress={onRepo}>
          {t('recomp.browser.projectPage')}
        </Button>
        {mine && !busy ? (
          <Button
            focusKey={key('remove', entry.id)}
            variant="ghost"
            icon={<Trash2 />}
            onPress={onRemove}
          >
            {t('recomp.browser.removeAdded')}
          </Button>
        ) : null}
      </div>
    </article>
  )
}
