import type {
  InstalledVrMod,
  VrModEntry,
  VrModProgress,
  VrModRelease,
  VrModsView
} from '@shared/vr-mods'
import {
  ArrowBigUp,
  ArrowDownUp,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  Glasses,
  History,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { Modal } from '../../components/Modal'
import { SelectField } from '../../components/SelectField'
import { Spinner } from '../../components/Spinner'
import { TextField } from '../../components/TextField'
import { useActionHandlers } from '../../hooks/useActionHandlers'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT, type Translate } from '../../i18n'
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
import { useUiStore } from '../../state/ui'
import { clearVrModProgress, useVrModsStore, vrModBusy } from '../../state/vrMods'
import { Markdown } from '../Recomp/Markdown'
import { releaseInstallKind, shownReleases } from '../Recomp/recompView'
import {
  filterCounts,
  isQuestMod,
  isQuestOnlyMod,
  kindLabel,
  modAction,
  modFacts,
  modLinks,
  progressWorthShowing,
  shownMods,
  siteName,
  vrFilters,
  vrProgressText,
  vrSorts,
  type VrFilter,
  type VrSort
} from './vrView'
import './vrBrowser.css'

const log = createLog('vr-browser')
const FK = 'vr-browser'
const key = (...parts: string[]): string => [FK, ...parts].join(':')
/** Mods listed at a time; "Show more" adds this many again. */
const PAGE = 60
/** Right-stick scroll of the detail, as a share of its height. */
const STICK_SCROLL = 0.6

type Remote<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T }

/**
 * The VR mod browser (Settings › VR › Browse VR mods): every mod on the Flat2VR release list. Search, filters (new
 * mods, updates, tools, profiles, Quest standalone, downloaded), sort, and the chosen mod on the right: its summary,
 * highlights and links, and for a GitHub mod Download / Update / Remove, its releases and README. Downloads are only
 * kept in the VR Mods folder: PlayOut never runs them.
 */
