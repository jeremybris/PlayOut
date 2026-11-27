import { STORE_PLATFORMS } from '@shared/platforms'
import { recompToPlay } from '@shared/recomp-play'
import type { Game } from '@shared/types'
import {
  Cast,
  Check,
  ChevronRight,
  CircleCheck,
  CircleStop,
  Download,
  FolderOpen,
  Hourglass,
  Info,
  Layers,
  ListFilterPlus,
  ListPlus,
  Pause,
  Play,
  Puzzle,
  Trash2,
  X
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api/client'
import { LayerContext, useActionHandlersOnLayer } from '../hooks/useActionHandlers'
import { useFocusLayer } from '../hooks/useFocusLayer'
import { useT, type Translate } from '../i18n'
import { FocusContext, doesFocusableExist, getCurrentFocusKey, setFocus } from '../input/focus'
import { addGamesTileFocusKey, cardFocusKey, parseCardFocusKey } from '../lib/focusKeys'
import { displayTitle } from '../lib/library'
import { CustomFilterIconView } from '../lib/customFilterIcons'
import { knownCustomIds } from '../lib/customFilters'
import { createLog } from '../lib/log'
import {
  downloadRunning,
  findGame,
  remotePrimaryAction,
  streamActive,
  streamBusy,
  streamHosts
} from '../lib/streaming'
import {
  gameInFilter,
  openCreateCustomFilter,
  toggleGameInFilter,
  useCustomFilters
} from '../state/customFilters'
import {
  closeCoverMenu,
  copiesFor,
  focusFirst,
  setPreferredCopy,
  showInFolder,
  toggleCompleted
} from '../state/favorite'
import {
  isInstalledHere,
  queuePlaceText,
  queueStarting,
  useInstallQueueStore,
  useQueuePaused,
  useQueuePosition
} from '../state/installQueue'
import { useInstallProgress } from '../state/installs'
import { useLibraryStore } from '../state/library'
import { canDeleteLocally, startLocalDelete } from '../state/localDelete'
import { canManageSteamDlc } from '../state/steamDlc'
import { useRomDownload, useStreamSession, useStreamingStore } from '../state/streaming'
import { useSystemStore } from '../state/system'
import { useUiStore } from '../state/ui'
import { Menu, MenuItem } from './MenuItem'
import { PlatformBadge } from './PlatformBadge'

const log = createLog('cover-menu')

const FOCUS_KEY = 'cover-menu'
/** Gap between the menu and the screen edge, px at 1080p. */
const EDGE_U = 16

/** The first row of a host-only game's menu, whichever it is (Download, Cancel Download or Stream). */
const REMOTE_FIRST_KEY = `${FOCUS_KEY}:remote:first`

interface RemoteItem {
  key: string
  label: string
  icon: ReactElement
  run: () => void
}

/** The cover menu row of a game waiting in the install queue: leaves the queue (its place as the note). */
const QUEUE_KEY = `${FOCUS_KEY}:queue`
/** The cover menu row that pauses or resumes a queued game. */
const PAUSE_KEY = `${FOCUS_KEY}:pause`
/** The cover menu row that opens the list of the user's filters (Add to … / Remove from …). */
const CUSTOM_KEY = `${FOCUS_KEY}:custom`
/** A filter's row in that list. */
const customFilterKey = (id: string): string => `${FOCUS_KEY}:custom:${id}`

/** Pause Download / Resume Download for a queued game (InstallQueueEntry.paused). */
function pauseItem(gameId: string, paused: boolean, t: Translate): RemoteItem {
  const { pause, resume } = useInstallQueueStore.getState()
  return {
    key: 'pause',
    label: paused
      ? t('components.coverMenu.resumeDownload')
      : t('components.coverMenu.pauseDownload'),
    icon: paused ? <Play /> : <Pause />,
    run: () => void (paused ? resume(gameId) : pause(gameId))
  }
}

/**
 * The menu of a game only a paired host has (Streaming): Download or Cancel Download for a ROM the host hands out
 * (Remove from Queue while it waits in the install queue; Cancel Download, never Download, once its turn came even
 * before its first progress; Pause / Resume Download while queued), Stream (from each host that has it) and Details,
 * then the rows given (Create a filter, Custom filters). Each row closes the menu first, like the local rows.
 */
function RemoteMenuItems({
  game,
  children
}: {
  game: Game
  /** Rows after the host's (Create a filter, Custom filters). */
  children?: ReactNode
}): ReactElement {
  const t = useT()
  const remote = useStreamingStore((s) => s.remote)
  const download = useRomDownload(game.id)
  const session = useStreamSession(game.id)
  const queuePosition = useQueuePosition(game.id)
  const paused = useQueuePaused(game.id)
  const primary = remotePrimaryAction(game)
  const hosts = streamHosts(game, remote?.alsoOnHost)
  const streaming = useStreamingStore.getState()
  const items: RemoteItem[] = []
  // A finished download: the card turns into the local game in a moment, so no second Download meanwhile (like the
  // detail page's "Adding to library…").
  if (primary === 'download' && download?.state !== 'done') {
    items.push(
      queuePosition
        ? {
            key: 'queue',
            label: t('components.coverMenu.removeFromQueue'),
            icon: <X />,
            run: () => void useInstallQueueStore.getState().remove(game.id)
          }
        : queueStarting(queuePosition, download)
          ? // Its turn came but no progress yet (main reaching the host): Download would only queue it again.
            {
              key: 'cancel',
              label: t('components.coverMenu.cancelDownload'),
              icon: <X />,
              run: () => void useInstallQueueStore.getState().remove(game.id)
            }
          : downloadRunning(download)
            ? {
                key: 'cancel',
                label: t('components.coverMenu.cancelDownload'),
                icon: <X />,
                run: () => void streaming.cancelDownload(game.id)
              }
            : {
                key: 'download',
                label: t('components.coverMenu.download'),
                icon: <Download />,
                run: () => void streaming.downloadRom(game)
              }
    )
    // Queued (waiting, or downloading now): Pause Download, or Resume Download once paused.
    if (queuePosition !== null) items.push(pauseItem(game.id, paused, t))
  }
  // This game's stream starting or running: Cancel / Stop in place of Stream (one stream at a time).
  if (streamActive(session) || streamBusy(session)) {
    items.push({
      key: 'stop',
      label: streamActive(session)
        ? t('components.coverMenu.stopStreaming')
        : t('components.coverMenu.cancelStream'),
      icon: <CircleStop />,
      run: () => void streaming.stopStream()
    })
  } else {
    const named = hosts.length > 1 || primary === 'download'
    for (const host of hosts) {
      items.push({
        key: `stream:${host.hostId}`,
        label: named
          ? t('components.coverMenu.streamFrom', { host: host.hostName })
          : t('components.coverMenu.stream'),
        icon: <Cast />,
        run: () => void streaming.streamGame(game, host.hostId)
      })
    }
  }
  items.push({
    key: 'details',
    label: t('components.coverMenu.details'),
    icon: <Info />,
    run: () => {
      useUiStore.getState().openModal({ type: 'detail', gameId: game.id })
    }
  })
  return (
    <Menu>
      {items.map((item, i) => (
        <MenuItem
          key={item.key}
          focusKey={i === 0 ? REMOTE_FIRST_KEY : `${FOCUS_KEY}:remote:${item.key}`}
          label={item.label}
          icon={item.icon}
          onPress={() => {
            closeCoverMenu()
            item.run()
          }}
        />
      ))}
      {children}
    </Menu>
  )
}

/** The Library grid's row id (its cards' focus keys: card:library:<game id>). */
const LIBRARY_ROW_ID = 'library'

/** The focus key of the Library card after the one `focusKey` names (else the one before), as the grid shows them. */
function neighbourCardKey(focusKey: string): string | undefined {
  const keys = [
    ...document.querySelectorAll<HTMLElement>(`[data-card-key^="card:${LIBRARY_ROW_ID}:"]`)
  ]
    .map((el) => el.dataset.cardKey ?? '')
    .filter((key) => key && key !== addGamesTileFocusKey(LIBRARY_ROW_ID))
  const index = keys.indexOf(focusKey)
  if (index < 0) return undefined
  return keys[index + 1] ?? keys[index - 1]
}

/** A copy's name in the copy list: its store ('Steam'), or a ROM's system ('PlayStation 2'). */
function storeName(game: Game, platformsById: ReadonlyMap<string, { name: string }>): string {
  if (game.source === 'rom') return platformsById.get(game.platformId)?.name ?? game.platformId
  return STORE_PLATFORMS[game.source as keyof typeof STORE_PLATFORMS]?.name ?? 'PC'
}

/** Where a copy's files are: the installed copy with a known path, the shown one first. */
function folderCopy(copies: readonly Game[]): Game | undefined {
  return copies.find((c) => c.installed && !!(c.exePath ?? c.romPath ?? c.installDir))
}

/**
 * The options menu Y (or a right click) opens over a cover in the Library or on Home: Remove from Queue (a game
 * waiting in the install queue; Pause / Resume Download for any queued one), Show in Folder, Mark as Completed, Create a
 * filter (the user's own filter, with this game in it) and Custom filters (once there are any: Add to / Remove from each
 * filter, the list staying open), Preferred Copy, which lists the stores the game was found in and picks the one the library
 * shows, and Delete from this PC for the installed copy (state/localDelete.ts). Portaled to <body> with its own focus and action layer; B closes it, or steps back from the copy list.
 */
export function CoverMenuHost(): ReactElement | null {
  const menu = useUiStore((s) => s.coverMenu)
  // Subscribed so the copy list follows library changes; copiesFor reads the store itself.
  const games = useLibraryStore((s) => s.games)
  const byId = useLibraryStore((s) => s.byId)
  // A host-only game (Streaming) is not in the library store; its menu offers what works on it here.
  const remote = useStreamingStore((s) => s.remote)
  const game = menu ? findGame(menu.gameId, byId, remote) : undefined
  // The game left the library while its menu was open (a rescan, an account import): close the menu instead of
  // leaving it pending, and let closeCoverMenu put focus somewhere that exists.
  useEffect(() => {
    if (menu && !game) closeCoverMenu()
  }, [menu, game])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- games: recompute when the library changes
  const copies = useMemo(() => (game && !game.remote ? copiesFor(game.id) : []), [game, games])
  if (!menu || !game) return null
  return <CoverMenu key={menu.focusKey} game={game} copies={copies} focusKey={menu.focusKey} />
}

interface CoverMenuProps {
  game: Game
  /** Every copy of the game, the shown one first (lib/copies.ts). */
  copies: Game[]
  /** The card the menu was opened on. */
  focusKey: string
}

function CoverMenu({ game, copies, focusKey }: CoverMenuProps): ReactElement {
  const t = useT()
  const [mode, setMode] = useState<'menu' | 'copies' | 'custom'>('menu')
  const customFilters = useCustomFilters()
  // Subscribed so the rows' Add to / Remove from follow a change (gameInFilter reads the copies itself).
  const inFilter = useMemo(
    () => new Set(customFilters.filter((f) => gameInFilter(f, game.id)).map((f) => f.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- copies: a copy taking another's place
    [customFilters, game.id, copies]
  )
  const platformsById = useLibraryStore((s) => s.platformsById)
  const runningId = useSystemStore((s) => s.running?.gameId ?? null)
  const queueEntries = useInstallQueueStore((s) => s.entries)
  // A host-only game's rows call the streaming service; the rest (folder, completed, copies) would send its
  // `remote:` id to main, which knows nothing of it. An installed game of this PC is never treated as queued.
  const queuePosition = useQueuePosition(game.id, isInstalledHere(game))
  const paused = useQueuePaused(queuePosition !== null ? game.id : null)
  const install = useInstallProgress(game.remote ? null : game.id)
  const firstKey = game.remote
    ? REMOTE_FIRST_KEY
    : queuePosition
      ? QUEUE_KEY
      : `${FOCUS_KEY}:folder`
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey: FOCUS_KEY,
    preferredChildFocusKey: firstKey
  })
  const back = (): void => {
    if (mode === 'copies') {
      setMode('menu')
      void setFocus(`${FOCUS_KEY}:preferred`)
    } else if (mode === 'custom') {
      setMode('menu')
      void setFocus(CUSTOM_KEY)
    } else closeCoverMenu()
  }
  useActionHandlersOnLayer(layerId, {
    back: () => {
      back()
      return true
    },
    // Y again closes the menu it opened.
    y: () => {
      closeCoverMenu()
      return true
    }
  })

  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    const place = (): void => {
      const card = document.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(focusKey)}"]`)
      const panel = ref.current
      if (!panel) return
      const unit = window.innerHeight / 1080
      const edge = EDGE_U * unit
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      const rect = card?.getBoundingClientRect() ?? {
        left: window.innerWidth / 2,
        top: window.innerHeight / 2,
        width: 0,
        height: 0
      }
      // Centred on the cover, kept on screen.
      const left = Math.min(
        Math.max(edge, rect.left + rect.width / 2 - width / 2),
        window.innerWidth - width - edge
      )
      const top = Math.min(
        Math.max(edge, rect.top + rect.height / 2 - height / 2),
        window.innerHeight - height - edge
      )
      setStyle({ left: Math.round(left), top: Math.round(top) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [focusKey, mode, copies.length, customFilters.length, ref])

  // Focus the first row of whichever list is showing.
  useEffect(() => {
    void setFocus(
      mode === 'copies'
        ? `${FOCUS_KEY}:copy:${copies[0]?.id}`
        : mode === 'custom'
          ? customFilterKey(customFilters[0]?.id ?? '')
          : firstKey
    )
    // the copy list's first row is the shown copy; re-run only when the list switches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.target === event.currentTarget) closeCoverMenu()
  }

  const folder = folderCopy(copies)
  // A game Play starts from its recompilation (its disc image may be gone): Show in Folder opens that recompilation's
  // folder.
  const recompFolderOf = copies.map((c) => recompToPlay(c)).find((id): id is string => !!id) ?? null
  // Delete from this PC: the installed copy (the one Show in Folder opens), when nothing runs or downloads it.
  const deletable = copies.find(
    (c) =>
      c.installed &&
      canDeleteLocally(c, {
        runningId,
        queued: queueEntries.some((e) => e.gameId === c.id || e.gameId.endsWith(`:${c.id}`))
      })
  )
  const completed = copies.some((c) => c.completed)
  // Manage DLC: the installed Steam copy of this PC, if the game has one.
  const steamCopy = copies.find(canManageSteamDlc)
  const shown = copies[0] ?? game
  const choose = (copy: Game): void => {
    const row = parseCardFocusKey(focusKey)?.rowId
    // Closed at once (no second save from a double press, nothing pending under a newer menu); once saved, focus
    // follows to the card that now stands for the game, unless the user has moved on meanwhile.
    closeCoverMenu()
    void setPreferredCopy(copy.id).then((saved) => {
      const current = getCurrentFocusKey()
      const stayed = current === focusKey || !current || !doesFocusableExist(current)
      if (!saved || !row || !stayed || useUiStore.getState().coverMenu) return
      focusFirst([cardFocusKey(row, copy.id), focusKey])
    })
  }

  // Removing the game from a custom filter the Library is narrowed by takes its card out of the grid: the menu closes
  // at once and focus goes to the card beside it, not to the first card.
  const leavesView = (filterId: string): boolean => {
    if (parseCardFocusKey(focusKey)?.rowId !== LIBRARY_ROW_ID) return false
    const picked = knownCustomIds(customFilters, useUiStore.getState().library.custom)
    if (!picked.includes(filterId)) return false
    return !picked.some((id) => id !== filterId && inFilter.has(id))
  }
  const toggleFilter = (filterId: string): void => {
    if (inFilter.has(filterId) && leavesView(filterId)) closeCoverMenu(neighbourCardKey(focusKey))
    void toggleGameInFilter(filterId, game.id)
  }

  // The user's own filters: a new one with this game in it, then (once there are any) the list. A paired host's game
  // has them too (its id stays the same while the host has it).
  const filterRows = (
    <>
      <MenuItem
        focusKey={`${FOCUS_KEY}:create-filter`}
        label={t('components.coverMenu.createFilter')}
        icon={<ListPlus />}
        onPress={() => {
          closeCoverMenu()
          openCreateCustomFilter(game.id)
        }}
      />
      {customFilters.length ? (
        <MenuItem
          focusKey={CUSTOM_KEY}
          label={t('components.coverMenu.customFilters')}
          icon={<ListFilterPlus />}
          trailing={
            <span className="cover-menu__copy">
              {inFilter.size ? (
                <span className="cover-menu__note">
                  {t('components.coverMenu.inFilters', { count: inFilter.size })}
                </span>
              ) : null}
              <ChevronRight />
            </span>
          }
          onPress={() => setMode('custom')}
          onArrowPress={(direction) => {
            if (direction !== 'right') return true
            setMode('custom')
            return false
          }}
        />
      ) : null}
    </>
  )

  return createPortal(
    <div className="select-menu-backdrop" onClick={onBackdropClick}>
      <LayerContext.Provider value={layerId}>
        <FocusContext.Provider value={FOCUS_KEY}>
          <div
            ref={ref}
            className="select-menu cover-menu"
            style={style}
            role="menu"
            aria-label={t('components.coverMenu.label', { title: displayTitle(game) })}
            data-focus-key={FOCUS_KEY}
          >
            <div className="cover-menu__title">
              {mode === 'copies'
                ? t('components.coverMenu.preferredCopy')
                : mode === 'custom'
                  ? t('components.coverMenu.customFilters')
                  : displayTitle(game)}
            </div>
            {game.remote && mode === 'menu' ? (
              <RemoteMenuItems game={game}>{filterRows}</RemoteMenuItems>
            ) : mode === 'menu' ? (
              <Menu>
                {queuePosition ? (
                  <MenuItem
                    focusKey={QUEUE_KEY}
                    label={t('components.coverMenu.removeFromQueue')}
                    icon={<Hourglass />}
                    trailing={
                      <span className="cover-menu__note">{queuePlaceText(queuePosition)}</span>
                    }
                    onPress={() => {
                      closeCoverMenu()
                      void useInstallQueueStore.getState().remove(game.id)
                    }}
                  />
                ) : queuePosition === 0 ? (
                  // Downloading now (or starting, before its first progress): stops it, and the next game starts.
                  // Not the first row: A on a fresh menu never stops a download.
                  <MenuItem
                    focusKey={`${FOCUS_KEY}:stop-install`}
                    label={t('components.coverMenu.stopTracking')}
                    icon={<CircleStop />}
                    trailing={
                      <span className="cover-menu__note">
                        {queueStarting(queuePosition, install)
                          ? t('components.coverMenu.starting')
                          : paused
                            ? t('components.coverMenu.paused')
                            : t('components.coverMenu.downloading')}
                      </span>
                    }
                    onPress={() => {
                      closeCoverMenu()
                      void useInstallQueueStore.getState().remove(game.id)
                    }}
                  />
                ) : null}
                {queuePosition !== null
                  ? (() => {
                      const item = pauseItem(game.id, paused, t)
                      return (
                        <MenuItem
                          focusKey={PAUSE_KEY}
                          label={item.label}
                          icon={item.icon}
                          trailing={
                            paused ? (
                              <span className="cover-menu__note">
                                {t('components.coverMenu.paused')}
                              </span>
                            ) : undefined
                          }
                          onPress={() => {
                            closeCoverMenu()
                            item.run()
                          }}
                        />
                      )
                    })()
                  : null}
                <MenuItem
                  focusKey={`${FOCUS_KEY}:folder`}
                  label={t('components.coverMenu.showInFolder')}
                  icon={<FolderOpen />}
                  disabled={!folder && !recompFolderOf}
                  trailing={
                    recompFolderOf ? (
                      <span className="cover-menu__note">
                        {t('components.coverMenu.recompilation')}
                      </span>
                    ) : folder ? undefined : (
                      <span className="cover-menu__note">
                        {t('components.coverMenu.notInstalled')}
                      </span>
                    )
                  }
                  onPress={() => {
                    if (recompFolderOf) {
                      api.openRecompFolder(recompFolderOf, 'install').catch((err) => {
                        log.error('openRecompFolder failed', err)
                        useUiStore
                          .getState()
                          .toast(t('components.coverMenu.recompFolderFailed'), 'error')
                      })
                      closeCoverMenu()
                      return
                    }
                    if (!folder) return
                    showInFolder(folder)
                    closeCoverMenu()
                  }}
                />
                {steamCopy ? (
                  <MenuItem
                    focusKey={`${FOCUS_KEY}:dlc`}
                    label={t('components.coverMenu.manageDlc')}
                    icon={<Puzzle />}
                    onPress={() => {
                      closeCoverMenu()
                      useUiStore
                        .getState()
                        .openModal({ type: 'steam-dlc', gameId: steamCopy.id, mode: 'manage' })
                    }}
                  />
                ) : null}
                <MenuItem
                  focusKey={`${FOCUS_KEY}:completed`}
                  label={
                    completed
                      ? t('components.coverMenu.unmarkCompleted')
                      : t('components.coverMenu.markCompleted')
                  }
                  icon={<CircleCheck />}
                  selected={completed}
                  onPress={() => {
                    toggleCompleted(game.id)
                    closeCoverMenu()
                  }}
                />
                {filterRows}
                {/* Only for a game found in more than one store: a single copy has nothing to choose. */}
                {copies.length > 1 ? (
                  <MenuItem
                    focusKey={`${FOCUS_KEY}:preferred`}
                    label={t('components.coverMenu.preferredCopy')}
                    icon={<Layers />}
                    trailing={
                      <span className="cover-menu__copy">
                        <PlatformBadge
                          platform={platformsById.get(shown.platformId)}
                          name={storeName(shown, platformsById)}
                          size="sm"
                        />
                        <span className="cover-menu__note">
                          {t('components.coverMenu.copies', { count: copies.length })}
                        </span>
                        <ChevronRight />
                      </span>
                    }
                    onPress={() => setMode('copies')}
                    onArrowPress={(direction) => {
                      if (direction !== 'right') return true
                      setMode('copies')
                      return false
                    }}
                  />
                ) : null}
                {deletable ? (
                  <MenuItem
                    focusKey={`${FOCUS_KEY}:delete-local`}
                    label={t('components.coverMenu.deleteLocal')}
                    icon={<Trash2 />}
                    danger
                    trailing={
                      copies.length > 1 ? (
                        <span className="cover-menu__note">
                          {storeName(deletable, platformsById)}
                        </span>
                      ) : undefined
                    }
                    onPress={() => {
                      closeCoverMenu()
                      void startLocalDelete(deletable)
                    }}
                  />
                ) : null}
              </Menu>
            ) : mode === 'custom' ? (
              <Menu aria-label={t('components.coverMenu.customFilters')}>
                {customFilters.map((filter) => {
                  const on = inFilter.has(filter.id)
                  return (
                    <MenuItem
                      key={filter.id}
                      focusKey={customFilterKey(filter.id)}
                      label={
                        on
                          ? t('components.coverMenu.removeFromFilter', { name: filter.name })
                          : t('components.coverMenu.addToFilter', { name: filter.name })
                      }
                      icon={
                        <CustomFilterIconView icon={filter.icon} className="custom-filter-icon" />
                      }
                      selected={on}
                      trailing={on ? <Check className="select-menu__check" /> : undefined}
                      onPress={() => toggleFilter(filter.id)}
                      onArrowPress={(direction) => {
                        if (direction !== 'left') return true
                        back()
                        return false
                      }}
                    />
                  )
                })}
              </Menu>
            ) : (
              <Menu aria-label={t('components.coverMenu.copiesLabel')}>
                {copies.map((copy) => (
                  <MenuItem
                    key={copy.id}
                    focusKey={`${FOCUS_KEY}:copy:${copy.id}`}
                    label={storeName(copy, platformsById)}
                    icon={
                      <PlatformBadge
                        platform={platformsById.get(copy.platformId)}
                        name={storeName(copy, platformsById)}
                        size="sm"
                      />
                    }
                    selected={copy.id === shown.id}
                    trailing={
                      <span className="cover-menu__copy">
                        <span className="cover-menu__note">
                          {copy.installed
                            ? t('components.coverMenu.installed')
                            : t('components.coverMenu.notInstalled')}
                        </span>
                        {copy.id === shown.id ? <Check className="select-menu__check" /> : null}
                      </span>
                    }
                    onPress={() => (copy.id === shown.id ? closeCoverMenu() : choose(copy))}
                    onArrowPress={(direction) => {
                      if (direction !== 'left') return true
                      back()
                      return false
                    }}
                  />
                ))}
              </Menu>
            )}
          </div>
        </FocusContext.Provider>
      </LayerContext.Provider>
    </div>,
    document.body
  )
}
