import { recompOnlyKey } from '@shared/recomp-play'
import type {
  GameFileState,
  GameRecomps,
  InstalledRecomp,
  RecompEntry,
  RecompExecutables,
  RecompLaunchResult,
  RecompProgress,
  RecompSaves
} from '@shared/recomp'
import {
  AppWindow,
  ArrowBigUp,
  Check,
  ChevronDown,
  CloudAlert,
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  FolderOpen,
  History,
  Play,
  RefreshCw,
  RotateCcw,
  Settings as SettingsIcon,
  Star,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { ButtonHints } from '../../components/ButtonHints'
import { Chip } from '../../components/Chip'
import { IconButton } from '../../components/IconButton'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { useActionHandlers } from '../../hooks/useActionHandlers'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { doesFocusableExist, isFocusWithin, setFocus } from '../../input/focus'
import { cx } from '../../lib/cx'
import { formatBytes } from '../../lib/format'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import { coverUrl, heroUrl } from '../../lib/media'
import { useCurrentGameId, useGame } from '../../state/library'
import { clearRecompProgress, recompBusy, useRecompStore } from '../../state/recomp'
import { originalImageLines, useRecompImageStore } from '../../state/recompImage'
import { useUiStore, type UiState } from '../../state/ui'
import { ExeRow } from './ExeList'
import { Markdown } from './Markdown'
import { OriginalImageDelete } from './OriginalImageDelete'
import { RecompExeChooser } from './RecompExeChooser'
import { backToLatest, useRecompReleases, type FailHandler } from './recompVersions'
import { ReleaseList, VersionManager } from './VersionManager'
import {
  cloudStatusText,
  conflictText,
  entryActions,
  entryFacts,
  exeFileName,
  exeShownPath,
  exeSourceText,
  hostName,
  needHowText,
  needPickable,
  needsAsStates,
  needSpecText,
  orderedEntries,
  progressText,
  saveSourceText,
  shownNeeds,
  sourceText,
  tagTone,
  verifiedBadge,
  versionBadges
} from './recompView'

const log = createLog('recomp')

/** Focus keys of the page (children of the 'recomp' boundary). */
const FOCUS = {
  root: 'recomp',
  close: 'recomp:close',
  primary: 'recomp:primary',
  use: 'recomp:use',
  update: 'recomp:update',
  repo: 'recomp:repo',
  folder: 'recomp:folder',
  uninstall: 'recomp:uninstall',
  retry: 'recomp:retry',
  version: (id: string) => `recomp:version:${id}`,
  conflictLocal: 'recomp:conflict:local',
  conflictCloud: 'recomp:conflict:cloud',
  filePick: (id: string) => `recomp:file:${id}:pick`,
  fileClear: (id: string) => `recomp:file:${id}:clear`,
  savesOpen: 'recomp:saves:open',
  savesSettings: 'recomp:saves:settings',
  savesCopies: 'recomp:saves:copies',
  exeChange: 'recomp:exe:change',
  exeBrowse: 'recomp:exe:browse',
  exeAuto: 'recomp:exe:auto',
  exeOption: (path: string) => `recomp:exe:option:${path}`,
  originalImage: 'recomp:original-image',
  originalImageWhat: 'recomp:original-image:what',
  /** Change version and the release list (VersionManager / ReleaseList): 'versions', 'version:<tag>:use', … */
  vm: (name: string) => `recomp:vm:${name}`,
  readme: 'recomp:readme'
} as const

/** How far one right-stick flick scrolls the page, as a share of its height. */
const STICK_SCROLL = 0.6

export interface RecompPageProps {
  gameId: string
  /** 'files': open on the game files the recompilation still needs (the UP button's start asked for them). */
  focus?: 'files'
  /** The version shown first (the one the UP button started), else the game's chosen one. */
  recompId?: string
  onClose: () => void
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: GameRecomps | null }

type Remote<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T }

/**
 * The Recompilation page (the UP button left of Play, or the play menu): a game's native PC ports, modelled on
 * RecompLauncher's game page in PlayOut's look. The hero names the game; with several recompilations of it a list of
 * versions comes first (focusing one shows it; "Use this one" makes it the game's choice, which UP starts). Below,
 * the shown version: its actions (Install · size / Play / Update to … / the install's progress / Uninstall), the
 * project page, tags, features, facts, description, setup notes, the game files it needs (pick, clear, verified),
 * where it saves (its folders, read-only: they are chosen in Settings › Recompilations; the copy in the Emulation folder and a
 * save conflict to resolve), its Version (the one in use; Change version installs another release of it, an older one
 * pinned there until Back to latest; before installing, its Releases to install one) and the README. Re-read on 'recomp:changed' (useRecompStore.version); progress from 'recomp:progress'. Gamepad: D-pad moves,
 * the right stick scrolls the text, B closes.
 */