export function VrBrowser({ onClose }: { onClose: () => void }): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const version = useVrModsStore((s) => s.version)
  const progress = useVrModsStore((s) => s.progress)
  const [view, setView] = useState<VrModsView | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<VrFilter>('all')
  const [sort, setSort] = useState<VrSort>('newest')
  const [shown, setShown] = useState(PAGE)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .getVrMods()
      .then((next) => {
        setView(next)
        setFailed(false)
      })
      .catch((err) => {
        log.error('getVrMods failed', err)
        setFailed(true)
      })
  }, [])
  // Read again when main says something changed (a download finished, updates were found).
  useEffect(load, [load, version])

  const installed = useMemo(() => view?.installed ?? {}, [view])
  const list = useMemo(
    () => (view ? shownMods(view.mods, { query, filter, sort, installed }) : []),
    [view, query, filter, sort, installed]
  )
  const counts = useMemo(
    () => (view ? filterCounts(view.mods, installed) : null),
    [view, installed]
  )
  const visible = list.slice(0, shown)
  const current = visible.find((m) => m.id === selected) ?? visible[0] ?? null

  // Once the list is read, a pad starts on the search field (the modal focused Close while it was loading).
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

  // "Show more" moves focus to the first row it added.
  const focusRow = useRef<string | null>(null)
  useEffect(() => {
    const row = focusRow.current
    focusRow.current = null
    if (row && doesFocusableExist(key('mod', row))) void setFocus(key('mod', row))
  }, [shown])

  // After a removal the mod's Remove / Open folder buttons (and, under "Downloaded", its row) go away: a pad's focus
  // moves to its Download button, its page, its row, the first row or the search field, whichever is there (as the
  // recompilation page focuses its main button after an uninstall). Tried once the removal resolves and again once
  // the list is read again, whichever comes last.
  const refocusAfterRemove = useRef<string | null>(null)
  const refocusRemoved = useCallback((id: string, firstRow: string | null): void => {
    const cur = getCurrentFocusKey()
    const lost =
      !cur ||
      !doesFocusableExist(cur) ||
      cur === key('remove', id) ||
      cur === key('folder', id) ||
      cur === FK
    if (!lost) return
    const target = [
      key('download', id),
      key('page', id),
      key('mod', id),
      firstRow ? key('mod', firstRow) : null,
      key('search')
    ].find((k): k is string => !!k && doesFocusableExist(k))
    if (target) void setFocus(target)
  }, [])
  useEffect(() => {
    const id = refocusAfterRemove.current
    if (!id || !view || id in view.installed) return undefined
    refocusAfterRemove.current = null
    const timer = setTimeout(() => refocusRemoved(id, list[0]?.id ?? null), 0)
    return () => clearTimeout(timer)
  }, [view, list, refocusRemoved])
  const listRef = useRef(list)
  useEffect(() => {
    listRef.current = list
  }, [list])

  const fail = (what: string, fallback: string) => (err: unknown) => {
    log.error(`${what} failed`, err)
    toast(ipcErrorMessage(err) || fallback, 'error')
  }

  const download = (m: VrModEntry, tag?: string): void => {
    if (vrModBusy(progress[m.id])) return
    // The button turns into a progress line: keep a pad's focus on this mod.
    const cur = getCurrentFocusKey()
    if (cur === key('download', m.id) || cur === key('update', m.id))
      void setFocus(key('page', m.id))
    api
      .downloadVrMod(m.id, tag)
      .then(() => toast(t('vrMods.toast.downloading', { title: m.title })))
      .catch(fail('downloadVrMod', t('vrMods.toast.downloadFailed', { title: m.title })))
  }
  const openUrl = (url: string): void => {
    api.openExternal(url).catch(fail('openExternal', t('vrMods.toast.openPageFailed')))
  }
  const openFolder = (m: VrModEntry): void => {
    api.openVrModFolder(m.id).catch(fail('openVrModFolder', t('vrMods.toast.openFolderFailed')))
  }
  const remove = (m: VrModEntry): void => {
    if (vrModBusy(progress[m.id])) return
    openModal({
      type: 'confirm',
      title: t('vrMods.remove.title', { title: m.title }),
      message: t('vrMods.remove.message'),
      confirmLabel: t('vrMods.remove.confirm'),
      danger: true,
      onConfirm: () =>
        api
          .removeVrMod(m.id)
          .then(() => {
            clearVrModProgress(m.id)
            toast(t('vrMods.toast.removed', { title: m.title }), 'success')
            // The list may be read again before or after this: refocus now, and again once it is.
            refocusAfterRemove.current = m.id
            setTimeout(() => refocusRemoved(m.id, listRef.current[0]?.id ?? null), 0)
          })
          .catch(fail('removeVrMod', t('vrMods.toast.removeFailed', { title: m.title })))
    })
  }

  const subtitle = view
    ? [
        t('vrMods.mods', { count: view.mods.length }),
        t('vrMods.downloadedCount', { count: Object.keys(installed).length })
      ].join(' · ')
    : undefined
  const filters = vrFilters()

  return (
    <Modal
      size="panel"
      scrim
      focusKey={FK}
      preferredChildFocusKey={key('search')}
      title={t('vrMods.title')}
      subtitle={subtitle}
      onClose={onClose}
      bodyClassName="vr-browser"
    >
      {view === null ? (
        failed ? (
          <div className="vr-browser__empty" role="status">
            {t('vrMods.readFailed')}
            <Button focusKey={key('retry')} variant="ghost" icon={<RotateCcw />} onPress={load}>
              {t('vrMods.tryAgain')}
            </Button>
          </div>
        ) : (
          <Spinner label={t('vrMods.reading')} className="vr-browser__spinner" />
        )
      ) : (
        <>
          <div className="vr-browser__bar">
            <TextField
              focusKey={key('search')}
              className="vr-browser__search"
              icon={<Search />}
              placeholder={t('vrMods.searchPlaceholder')}
              oskTitle={t('vrMods.searchTitle')}
              clearable
              value={query}
              onChange={(q) => {
                setQuery(q)
                setShown(PAGE)
              }}
            />
            <SelectField
              focusKey={key('sort')}
              variant="pill"
              icon={<ArrowDownUp />}
              label={t('vrMods.sortBy')}
              value={sort}
              options={vrSorts()}
              onChange={(next) => {
                setSort(next)
                setShown(PAGE)
              }}
            />
          </div>
          <div className="vr-browser__filters" role="group" aria-label={t('vrMods.show')}>
            {filters.map((f) => (
              <Button
                key={f.value}
                focusKey={key('filter', f.value)}
                variant={filter === f.value ? 'primary' : 'ghost'}
                className="vr-browser__filter"
                aria-label={`${f.label} (${counts?.[f.value] ?? 0})`}
                onPress={() => {
                  setFilter(f.value)
                  setShown(PAGE)
                }}
              >
                {f.label}
                <span className="vr-browser__filter-count">{counts?.[f.value] ?? 0}</span>
              </Button>
            ))}
          </div>
          {list.length === 0 ? (
            <div className="vr-browser__empty" role="status">
              {view.mods.length
                ? query.trim()
                  ? t('vrMods.noMatch', { query: query.trim() })
                  : t('vrMods.noneHere')
                : t('vrMods.listEmpty')}
            </div>
          ) : (
            <div className="vr-browser__split">
              <ModList preferred={current ? key('mod', current.id) : undefined}>
                {visible.map((m) => (
                  <ModRow
                    key={m.id}
                    mod={m}
                    installed={installed[m.id]}
                    update={view.updates[m.id]}
                    busy={vrModBusy(progress[m.id])}
                    selected={current?.id === m.id}
                    onSelect={() => setSelected(m.id)}
                  />
                ))}
                {list.length > shown ? (
                  <Button
                    focusKey={key('more')}
                    variant="ghost"
                    className="vr-browser__more"
                    onPress={() => {
                      focusRow.current = list[shown]?.id ?? null
                      setShown((n) => n + PAGE)
                    }}
                  >
                    {t('vrMods.showMore', { count: list.length - shown })}
                  </Button>
                ) : null}
              </ModList>
              {current ? (
                <ModDetail
                  key={current.id}
                  mod={current}
                  installed={installed[current.id]}
                  update={view.updates[current.id]}
                  progress={progress[current.id]}
                  onDownload={(tag) => download(current, tag)}
                  onOpenFolder={() => openFolder(current)}
                  onRemove={() => remove(current)}
                  onOpenUrl={openUrl}
                />
              ) : null}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

/** The list as one focus group: coming back to it (D-pad Left) lands on the mod being shown. */
function ModList({
  preferred,
  children
}: {
  preferred: string | undefined
  children: ReactNode
}): ReactElement {
  const t = useT()
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: key('mods'),
    trackChildren: true,
    saveLastFocusedChild: false,
    preferredChildFocusKey: preferred
  })
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="vr-browser__mods" role="listbox" aria-label={t('vrMods.listLabel')}>
        {children}
      </div>
    </FocusContext.Provider>
  )
}

/** One mod in the list: focusing it shows it on the right. */
function ModRow({
  mod,
  installed,
  update,
  busy,
  selected,
  onSelect
}: {
  mod: VrModEntry
  installed: InstalledVrMod | undefined
  update: string | undefined
  busy: boolean
  selected: boolean
  onSelect: () => void
}): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLDivElement>({
    focusKey: key('mod', mod.id),
    onFocus: onSelect,
    onPress: onSelect
  })
  const sub = [mod.author, mod.date ? formatDate(mod.date, 'short') : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      ref={ref}
      className={cx('vr-browser-mod', selected && 'vr-browser-mod--selected')}
      role="option"
      aria-selected={selected}
      {...props}
    >
      <span
        className="vr-browser-mod__art"
        aria-hidden="true"
        style={mod.accent ? ({ '--vr-accent': mod.accent } as CSSProperties) : undefined}
      >
        <Glasses />
      </span>
      <span className="vr-browser-mod__text">
        <span className="vr-browser-mod__name">{mod.title}</span>
        <span className="vr-browser-mod__sub">{sub}</span>
        <span className="vr-browser-mod__value">
          {kindLabel(mod.kind)}
          {mod.status ? ` · ${mod.status}` : ''}
          {mod.github ? '' : ` · ${siteName(mod.page) || t('vrMods.row.noDownloadLink')}`}
        </span>
      </span>
      {installed || busy ? (
        <span className="vr-browser-mod__meta">
          {busy ? <Spinner size="sm" /> : null}
          {update && !busy ? <Chip accent>{t('vrMods.row.update')}</Chip> : null}
          {installed && !busy ? (
            <Check className="vr-browser-mod__check" aria-label={t('vrMods.row.downloaded')} />
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

/** The right column as one focus group, so D-pad Right from the list enters it; the right stick scrolls it. */
function DetailPane({ label, children }: { label: string; children: ReactNode }): ReactElement {
  const { ref, focusKey } = useFocusable<object, HTMLElement>({
    focusKey: key('detail'),
    trackChildren: true
  })
  return (
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} className="vr-browser__detail" aria-label={label}>
        <ScrollKeys scrollRef={ref as MutableRefObject<HTMLElement | null>} />
        {children}
      </section>
    </FocusContext.Provider>
  )
}

/** The right stick scrolls the detail (the summary, README and notes are text the D-pad cannot reach). */
function ScrollKeys({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }): null {
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

function ModDetail({
  mod,
  installed,
  update,
  progress,
  onDownload,
  onOpenFolder,
  onRemove,
  onOpenUrl
}: {
  mod: VrModEntry
  installed: InstalledVrMod | undefined
  update: string | undefined
  progress: VrModProgress | undefined
  onDownload: (tag?: string) => void
  onOpenFolder: () => void
  onRemove: () => void
  onOpenUrl: (url: string) => void
}): ReactElement {
  const t = useT()
  const busy = vrModBusy(progress)
  const action = modAction(mod, installed, update, busy)
  const links = modLinks(mod)
  const site = siteName(mod.page)
  const quest = isQuestMod(mod)
  const questOnly = isQuestOnlyMod(mod)
  return (
    <DetailPane label={mod.title}>
      <header className="vr-browser__detail-head">
        <div className="u-grow">
          <h3 className="vr-browser__detail-title">{mod.title}</h3>
          <p className="vr-browser__detail-sub">
            {[
              mod.author ? t('vrMods.detail.by', { author: mod.author }) : null,
              mod.date ? formatDate(mod.date, 'medium') : null
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </header>

      <article className="vr-browser-entry">
        <div className="vr-browser-entry__chips">
          <Chip accent>{kindLabel(mod.kind)}</Chip>
          {installed ? <Chip icon={<Check />}>{t('vrMods.detail.downloaded')}</Chip> : null}
          {update && !busy ? (
            <Chip accent>{t('vrMods.detail.available', { version: update })}</Chip>
          ) : null}
          {mod.outside ? <Chip>{t('vrMods.detail.outside')}</Chip> : null}
          {mod.tags.slice(0, 8).map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
        {mod.summary ? <p className="vr-browser-entry__blurb">{mod.summary}</p> : null}
        {mod.highlights.length ? (
          <ul className="vr-browser-entry__highlights">
            {mod.highlights.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        ) : null}
        <p className="vr-browser-entry__facts">{modFacts(mod, installed).join(' · ')}</p>
        {progressWorthShowing(progress, busy) && progress ? (
          <div className="vr-browser-entry__status" aria-live="polite">
            <span
              className={cx(
                'vr-browser-entry__progress',
                progress.phase === 'failed' && 'vr-browser-entry__error'
              )}
            >
              {busy ? <Spinner size="sm" /> : null} {vrProgressText(progress)}
            </span>
            {busy ? (
              <span
                className={cx(
                  'update-progress',
                  progress.phase !== 'downloading' && 'update-progress--indeterminate'
                )}
                style={{ '--p': Math.round((progress.progress ?? 0) * 100) } as CSSProperties}
              />
            ) : null}
            {progress.warning ? (
              <span className="vr-browser-entry__warn">
                <TriangleAlert aria-hidden />
                {progress.warning}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="vr-browser-entry__actions">
          {action === 'download' ? (
            <Button
              focusKey={key('download', mod.id)}
              variant="primary"
              icon={<Download />}
              onPress={() => onDownload()}
            >
              {t('vrMods.detail.download')}
            </Button>
          ) : action === 'update' ? (
            <Button
              focusKey={key('update', mod.id)}
              variant="primary"
              icon={<ArrowBigUp />}
              onPress={() => onDownload()}
            >
              {t('vrMods.detail.updateTo', { version: update ?? '' })}
            </Button>
          ) : null}
          {installed ? (
            <Button focusKey={key('folder', mod.id)} icon={<FolderOpen />} onPress={onOpenFolder}>
              {t('vrMods.detail.openFolder')}
            </Button>
          ) : null}
          {mod.page ? (
            <Button
              focusKey={key('page', mod.id)}
              variant={action === 'page' ? 'primary' : 'secondary'}
              icon={<ExternalLink />}
              onPress={() => onOpenUrl(mod.page!)}
            >
              {action === 'page'
                ? site
                  ? t('vrMods.detail.openPageOn', { site })
                  : t('vrMods.detail.openPage')
                : t('vrMods.detail.projectPage')}
            </Button>
          ) : null}
          {installed ? (
            <Button
              focusKey={key('remove', mod.id)}
              variant="ghost"
              icon={<Trash2 />}
              onPress={onRemove}
              aria-disabled={busy}
            >
              {t('vrMods.detail.remove')}
            </Button>
          ) : null}
        </div>
        {links.length ? (
          <div className="vr-browser-entry__links">
            {links.map((l) => (
              <Button
                key={l.id}
                focusKey={key('link', mod.id, l.id)}
                variant="ghost"
                icon={<ExternalLink />}
                onPress={() => onOpenUrl(l.url)}
              >
                {l.label}
              </Button>
            ))}
          </div>
        ) : null}
        {mod.github && questOnly && !installed ? (
          <p className="vr-browser__note">{t('vrMods.detail.questOnly')}</p>
        ) : mod.github ? (
          <p className="vr-browser__note">
            {quest ? t('vrMods.detail.savedHereQuest') : t('vrMods.detail.savedHere')}
          </p>
        ) : (
          <p className="vr-browser__note">
            {mod.page
              ? site
                ? t('vrMods.detail.notOnGithubSite', { site })
                : t('vrMods.detail.notOnGithub')
              : t('vrMods.detail.noLink')}
          </p>
        )}
      </article>

      {mod.github ? (
        <>
          <ReleasesSection
            mod={mod}
            installed={installed}
            busy={busy}
            onDownload={(tag) => onDownload(tag)}
          />
          <ReadmeSection mod={mod} />
        </>
      ) : null}
    </DetailPane>
  )
}

const repoUrl = (mod: VrModEntry): string =>
  mod.github ? `https://github.com/${mod.github.owner}/${mod.github.repo}` : (mod.page ?? '')

/**
 * The mod's GitHub releases, read when opened (GitHub allows 60 anonymous calls an hour, so moving through the
 * list never asks it).
 */
function ReleasesSection({
  mod,
  installed,
  busy,
  onDownload
}: {
  mod: VrModEntry
  installed: InstalledVrMod | undefined
  busy: boolean
  onDownload: (tag: string) => void
}): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [releases, setReleases] = useState<Remote<VrModRelease[]> | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const fetchReleases = (): void => {
    setReleases({ status: 'loading' })
    api
      .getVrModReleases(mod.id)
      .then((list) => {
        if (mounted.current) setReleases({ status: 'ready', value: list })
      })
      .catch((err) => {
        log.warn('getVrModReleases failed', err)
        if (mounted.current) setReleases({ status: 'error', message: ipcErrorMessage(err) })
      })
  }
  const all = releases?.status === 'ready' ? releases.value : []
  const list = shownReleases(all)

  let body: ReactNode = null
  if (open && releases) {
    body =
      releases.status === 'loading' ? (
        <Spinner size="sm" label={t('vrMods.releases.asking')} />
      ) : releases.status === 'error' ? (
        <div className="vr-browser-entry__actions">
          <p className="vr-browser__note">{releases.message || t('vrMods.releases.unreachable')}</p>
          <Button focusKey={key('releases-retry')} icon={<RefreshCw />} onPress={fetchReleases}>
            {t('vrMods.tryAgain')}
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="vr-browser__note">{t('vrMods.releases.none')}</p>
      ) : (
        <div className="recomp-releases">
          {list.map((release) => (
            <ReleaseRow
              key={release.tag}
              release={release}
              installedTag={installed?.tag ?? null}
              label={downloadLabel(releaseInstallKind(release, all, installed), t)}
              busy={busy}
              repo={repoUrl(mod)}
              onDownload={() => onDownload(release.tag)}
            />
          ))}
        </div>
      )
  }

  return (
    <section className="vr-browser__section" aria-label={t('vrMods.releases.label')}>
      <Button
        focusKey={key('releases')}
        variant="ghost"
        icon={<History />}
        iconRight={
          <ChevronDown className={cx('recomp__chevron', open && 'recomp__chevron--open')} />
        }
        onPress={() => {
          if (!open && (releases === null || releases.status === 'error')) fetchReleases()
          setOpen(!open)
        }}
      >
        {open ? t('vrMods.releases.hide') : t('vrMods.releases.show')}
      </Button>
      {body}
    </section>
  )
}

/** A release's button: the Recompilation page's words, but VR mods are downloaded, never installed. */
function downloadLabel(kind: ReturnType<typeof releaseInstallKind>, t: Translate): string {
  switch (kind) {
    case 'update':
      return t('vrMods.releases.update')
    case 'back':
      return t('vrMods.releases.back')
    default:
      return t('vrMods.releases.download')
  }
}

function ReleaseRow({
  release,
  installedTag,
  label,
  busy,
  repo,
  onDownload
}: {
  release: VrModRelease
  installedTag: string | null
  label: string
  busy: boolean
  repo: string
  onDownload: () => void
}): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const current = release.tag === installedTag
  const notes = release.notes.trim()
  const date = formatDate(release.publishedAt, 'medium')
  return (
    <div className={cx('recomp-release', current && 'recomp-release--current')}>
      <div className="recomp-release__head">
        <div className="recomp-release__text">
          <span className="recomp-release__tag">
            {release.tag}
            {release.name && release.name !== release.tag ? (
              <span className="recomp-release__name"> · {release.name}</span>
            ) : null}
          </span>
          <span className="recomp-release__meta">
            {[
              date,
              release.asset
                ? `${release.asset.name} · ${formatBytes(release.asset.size)}`
                : t('vrMods.releases.noFile')
            ]
              .filter(Boolean)
              .join(' · ')}
            {release.prerelease ? <Chip>{t('vrMods.releases.prerelease')}</Chip> : null}
            {current ? <Chip accent>{t('vrMods.releases.downloaded')}</Chip> : null}
          </span>
        </div>
        <div className="recomp-release__actions">
          {notes ? (
            <Button
              focusKey={key('release-notes', release.tag)}
              variant="ghost"
              iconRight={
                <ChevronDown className={cx('recomp__chevron', open && 'recomp__chevron--open')} />
              }
              onPress={() => setOpen((o) => !o)}
            >
              {open ? t('vrMods.releases.hideNotes') : t('vrMods.releases.notes')}
            </Button>
          ) : null}
          {!current && release.asset ? (
            <Button
              focusKey={key('release', release.tag)}
              icon={<Download />}
              disabled={busy}
              onPress={onDownload}
            >
              {label}
            </Button>
          ) : null}
        </div>
      </div>
      {open && notes ? (
        <Markdown className="recomp-release__notes" text={notes} baseUrl={repo} />
      ) : null}
    </div>
  )
}

function ReadmeSection({ mod }: { mod: VrModEntry }): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [readme, setReadme] = useState<Remote<string> | null>(null)
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
      .getVrModReadme(mod.id)
      .then((text) => {
        if (mounted.current) setReadme({ status: 'ready', value: text })
      })
      .catch((err) => {
        log.warn('getVrModReadme failed', err)
        if (mounted.current) setReadme({ status: 'error', message: ipcErrorMessage(err) })
      })
  }

  let body: ReactNode = null
  if (open && readme) {
    body =
      readme.status === 'loading' ? (
        <Spinner size="sm" label={t('vrMods.readme.reading')} />
      ) : readme.status === 'error' || readme.value.trim() === '' ? (
        <p className="vr-browser__note">{t('vrMods.readme.none')}</p>
      ) : (
        <Markdown className="recomp-readme" text={readme.value} baseUrl={repoUrl(mod)} />
      )
  }

  return (
    <section className="vr-browser__section" aria-label="README">
      <Button
        focusKey={key('readme')}
        variant="ghost"
        iconRight={
          <ChevronDown className={cx('recomp__chevron', open && 'recomp__chevron--open')} />
        }
        onPress={() => {
          if (!open && (readme === null || readme.status === 'error')) fetchReadme()
          setOpen(!open)
        }}
      >
        {open ? t('vrMods.readme.hide') : t('vrMods.readme.show')}
      </Button>
      {body}
    </section>
  )
}