export function RecompPage({ gameId, focus, recompId, onClose }: RecompPageProps): ReactElement {
  const t = useT()
  // Its card merged into the original game (added to the library): the page follows it there.
  const game = useGame(useCurrentGameId(gameId))
  // A recompilation's own card leaves the library with its last recompilation (Delete): the page closes.
  const [ownCard, setOwnCard] = useState(false)
  if (game && !!recompOnlyKey(game) !== ownCard) setOwnCard(!!recompOnlyKey(game))
  const ownCardGone = !game && ownCard
  const closedForOwnCard = useRef(false)
  useEffect(() => {
    if (!ownCardGone || closedForOwnCard.current) return
    closedForOwnCard.current = true
    onClose()
  }, [ownCardGone, onClose])
  const version = useRecompStore((s) => s.version)
  const progressById = useRecompStore((s) => s.progress)
  // A delete question answered (Keep it) changes what the Original disc image section says: read again.
  const imageOffers = useRecompImageStore((s) => s.offers)
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)

  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [retryTick, setRetryTick] = useState(0)
  // Game-file states main returned for a pick / clear, until a re-read brings them (main sends the chosen version's).
  const [fileOverrides, setFileOverrides] = useState<Record<string, GameFileState[]>>({})
  useEffect(() => {
    let cancelled = false
    api
      .getGameRecomps(gameId)
      .then((data) => {
        if (cancelled) return
        setLoad({ status: 'ready', data })
        if (data) {
          setFileOverrides((prev) => {
            const kept = Object.entries(prev).filter(([id]) => !data.gameFiles[id])
            return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
          })
        }
      })
      .catch((err) => {
        log.error('getGameRecomps failed', err)
        // A re-read that fails keeps what is shown; only the first read shows the error.
        if (!cancelled) {
          setLoad((was) =>
            was.status === 'ready' ? was : { status: 'error', message: errorText(err) }
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [gameId, version, retryTick, imageOffers])

  const data = load.status === 'ready' ? load.data : null
  const entries = useMemo(() => (data ? orderedEntries(data) : []), [data])
  const [selectedId, setSelectedId] = useState<string | null>(recompId ?? null)
  const selected =
    entries.find((e) => e.id === selectedId) ??
    entries.find((e) => e.id === data?.preferred) ??
    entries[0]

  // Open on the primary action (or the game files) once the data is there; later re-reads leave focus alone.
  const focusedOnce = useRef(false)
  useEffect(() => {
    if (focusedOnce.current || !data || !selected) return undefined
    focusedOnce.current = true
    const timer = setTimeout(() => {
      if (!isFocusWithin(FOCUS.root)) return
      const states = shownNeeds(
        fileOverrides[selected.id] ?? data.gameFiles[selected.id] ?? needsAsStates(selected)
      )
      const firstFile = states.find((s) => !s.ready) ?? states[0]
      const fileKey = firstFile ? FOCUS.filePick(firstFile.id) : null
      // A save conflict holds every start back: its buttons come first.
      const conflict = !!data.installed[selected.id]?.cloud.conflict
      const key =
        conflict && doesFocusableExist(FOCUS.conflictLocal)
          ? FOCUS.conflictLocal
          : focus === 'files' && fileKey && doesFocusableExist(fileKey)
            ? fileKey
            : FOCUS.primary
      void setFocus(key)
    }, 0)
    return () => clearTimeout(timer)
  }, [data, selected, focus, fileOverrides])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const title = game ? displayTitle(game) : (data?.title.game ?? t('recomp.recompilations'))
  const hero = (game ? heroUrl(game) : undefined) ?? selected?.heroUrl ?? undefined
  const cover = (game ? coverUrl(game) : undefined) ?? selected?.coverUrl ?? undefined

  return (
    <Modal
      size="panel"
      bare
      scrim
      focusKey={FOCUS.root}
      preferredChildFocusKey={FOCUS.primary}
      onClose={onClose}
      aria-label={t('recomp.page.ariaLabel', { title })}
      className="recomp"
    >
      <div className="recomp__close">
        <IconButton
          icon={<X />}
          aria-label={t('recomp.close')}
          variant="glass"
          focusKey={FOCUS.close}
          onPress={onClose}
        />
      </div>

      <div ref={scrollRef} className="recomp__scroll">
        {/* Inside the scroller: the art scrolls away with the header rather than staying behind the text. */}
        {hero ? (
          <img key={hero} className="recomp__art" src={hero} alt="" draggable={false} />
        ) : null}
        <div className="recomp__art-fade" aria-hidden="true" />
        <header className="recomp__head">
          {cover ? <img className="recomp__cover" src={cover} alt="" draggable={false} /> : null}
          <div className="recomp__head-text">
            <span className="recomp__eyebrow">
              <ArrowBigUp aria-hidden="true" />
              {t('recomp.page.eyebrow')}
            </span>
            <h1 className="recomp__title">{title}</h1>
            {data ? (
              <span className="recomp__subtitle">
                {[
                  data.title.console,
                  entries.length > 1
                    ? t('recomp.recompilationCount', { count: entries.length })
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            ) : null}
          </div>
        </header>

        {load.status === 'loading' ? (
          <div className="recomp__state">
            <Spinner label={t('recomp.page.reading')} />
          </div>
        ) : load.status === 'error' ? (
          <div className="recomp__state">
            <p>{t('recomp.page.readFailed', { error: load.message })}</p>
            <Button
              focusKey={FOCUS.retry}
              icon={<RefreshCw />}
              onPress={() => {
                setLoad({ status: 'loading' })
                setRetryTick((n) => n + 1)
              }}
            >
              {t('recomp.tryAgain')}
            </Button>
          </div>
        ) : !data || !selected ? (
          <div className="recomp__state">
            <p>{t('recomp.page.unknown')}</p>
          </div>
        ) : (
          <>
            {entries.length > 1 ? (
              <VersionList
                data={data}
                entries={entries}
                selectedId={selected.id}
                progressById={progressById}
                onSelect={setSelectedId}
              />
            ) : null}
            <EntryDetails
              key={selected.id}
              gameId={gameId}
              gameTitle={title}
              data={data}
              entry={selected}
              multiple={entries.length > 1}
              progress={progressById[selected.id]}
              fileStates={
                fileOverrides[selected.id] ?? data.gameFiles[selected.id] ?? needsAsStates(selected)
              }
              onFileStates={(states) =>
                setFileOverrides((prev) => ({ ...prev, [selected.id]: states }))
              }
              toast={toast}
              openModal={openModal}
            />
          </>
        )}
      </div>

      <ScrollKeys scrollRef={scrollRef} />
      <ButtonHints
        hints={[
          { button: 'a', label: t('recomp.page.hints.select') },
          { button: 'b', label: t('recomp.page.hints.back') },
          { button: 'rs', label: t('recomp.page.hints.scroll') }
        ]}
      />
    </Modal>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/** The right stick scrolls the page (the README and notes are text the D-pad cannot reach). */
function ScrollKeys({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }): null {
  useActionHandlers({
    'rs-up': () => {
      const el = scrollRef.current
      if (el) el.scrollBy({ top: -el.clientHeight * STICK_SCROLL, behavior: 'smooth' })
      return true
    },
    'rs-down': () => {
      const el = scrollRef.current
      if (el) el.scrollBy({ top: el.clientHeight * STICK_SCROLL, behavior: 'smooth' })
      return true
    }
  })
  return null
}

// ---- versions -------------------------------------------------------------------------------------------------

function VersionList({
  data,
  entries,
  selectedId,
  progressById,
  onSelect
}: {
  data: GameRecomps
  entries: RecompEntry[]
  selectedId: string
  progressById: Record<string, RecompProgress>
  onSelect: (id: string) => void
}): ReactElement {
  const t = useT()
  return (
    <section className="recomp__section" aria-label={t('recomp.page.versions')}>
      <h2 className="recomp__section-title">{t('recomp.page.versions')}</h2>
      <p className="recomp__lead">{t('recomp.page.versionsLead')}</p>
      <div className="recomp__versions" role="listbox" aria-label={t('recomp.page.versionsList')}>
        {entries.map((entry) => (
          <VersionRow
            key={entry.id}
            entry={entry}
            data={data}
            selected={entry.id === selectedId}
            busy={recompBusy(progressById[entry.id])}
            onSelect={() => onSelect(entry.id)}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * One version: pressing it (a click, A) shows it below and moves on to its actions. Hovering or moving the focus over
 * it does not: the version shown changes only when one is picked.
 */
function VersionRow({
  entry,
  data,
  selected,
  busy,
  onSelect
}: {
  entry: RecompEntry
  data: GameRecomps
  selected: boolean
  busy: boolean
  onSelect: () => void
}): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLDivElement>({
    focusKey: FOCUS.version(entry.id),
    onPress: () => {
      onSelect()
      setTimeout(() => void setFocus(FOCUS.primary), 0)
    }
  })
  const badges = versionBadges(entry, data)
  return (
    <div
      ref={ref}
      className={cx('recomp-version', selected && 'recomp-version--selected')}
      role="option"
      aria-selected={selected}
      {...props}
    >
      <EntryIcon entry={entry} />
      <div className="recomp-version__text">
        <span className="recomp-version__name">{entry.name}</span>
        <span className="recomp-version__author">
          {entry.author ? t('recomp.by', { author: entry.author }) : entry.repo}
        </span>
        <span className="recomp-version__badges">
          {busy ? <Chip accent>{t('recomp.button.installing')}</Chip> : null}
          {badges.map((b) => (
            <Chip
              key={b.label}
              accent={b.kind === 'accent'}
              className={cx(b.kind === 'update' && 'recomp-chip--update')}
            >
              {b.label}
            </Chip>
          ))}
        </span>
      </div>
      <div className="recomp-version__meta">
        {entry.stars !== null ? (
          <span className="recomp-version__stars">
            <Star aria-hidden="true" />
            {entry.stars.toLocaleString()}
          </span>
        ) : null}
        {entry.downloadBytes ? <span>{formatBytes(entry.downloadBytes)}</span> : null}
        {data.preferred === entry.id ? (
          <Check className="recomp-version__chosen" aria-label={t('recomp.badge.yourChoice')} />
        ) : null}
      </div>
    </div>
  )
}

function EntryIcon({ entry, large }: { entry: RecompEntry; large?: boolean }): ReactElement {
  const [failed, setFailed] = useState(false)
  const src = entry.iconUrl ?? entry.coverUrl
  return (
    <span className={cx('recomp-icon', large && 'recomp-icon--lg')} aria-hidden="true">
      {src && !failed ? (
        <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <ArrowBigUp />
      )}
    </span>
  )
}

// ---- the shown version ----------------------------------------------------------------------------------------

interface EntryDetailsProps {
  gameId: string
  gameTitle: string
  data: GameRecomps
  entry: RecompEntry
  multiple: boolean
  progress: RecompProgress | undefined
  fileStates: GameFileState[]
  onFileStates: (states: GameFileState[]) => void
  toast: UiState['toast']
  openModal: UiState['openModal']
}

function EntryDetails({
  gameId,
  gameTitle,
  data,
  entry,
  multiple,
  progress,
  fileStates,
  onFileStates,
  toast,
  openModal
}: EntryDetailsProps): ReactElement {
  const t = useT()
  const installed = data.installed[entry.id]
  const update = data.updates[entry.id]
  const actions = entryActions(entry, installed, update, progress)
  const preferred = data.preferred === entry.id
  const game = useGame(gameId)
  // The project's releases (main caches them; the Version section reads the same list): Last updated goes by them.
  const { releases } = useRecompReleases(entry.id, true)
  const facts = entryFacts(
    entry,
    installed,
    update,
    releases.status === 'ready' ? releases.value : null
  )
  const needs = shownNeeds(fileStates)
  const missing = needs.filter((n) => !n.ready)
  // Play asked which program starts the game (its folder has several): the chooser, then Play again.
  const [exeChoice, setExeChoice] = useState<RecompExecutables | null>(null)

  const install = useCallback(
    (tag?: string) => {
      api
        .installRecomp(entry.id, tag)
        .then(() => undefined)
        .catch((err) => {
          log.error('installRecomp failed', err)
          toast(
            t('recomp.page.installFailed', { name: entry.name, error: errorText(err) }),
            'error'
          )
        })
      toast(
        tag
          ? t('recomp.page.installingTag', { name: entry.name, tag })
          : t('recomp.page.installing', { name: entry.name })
      )
      setTimeout(() => void setFocus(FOCUS.primary), 0)
    },
    [entry, toast, t]
  )

  const updateNow = (): void => {
    api.updateRecomp(entry.id).catch((err) => {
      log.error('updateRecomp failed', err)
      toast(t('recomp.page.updateFailed', { name: entry.name, error: errorText(err) }), 'error')
    })
    toast(
      update
        ? t('recomp.page.updatingTo', { name: entry.name, tag: update })
        : t('recomp.page.updating', { name: entry.name })
    )
    setTimeout(() => void setFocus(FOCUS.primary), 0)
  }

  const fail: FailHandler = useCallback(
    (what: string, fallback: string) => (err: unknown) => {
      log.error(`${what} failed`, err)
      toast(`${fallback}: ${errorText(err)}`, 'error')
    },
    [toast]
  )

  /** Pinned: install the newest release, and the pin goes (the progress takes the primary slot). */
  const latestNow = (): void => {
    if (actions.busy) return
    backToLatest(entry, toast, fail)
    setTimeout(() => void setFocus(FOCUS.primary), 0)
  }

  const play = (): void => {
    api
      .launchRecomp(gameId, entry.id)
      .then((result: RecompLaunchResult) => {
        if (result.ok) {
          toast(t('recomp.page.starting', { name: entry.name }))
          if (result.warning) toast(result.warning, 'error')
          return
        }
        switch (result.reason) {
          case 'needs-files': {
            toast(t('recomp.page.pickFilesFirst', { name: entry.name }))
            onFileStates(result.needs)
            const first = shownNeeds(result.needs).find((n) => !n.ready)
            if (first) setTimeout(() => void setFocus(FOCUS.filePick(first.id)), 0)
            return
          }
          case 'choose-exe':
            setExeChoice(result.executables)
            return
          case 'save-conflict':
            // The re-read ('recomp:changed') shows the banner; say so in case it is scrolled away.
            toast(t('recomp.page.saveConflict'))
            setTimeout(() => {
              if (doesFocusableExist(FOCUS.conflictLocal)) void setFocus(FOCUS.conflictLocal)
            }, 50)
            return
          default:
            toast(result.message || t('recomp.page.startFailed', { name: entry.name }), 'error')
        }
      })
      .catch((err) => {
        log.error('launchRecomp failed', err)
        toast(t('recomp.page.startFailed', { name: entry.name }), 'error')
      })
  }

  const usePreferred = (): void => {
    api
      .setPreferredRecomp(gameId, entry.id)
      .then(() => toast(t('recomp.page.nowUses', { game: gameTitle, name: entry.name }), 'success'))
      .catch((err) => {
        log.error('setPreferredRecomp failed', err)
        toast(t('recomp.page.useFailed'), 'error')
      })
  }

  const uninstall = (): void => {
    if (!installed) return
    openModal({
      type: 'confirm',
      title: t('recomp.page.deleteTitle', { name: entry.name }),
      // Whole sentences, the ones that apply.
      message: [
        t('recomp.page.deleteMessage', { name: entry.name, dir: installed.dir }),
        installed.cloud.enabled ? t('recomp.page.deleteCloudStays') : null,
        game && recompOnlyKey(game) && (game.metadata.recomp?.installed.length ?? 0) <= 1
          ? t('recomp.page.deleteLeavesLibrary')
          : null
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: t('recomp.page.delete'),
      danger: true,
      onConfirm: () => {
        api
          .uninstallRecomp(entry.id)
          .then(() => {
            clearRecompProgress(entry.id)
            toast(t('recomp.page.deleted', { name: entry.name }))
            setTimeout(() => {
              if (doesFocusableExist(FOCUS.primary)) void setFocus(FOCUS.primary)
            }, 0)
          })
          .catch((err) => {
            log.error('uninstallRecomp failed', err)
            toast(
              t('recomp.page.uninstallFailed', { name: entry.name, error: errorText(err) }),
              'error'
            )
          })
      }
    })
  }

  const openFolder = (which: 'install' | 'saves' | 'copies'): void => {
    api.openRecompFolder(entry.id, which).catch((err) => {
      log.error('openRecompFolder failed', err)
      toast(t('recomp.page.openFolderFailed'), 'error')
    })
  }

  const openRepo = (): void => {
    api.openExternal(entry.repoUrl).catch((err) => {
      log.error('openExternal failed', err)
      toast(t('recomp.page.openHostFailed', { host: hostName(entry.host) }), 'error')
    })
  }

  const resolveConflict = (keep: 'local' | 'cloud'): void => {
    api
      .resolveRecompConflict(entry.id, keep)
      .then(() =>
        toast(keep === 'local' ? t('recomp.page.keptLocal') : t('recomp.page.keptCloud'), 'success')
      )
      .catch((err) => {
        log.error('resolveRecompConflict failed', err)
        toast(t('recomp.page.keepFailed', { error: errorText(err) }), 'error')
      })
    setTimeout(() => void setFocus(FOCUS.primary), 0)
  }

  const conflict = installed?.cloud.conflict ?? null

  return (
    <div className="recomp__body">
      {exeChoice ? (
        <RecompExeChooser
          title={gameTitle}
          executables={exeChoice}
          onChosen={() => {
            setExeChoice(null)
            play()
          }}
          onClose={() => setExeChoice(null)}
        />
      ) : null}
      <div className="recomp__main">
        <section className="recomp__section recomp__summary" aria-label={entry.name}>
          <div className="recomp__entry-head">
            <EntryIcon entry={entry} large />
            <div className="recomp__entry-text">
              <h2 className="recomp__entry-name">{entry.name}</h2>
              <span className="recomp__entry-by">
                {[
                  entry.author ? t('recomp.by', { author: entry.author }) : null,
                  entry.game !== gameTitle ? entry.game : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          </div>
          {entry.blurb ? <p className="recomp__blurb">{entry.blurb}</p> : null}

          {conflict ? (
            <div className="recomp-banner recomp-banner--warn" role="alert">
              <CloudAlert className="recomp-banner__icon" aria-hidden="true" />
              <div className="recomp-banner__text">
                <strong>{t('recomp.conflict.title', { name: entry.name })}</strong>
                <span>{conflictText(conflict)}</span>
              </div>
              <div className="recomp-banner__actions">
                <Button focusKey={FOCUS.conflictLocal} onPress={() => resolveConflict('local')}>
                  {t('recomp.conflict.keepLocal')}
                </Button>
                <Button focusKey={FOCUS.conflictCloud} onPress={() => resolveConflict('cloud')}>
                  {t('recomp.conflict.keepCloud')}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="recomp__actions">
            <PrimaryAction
              entry={entry}
              progress={progress}
              busy={actions.busy}
              install={actions.install}
              play={actions.play}
              onInstall={() => install()}
              onPlay={play}
            />
            {actions.update ? (
              <Button focusKey={FOCUS.update} size="lg" icon={<Download />} onPress={updateNow}>
                {t('recomp.page.updateTo', { tag: actions.update })}
              </Button>
            ) : actions.pinned ? (
              <>
                <Chip className="recomp-vm__pin">
                  {t('recomp.version.pinnedTo', { tag: actions.pinned })}
                </Chip>
                <Button focusKey={FOCUS.update} size="lg" icon={<ArrowBigUp />} onPress={latestNow}>
                  {t('recomp.page.backToLatest')}
                </Button>
              </>
            ) : null}
            {multiple && !preferred ? (
              <Button focusKey={FOCUS.use} size="lg" icon={<Check />} onPress={usePreferred}>
                {t('recomp.page.useThisOne')}
              </Button>
            ) : null}
            <Button focusKey={FOCUS.repo} icon={<ExternalLink />} onPress={openRepo}>
              {t('recomp.page.viewOn', { host: hostName(entry.host) })}
            </Button>
            {installed ? (
              <>
                <Button
                  focusKey={FOCUS.folder}
                  icon={<FolderOpen />}
                  onPress={() => openFolder('install')}
                >
                  {t('recomp.page.openFolder')}
                </Button>
                <Button
                  focusKey={FOCUS.uninstall}
                  variant="ghost"
                  icon={<Trash2 />}
                  disabled={actions.busy}
                  onPress={uninstall}
                >
                  {t('recomp.page.delete')}
                </Button>
              </>
            ) : null}
          </div>

          {actions.failed ? (
            <p className="recomp__note recomp__note--error" role="status">
              <TriangleAlert aria-hidden="true" />
              {actions.failed}
            </p>
          ) : null}
          {actions.warning ? (
            <p className="recomp__note recomp__note--warn" role="status">
              <TriangleAlert aria-hidden="true" />
              {actions.warning}
            </p>
          ) : null}
          {entry.installer && installed?.exeChosen !== 'user' ? (
            <p className="recomp__note">
              {installed ? t('recomp.page.installerNoteInstalled') : t('recomp.page.installerNote')}
            </p>
          ) : null}
          {!installed && missing.length > 0 ? (
            <p className="recomp__note">
              {t('recomp.page.needsCopy', { files: missing.map((n) => n.label).join(', ') })}
            </p>
          ) : null}
          {entry.archived ? (
            <p className="recomp__note recomp__note--warn">
              <TriangleAlert aria-hidden="true" />
              {t('recomp.page.archived')}
            </p>
          ) : null}

          {entry.tags.length > 0 ? (
            <div className="recomp__tags">
              {entry.tags.map((tag) => {
                const tone = tagTone(tag)
                return (
                  <Chip
                    key={`${tag.kind}:${tag.label}`}
                    accent={tone === 'accent'}
                    className={cx(tone === 'warn' && 'recomp-chip--warn')}
                  >
                    {tag.label}
                  </Chip>
                )
              })}
            </div>
          ) : null}
        </section>

        {entry.features.length > 0 ? (
          <section className="recomp__section" aria-label={t('recomp.page.features')}>
            <h2 className="recomp__section-title">{t('recomp.page.features')}</h2>
            <ul className="recomp__features">
              {entry.features.map((f) => (
                <li key={f}>
                  <Check aria-hidden="true" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {entry.description && entry.description.trim() !== entry.blurb.trim() ? (
          <section className="recomp__section" aria-label={t('recomp.page.about')}>
            <h2 className="recomp__section-title">{t('recomp.page.about')}</h2>
            <Markdown text={entry.description} baseUrl={entry.repoUrl} />
          </section>
        ) : null}

        {entry.setupNotes.length > 0 ? (
          <section className="recomp__section" aria-label={t('recomp.page.setup')}>
            <h2 className="recomp__section-title">{t('recomp.page.setup')}</h2>
            <ol className="recomp__steps">
              {entry.setupNotes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ol>
          </section>
        ) : null}

        {needs.length > 0 ? (
          <GameFilesSection
            gameId={gameId}
            entry={entry}
            installed={installed}
            needs={needs}
            onFileStates={onFileStates}
            toast={toast}
          />
        ) : null}

        {installed ? <ProgramSection entry={entry} installed={installed} toast={toast} /> : null}

        {installed && data.originalImage?.recompId === entry.id ? (
          <OriginalImageSection
            gameId={gameId}
            entry={entry}
            image={data.originalImage}
            toast={toast}
          />
        ) : null}

        {installed ? (
          <SavesSection
            entry={entry}
            installed={installed}
            onOpenFolder={openFolder}
            onManage={() => openModal({ type: 'settings', section: 'recompilations' })}
          />
        ) : null}

        <ReleasesSection
          entry={entry}
          installed={installed}
          update={update ?? null}
          busy={actions.busy}
          onInstall={install}
          fail={fail}
        />

        <ReadmeSection entry={entry} />
      </div>

      <aside className="recomp__rail" aria-label={t('recomp.facts.label')}>
        <dl className="recomp-facts">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className={cx('recomp-facts__row', fact.tone === 'warn' && 'recomp-facts__row--warn')}
            >
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </div>
  )
}

/**
 * The version's first action, always under one focus key so focus stays on it while it turns from Install into the
 * progress block and then into Play: Install · size, the progress (not pressable), or Play.
 */
function PrimaryAction({
  entry,
  progress,
  busy,
  install,
  play,
  onInstall,
  onPlay
}: {
  entry: RecompEntry
  progress: RecompProgress | undefined
  busy: boolean
  install: string | null
  play: boolean
  onInstall: () => void
  onPlay: () => void
}): ReactElement {
  const t = useT()
  const onPress = busy ? undefined : play ? onPlay : install ? onInstall : undefined
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey: FOCUS.primary,
    onPress
  })
  if (busy && progress) {
    const text = progressText(progress)
    return (
      <button
        ref={ref}
        type="button"
        className="recomp-progress"
        role="progressbar"
        aria-label={t('recomp.page.progressLabel', { name: entry.name, status: text.title })}
        aria-valuenow={text.percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-busy="true"
        aria-disabled="true"
        style={text.percent === null ? undefined : ({ '--p': text.percent } as CSSProperties)}
        {...props}
      >
        <span className="recomp-progress__text">
          <span className="recomp-progress__title">{text.title}</span>
          <span className="recomp-progress__detail">{text.detail}</span>
        </span>
        <span
          className={cx(
            'recomp-progress__bar',
            text.percent === null && 'recomp-progress__bar--indeterminate'
          )}
          aria-hidden="true"
        />
      </button>
    )
  }
  const label = play ? t('recomp.page.play') : (install ?? t('recomp.actions.install'))
  return (
    <button
      ref={ref}
      type="button"
      className="btn btn--primary btn--lg recomp__primary"
      aria-label={play ? t('recomp.page.playLabel', { name: entry.name }) : label}
      {...props}
    >
      <span className="btn__icon">{play ? <Play /> : <Download />}</span>
      <span className="btn__label">{label}</span>
    </button>
  )
}

// ---- game files -----------------------------------------------------------------------------------------------

function GameFilesSection({
  gameId,
  entry,
  installed,
  needs,
  onFileStates,
  toast
}: {
  gameId: string
  entry: RecompEntry
  installed: InstalledRecomp | undefined
  needs: GameFileState[]
  onFileStates: (states: GameFileState[]) => void
  toast: EntryDetailsProps['toast']
}): ReactElement {
  const t = useT()
  const pick = (need: GameFileState): void => {
    api
      .pickRecompGameFile(gameId, entry.id, need.id)
      .then(onFileStates)
      .catch((err) => {
        log.error('pickRecompGameFile failed', err)
        toast(t('recomp.files.useFailed', { error: errorText(err) }), 'error')
      })
  }
  const clear = (need: GameFileState): void => {
    api
      .setRecompGameFile(gameId, entry.id, need.id, null)
      .then((states) => {
        onFileStates(states)
        setTimeout(() => void setFocus(FOCUS.filePick(need.id)), 0)
      })
      .catch((err) => {
        log.error('setRecompGameFile failed', err)
        toast(t('recomp.files.clearFailed'), 'error')
      })
  }
  return (
    <section className="recomp__section" aria-label={t('recomp.files.title')}>
      <h2 className="recomp__section-title">{t('recomp.files.title')}</h2>
      <p className="recomp__lead">
        {installed
          ? t('recomp.files.leadInstalled', { name: entry.name })
          : t('recomp.files.lead', { name: entry.name })}
      </p>
      <div className="recomp-files">
        {needs.map((need) => {
          const badge = verifiedBadge(need)
          const pickable = needPickable(need) && !!installed
          const how = needHowText(need, entry.name)
          const spec = needSpecText(need)
          return (
            <div
              key={need.id}
              className={cx('recomp-file', !need.ready && installed && 'recomp-file--missing')}
            >
              <div className="recomp-file__text">
                <span className="recomp-file__label">
                  {need.label}
                  {need.optional ? <Chip>{t('recomp.files.optional')}</Chip> : null}
                  {badge ? (
                    <Chip
                      accent={badge.tone === 'accent'}
                      className={cx(badge.tone === 'warn' && 'recomp-chip--warn')}
                    >
                      {badge.label}
                    </Chip>
                  ) : null}
                </span>
                {need.description ? (
                  <span className="recomp-file__desc">{need.description}</span>
                ) : null}
                {spec ? <span className="recomp-file__spec">{spec}</span> : null}
                {needPickable(need) ? (
                  <span
                    className={cx('recomp-file__path', !need.path && 'recomp-file__path--empty')}
                    title={need.path ?? undefined}
                  >
                    {need.path ?? t('recomp.files.notSet')}
                    {need.path && need.source ? (
                      <span className="recomp-file__source"> · {sourceText(need.source)}</span>
                    ) : null}
                  </span>
                ) : null}
                {how ? <span className="recomp-file__how">{how}</span> : null}
                {badge?.tone === 'warn' ? (
                  <span className="recomp-file__warn">{t('recomp.files.mismatch')}</span>
                ) : null}
              </div>
              {pickable ? (
                <div className="recomp-file__actions">
                  <Button
                    focusKey={FOCUS.filePick(need.id)}
                    icon={<FolderOpen />}
                    onPress={() => pick(need)}
                  >
                    {need.accepts === 'folder'
                      ? t('recomp.files.pickFolder')
                      : need.accepts === 'file'
                        ? t('recomp.files.pickFile')
                        : t('recomp.files.pick')}
                  </Button>
                  {need.path ? (
                    <Button
                      focusKey={FOCUS.fileClear(need.id)}
                      variant="ghost"
                      icon={<X />}
                      onPress={() => clear(need)}
                    >
                      {t('recomp.files.clear')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---- the program it starts ------------------------------------------------------------------------------------

/**
 * The program Play and the UP button start (listRecompExecutables): which one and who chose it, Change (the
 * programs in its folder, the most likely game first; uninstallers, crash reporters and setup programs marked and
 * last), Browse… (a file picker: it may be outside the folder, for a setup program that put the game elsewhere) and
 * Automatic (PlayOut's pick again). Re-read on every 'recomp:changed'.
 */
function ProgramSection({
  entry,
  installed,
  toast
}: {
  entry: RecompEntry
  installed: InstalledRecomp
  toast: EntryDetailsProps['toast']
}): ReactElement {
  const t = useT()
  const version = useRecompStore((s) => s.version)
  const [view, setView] = useState<RecompExecutables | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    api
      .listRecompExecutables(entry.id)
      .then((next) => {
        if (!live) return
        setView(next)
        setFailed(false)
      })
      .catch((err) => {
        log.error('listRecompExecutables failed', err)
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [entry.id, version, installed.tag, installed.exe])

  const done = (next: RecompExecutables, before: RecompExecutables | null): void => {
    setView(next)
    setOpen(false)
    if (next.current !== before?.current || next.source !== before?.source)
      toast(
        next.current
          ? t('recomp.program.nowStarts', { name: entry.name, file: exeFileName(next.current) })
          : t('recomp.program.noProgram', { name: entry.name }),
        'success'
      )
    setTimeout(() => {
      if (doesFocusableExist(FOCUS.exeChange)) void setFocus(FOCUS.exeChange)
    }, 0)
  }
  const fail = (what: string) => (err: unknown) => {
    log.error(`${what} failed`, err)
    toast(t('recomp.exeChooser.useFailed', { error: errorText(err) }), 'error')
  }
  const choose = (path: string | null): void => {
    const before = view
    api
      .setRecompExecutable(entry.id, path)
      .then((next) => done(next, before))
      .catch(fail('setRecompExecutable'))
  }
  const browse = (): void => {
    const before = view
    api
      .pickRecompExecutable(entry.id)
      .then((next) => done(next, before))
      .catch(fail('pickRecompExecutable'))
  }
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    const first = view?.candidates.find((c) => c.current) ?? view?.candidates[0]
    if (next && first)
      setTimeout(() => {
        const key = FOCUS.exeOption(first.path)
        if (doesFocusableExist(key)) void setFocus(key)
      }, 0)
  }

  return (
    <section className="recomp__section" aria-label={t('recomp.program.title')}>
      <h2 className="recomp__section-title">
        <AppWindow aria-hidden="true" />
        {t('recomp.program.title')}
      </h2>
      <p className="recomp__lead">{t('recomp.program.lead', { name: entry.name })}</p>
      {view ? (
        <>
          <div className={cx('recomp-file', view.missing && 'recomp-file--missing')}>
            <div className="recomp-file__text">
              <span className="recomp-file__label">
                {view.current ? exeFileName(view.current) : t('recomp.program.noneFound')}
                <Chip accent={view.source === 'user'}>{exeSourceText(view.source)}</Chip>
                {view.outside ? <Chip>{t('recomp.program.outside')}</Chip> : null}
              </span>
              <span
                className={cx('recomp-file__path', !view.current && 'recomp-file__path--empty')}
                title={view.currentFull ?? undefined}
              >
                {exeShownPath(view)}
              </span>
              {view.missing ? (
                <span className="recomp-file__warn">{t('recomp.program.missing')}</span>
              ) : null}
            </div>
            <div className="recomp-file__actions">
              <Button
                focusKey={FOCUS.exeChange}
                iconRight={
                  <ChevronDown className={cx('recomp__chevron', open && 'recomp__chevron--open')} />
                }
                onPress={toggle}
              >
                {open ? t('recomp.program.hide') : t('recomp.program.change')}
              </Button>
              <Button focusKey={FOCUS.exeBrowse} icon={<FolderOpen />} onPress={browse}>
                {t('recomp.exeChooser.browse')}
              </Button>
              {view.source === 'user' ? (
                <Button
                  focusKey={FOCUS.exeAuto}
                  variant="ghost"
                  icon={<RotateCcw />}
                  onPress={() => choose(null)}
                >
                  {t('recomp.program.automatic')}
                </Button>
              ) : null}
            </div>
          </div>
          {open ? (
            view.candidates.length ? (
              <div
                className="recomp-exes"
                role="listbox"
                aria-label={t('recomp.program.listLabel', { name: entry.name })}
              >
                {view.candidates.map((c) => (
                  <ExeRow
                    key={c.path}
                    exe={c}
                    focusKey={FOCUS.exeOption(c.path)}
                    onChoose={() => choose(c.path)}
                  />
                ))}
                {view.truncated ? (
                  <p className="recomp__lead">{t('recomp.program.truncated')}</p>
                ) : null}
              </div>
            ) : (
              <p className="recomp__lead">{t('recomp.program.none')}</p>
            )
          ) : null}
        </>
      ) : failed ? (
        <p className="recomp__lead">{t('recomp.program.readFailed')}</p>
      ) : (
        <Spinner size="sm" label={t('recomp.program.looking')} />
      )}
    </section>
  )
}

// ---- saves ----------------------------------------------------------------------------------------------------

/**
 * "Delete the original disc image…" (main/recomp/image-offer.ts): this recompilation no longer reads the game's disc
 * image, and/or no longer uses the game folder PlayOut unpacked for its setup program, so the player may move them to
 * the Recycle Bin. The Delete dropdown (shown when both may go) picks the image, the folder or both; the button asks
 * through the same question PlayOut asks on its own, opened with that choice. Offered again after Keep it.
 */
function OriginalImageSection({
  gameId,
  entry,
  image,
  toast
}: {
  gameId: string
  entry: RecompEntry
  image: NonNullable<GameRecomps['originalImage']>
  toast: EntryDetailsProps['toast']
}): ReactElement {
  const t = useT()
  const folderBytes = image.folder?.totalBytes ?? null
  const lines = originalImageLines(
    entry.name,
    image,
    folderBytes !== null ? formatBytes(folderBytes) : null
  )
  return (
    <section className="recomp__section" aria-label={t('recomp.image.sectionImage')}>
      <h2 className="recomp__section-title">
        <Trash2 aria-hidden="true" />
        {image.fileName ? t('recomp.image.sectionImage') : t('recomp.image.sectionFolder')}
      </h2>
      {lines.map((line) => (
        <p key={line} className="recomp__lead">
          {line}
        </p>
      ))}
      <OriginalImageDelete
        gameId={gameId}
        recompId={entry.id}
        image={image}
        focusKeys={{ what: FOCUS.originalImageWhat, delete: FOCUS.originalImage }}
        toast={toast}
      />
    </section>
  )
}

/**
 * Where the recompilation saves (read-only here): its save folders, where the copies live in the Emulation folder
 * (Open), and the copy state. Choosing, adding and finding save folders is in Settings › Recompilations (Manage).
 * Read with getRecompSaves, again on every 'recomp:changed'.
 */
function SavesSection({
  entry,
  installed,
  onOpenFolder,
  onManage
}: {
  entry: RecompEntry
  installed: InstalledRecomp
  onOpenFolder: (which: 'saves' | 'copies') => void
  onManage: () => void
}): ReactElement {
  const t = useT()
  const version = useRecompStore((s) => s.version)
  const [saves, setSaves] = useState<RecompSaves | null>(null)
  useEffect(() => {
    let live = true
    api
      .getRecompSaves(entry.id)
      .then((next) => {
        if (live) setSaves(next)
      })
      .catch((err) => log.error('getRecompSaves failed', err))
    return () => {
      live = false
    }
  }, [entry.id, version])

  const cloud = cloudStatusText(installed.cloud)
  const templates = saves?.templates ?? installed.savePaths
  const resolved = saves?.resolved ?? installed.savePaths
  const source = saveSourceText(saves?.source ?? installed.saveSource)
  return (
    <section className="recomp__section" aria-label={t('recomp.saves.title')}>
      <h2 className="recomp__section-title">{t('recomp.saves.title')}</h2>
      {resolved.length > 0 ? (
        <>
          <ul className="recomp-saves">
            {resolved.map((p, i) => (
              <li key={p} className="recomp-saves__row">
                <span className="recomp-saves__path" title={templates[i] ?? p}>
                  {p}
                </span>
              </li>
            ))}
          </ul>
          {source ? <p className="recomp__lead">{source}</p> : null}
        </>
      ) : (
        <p className="recomp__lead">{t('recomp.saves.notFound', { name: entry.name })}</p>
      )}
      {saves?.suggestions.length ? (
        <p className="recomp__lead">
          {t('recomp.saves.suggestions', { count: saves.suggestions.length })}
        </p>
      ) : null}
      <p className={cx('recomp__note', cloud.tone === 'warn' && 'recomp__note--warn')}>
        {cloud.tone === 'warn' ? <TriangleAlert aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {cloud.text}
      </p>
      {saves ? (
        <p className="recomp__lead recomp-saves__copies" title={saves.savesDir}>
          {t('recomp.saves.copiesIn', { dir: saves.savesDir })}
        </p>
      ) : null}
      <div className="recomp__row-actions">
        {resolved.length > 0 ? (
          <Button
            focusKey={FOCUS.savesOpen}
            icon={<FolderOpen />}
            onPress={() => onOpenFolder('saves')}
          >
            {t('recomp.saves.openSaves')}
          </Button>
        ) : null}
        <Button
          focusKey={FOCUS.savesCopies}
          icon={<FolderInput />}
          onPress={() => onOpenFolder('copies')}
        >
          {t('recomp.saves.openCopies')}
        </Button>
        <Button focusKey={FOCUS.savesSettings} icon={<SettingsIcon />} onPress={onManage}>
          {t('recomp.saves.choose')}
        </Button>
      </div>
    </section>
  )
}

// ---- releases -------------------------------------------------------------------------------------------------

/**
 * Installed: the Version section (the version in use, its label and pin, Change version with the project's releases:
 * VersionManager, as in Settings › Recompilations). Not installed yet: the releases, to install one.
 */
function ReleasesSection({
  entry,
  installed,
  update,
  busy,
  onInstall,
  fail
}: {
  entry: RecompEntry
  installed: InstalledRecomp | undefined
  update: string | null
  busy: boolean
  onInstall: (tag: string) => void
  fail: FailHandler
}): ReactElement {
  const t = useT()
  const { releases, retry } = useRecompReleases(entry.id, !installed)
  const title = installed ? t('recomp.version.label') : t('recomp.releases.label')
  return (
    <section className="recomp__section" aria-label={title}>
      <h2 className="recomp__section-title">
        <History aria-hidden="true" />
        {title}
      </h2>
      {installed ? (
        <VersionManager
          layout="page"
          entry={entry}
          installed={installed}
          update={update}
          prefetch
          busy={busy}
          focusKey={FOCUS.vm}
          onSwitched={() => setTimeout(() => void setFocus(FOCUS.primary), 0)}
          fail={fail}
        />
      ) : (
        <ReleaseList
          noteClassName="recomp__lead"
          entry={entry}
          installed={undefined}
          releases={releases}
          onRetry={retry}
          busy={busy}
          onAction={(release) => onInstall(release.tag)}
          focusKey={FOCUS.vm}
        />
      )}
    </section>
  )
}

// ---- README ---------------------------------------------------------------------------------------------------

function ReadmeSection({ entry }: { entry: RecompEntry }): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [readme, setReadme] = useState<Remote<string> | null>(null)
  // Read on the first open (and again after a failure); the page remounts this section per version.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const fetchReadme = (): void => {
    setReadme({ status: 'loading' })
    api
      .getRecompReadme(entry.id)
      .then((text) => {
        if (mounted.current) setReadme({ status: 'ready', value: text })
      })
      .catch((err) => {
        log.warn('getRecompReadme failed', err)
        if (mounted.current) setReadme({ status: 'error' })
      })
  }

  let body: ReactNode = null
  if (open && readme) {
    body =
      readme.status === 'loading' ? (
        <Spinner size="sm" label={t('recomp.readme.reading')} />
      ) : readme.status === 'error' || readme.value.trim() === '' ? (
        <p className="recomp__lead">{t('recomp.readme.none', { host: hostName(entry.host) })}</p>
      ) : (
        <Markdown className="recomp-readme" text={readme.value} baseUrl={entry.repoUrl} />
      )
  }

  return (
    <section className="recomp__section" aria-label="README">
      <Button
        focusKey={FOCUS.readme}
        variant="ghost"
        className="recomp__readme-toggle"
        iconRight={
          <ChevronDown className={cx('recomp__chevron', open && 'recomp__chevron--open')} />
        }
        onPress={() => {
          if (!open && (readme === null || readme.status === 'error')) fetchReadme()
          setOpen(!open)
        }}
      >
        {open ? t('recomp.readme.hide') : t('recomp.readme.show')}
      </Button>
      {body}
    </section>
  )
}
