import {
  STORE_SOURCES,
  type AccountStatus,
  type StoreSourceId,
  type ScanProgress,
  type ScanResult,
  type SourceId,
  type SourceStatus
} from '@shared/types'
import { FilePlus, FolderSearch, Monitor, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { ButtonHints } from '../../components/ButtonHints'
import { Chip } from '../../components/Chip'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { doesFocusableExist, getCurrentFocusKey, setFocus } from '../../input/focus'
import { useT, type Translate } from '../../i18n'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import { useAccountsStore } from '../../state/accounts'
import { useLibraryStore } from '../../state/library'
import { useSettingsStore } from '../../state/settings'
import { useUiStore } from '../../state/ui'
import { RomFolderStep } from './RomFolderStep'
import { accountFocusKey } from './keys'
import { SourceCard } from './SourceCard'

const log = createLog('addgames')

const MODAL_FOCUS_KEY = 'addgames'

/** Download pages opened by a missing store's "Install" button. */
const STORE_DOWNLOAD_URLS: Record<SourceId, string | undefined> = {
  steam: 'https://store.steampowered.com/about/',
  epic: 'https://store.epicgames.com/download',
  gog: 'https://www.gog.com/galaxy',
  ea: 'https://www.ea.com/ea-app',
  battlenet: 'https://www.blizzard.com/apps/battle.net/desktop',
  ubisoft: 'https://ubisoftconnect.com/',
  xbox: 'https://www.xbox.com/apps/xbox-app-for-windows-pc',
  manual: undefined,
  rom: undefined
}

export interface AddGamesModalProps {
  onClose: () => void
}

/**
 * Add Games (the Library's "Library Import"): a card per store (detected / not installed, Scan with live progress,
 * the store account's Sign in / Sign out), the ROM folder step
 * and a PC games card (add an .exe, scan a folder), plus Scan all. Every action reports through toasts
 * and inline status; API errors are shown on the card that caused them.
 */
export function AddGamesModal({ onClose }: AddGamesModalProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const platforms = useLibraryStore((s) => s.platforms)
  const games = useLibraryStore((s) => s.games)
  const romsRoot = useSettingsStore((s) => s.settings?.library.romsRoot ?? null)
  const accounts = useAccountsStore((s) => s.accounts)
  const accountsLoaded = useAccountsStore((s) => s.loaded)
  const refreshAccounts = useAccountsStore((s) => s.refresh)
  const pendingSignIn = useAccountsStore((s) => s.pendingSignIn)
  const signIn = useAccountsStore((s) => s.signIn)
  const signOut = useAccountsStore((s) => s.signOut)
  useEffect(() => {
    if (!accountsLoaded) void refreshAccounts()
  }, [accountsLoaded, refreshAccounts])

  const [sources, setSources] = useState<SourceStatus[] | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [progress, setProgress] = useState<Partial<Record<SourceId, ScanProgress>>>({})
  const [scanning, setScanning] = useState<ReadonlySet<SourceId>>(() => new Set())
  const [scanErrors, setScanErrors] = useState<Partial<Record<SourceId, string>>>({})
  const [scanAll, setScanAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .getSources()
      .then((list) => {
        if (!cancelled) setSources(list)
      })
      .catch((err) => {
        log.error('getSources failed', err)
        if (!cancelled) setSourcesError(errorText(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () =>
      api.on('scan:progress', (event) =>
        setProgress((prev) => ({ ...prev, [event.sourceId]: event }))
      ),
    []
  )

  const stores = useMemo(
    () => (sources ?? []).filter((s) => STORE_SOURCES.includes(s.id)),
    [sources]
  )
  const romSource = sources?.find((s) => s.id === 'rom')
  const romGameCount = useMemo(() => games.filter((g) => g.source === 'rom').length, [games])
  const manualGameCount = useMemo(() => games.filter((g) => g.source === 'manual').length, [games])

  // The sources arrive after the modal focused its first child; move focus onto the first Scan button
  // unless the user already moved somewhere else.
  const focusedOnce = useRef(false)
  useEffect(() => {
    if (!sources || focusedOnce.current) return
    focusedOnce.current = true
    const current = getCurrentFocusKey()
    if (current && current !== MODAL_FOCUS_KEY && current !== `${MODAL_FOCUS_KEY}:cancel`) return
    const first = stores.find((s) => s.client.installed)
    void setFocus(first ? `${MODAL_FOCUS_KEY}:scan:${first.id}` : `${MODAL_FOCUS_KEY}:rom:choose`)
  }, [sources, stores])

  const scan = useCallback(
    async (ids?: SourceId[]): Promise<ScanResult | null> => {
      if (scanning.size > 0) return null
      const targets: SourceId[] = ids ?? (sources ?? []).filter((s) => s.enabled).map((s) => s.id)
      setScanning(new Set(targets))
      setScanAll(ids === undefined)
      setScanErrors((prev) => {
        const next = { ...prev }
        for (const id of targets) delete next[id]
        return next
      })
      try {
        const result = await api.scanSources(ids)
        setSources(result.sources)
        // A scan re-imports the owned list of a signed-in store, but no scan reaches a store whose client is not
        // installed: those signed-in accounts are imported here instead (what Import library used to do).
        const { accounts: current, importOwned } = useAccountsStore.getState()
        for (const source of result.sources) {
          if (!targets.includes(source.id) || source.client.installed || !isStore(source.id))
            continue
          const account = current.find((a) => a.source === source.id)
          if (account?.supported && account.signedIn && !account.importing)
            void importOwned(source.id)
        }
        const counts = { added: result.added, updated: result.updated, removed: result.removed }
        toast(
          result.removed > 0
            ? t('addGames.scanFinishedRemoved', counts)
            : t('addGames.scanFinished', counts),
          result.added > 0 ? 'success' : 'info'
        )
        return result
      } catch (err) {
        log.error('scanSources failed', err)
        const message = errorText(err)
        setScanErrors((prev) => {
          const next = { ...prev }
          for (const id of targets) next[id] = message
          return next
        })
        toast(t('addGames.scanFailed', { error: message }), 'error')
        return null
      } finally {
        setScanning(new Set())
        setScanAll(false)
        setProgress((prev) => {
          const next = { ...prev }
          for (const id of targets) delete next[id]
          return next
        })
      }
    },
    [scanning, sources, toast, t]
  )

  const install = useCallback(
    (id: SourceId, name: string) => {
      const url = STORE_DOWNLOAD_URLS[id]
      if (!url) return
      api.openExternal(url).catch((err) => {
        log.error('openExternal failed', err)
        toast(t('addGames.downloadPageFailed', { name }), 'error')
      })
    },
    [toast, t]
  )

  // Store accounts are signed in and out on their cards. The button that was pressed is replaced (Sign in by Sign
  // out, and back), so focus follows to the one that replaces it and the D-pad never lands on nothing.
  const focusAccount = useCallback((source: StoreSourceId): void => {
    // The account may have no button left (Steam signed out of the web, still signed in by its Settings API key):
    // the card's own Scan or Get button then.
    const keys = [
      accountFocusKey(source, 'signout'),
      accountFocusKey(source, 'signin'),
      `${MODAL_FOCUS_KEY}:scan:${source}`,
      `${MODAL_FOCUS_KEY}:install:${source}`
    ]
    const key = keys.find((k) => doesFocusableExist(k))
    if (key) void setFocus(key)
  }, [])
  const onSignIn = useCallback(
    (source: StoreSourceId) => void signIn(source).then(() => focusAccount(source)),
    [signIn, focusAccount]
  )
  const onSignOut = useCallback(
    (source: StoreSourceId) => void signOut(source).then(() => focusAccount(source)),
    [signOut, focusAccount]
  )
  // A store with no sign-in (Ubisoft) has no account line: its card is about the installed games only.
  const accountOf = (id: SourceId): AccountStatus | undefined =>
    isStore(id) ? accounts.find((a) => a.source === id && a.supported) : undefined

  const busy = scanning.size > 0

  return (
    <Modal
      size="panel"
      scrim
      focusKey={MODAL_FOCUS_KEY}
      preferredChildFocusKey={`${MODAL_FOCUS_KEY}:rom:choose`}
      title={t('addGames.title')}
      subtitle={t('addGames.subtitle')}
      onClose={onClose}
      className="addgames"
      bodyClassName="addgames__body"
      footer={
        <>
          <Button focusKey={`${MODAL_FOCUS_KEY}:cancel`} onPress={onClose}>
            {t('addGames.close')}
          </Button>
          <Button
            focusKey={`${MODAL_FOCUS_KEY}:scanall`}
            variant="primary"
            icon={scanAll ? <Spinner size="sm" /> : <RefreshCw />}
            onPress={() => void scan()}
            aria-label={t('addGames.scanAllLabel')}
          >
            {scanAll ? t('addGames.scanning') : t('addGames.scanAll')}
          </Button>
        </>
      }
    >
      <section className="addgames__section" aria-label={t('addGames.stores')}>
        <h2 className="addgames__heading">{t('addGames.stores')}</h2>
        {sources === null ? (
          sourcesError ? (
            <p className="addgames__status addgames__status--error">
              {t('addGames.storeListFailed', { error: sourcesError })}
            </p>
          ) : (
            <Spinner label={t('addGames.detectingStores')} className="addgames__status" />
          )
        ) : (
          <div className="addgames__grid">
            {stores.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                platform={platforms.find((p) => p.id === source.id)}
                progress={progress[source.id]}
                scanning={scanning.has(source.id)}
                error={scanErrors[source.id]}
                onScan={() => void scan([source.id])}
                onInstall={() => install(source.id, source.name)}
                account={accountOf(source.id)}
                signingIn={pendingSignIn === source.id}
                onSignIn={
                  isStore(source.id) ? () => onSignIn(source.id as StoreSourceId) : undefined
                }
                onSignOut={
                  isStore(source.id) ? () => onSignOut(source.id as StoreSourceId) : undefined
                }
              />
            ))}
          </div>
        )}
      </section>
      <section className="addgames__section" aria-label={t('addGames.romsAndPc')}>
        <h2 className="addgames__heading">{t('addGames.romsAndPc')}</h2>
        <div className="addgames__grid addgames__grid--wide">
          <RomFolderStep
            romsRoot={romsRoot}
            source={romSource}
            progress={progress.rom}
            scanning={scanning.has('rom')}
            romGameCount={romGameCount}
            onScan={() => scan(['rom'])}
          />
          <PcGamesCard busy={busy} manualGameCount={manualGameCount} />
        </div>
      </section>
      <ButtonHints
        hints={[
          { button: 'a', label: t('addGames.hints.select') },
          { button: 'b', label: t('addGames.hints.close') }
        ]}
      />
    </Modal>
  )
}

type PcWork = 'exe' | 'folder' | null

interface PcResult {
  titles: string[]
  folder?: string
}

/** "PC games" card: add one executable, or scan a folder for executables that look like games. */
function PcGamesCard({
  busy,
  manualGameCount
}: {
  busy: boolean
  manualGameCount: number
}): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [working, setWorking] = useState<PcWork>(null)
  const [result, setResult] = useState<PcResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const addExe = useCallback(async (): Promise<void> => {
    if (working || busy) return
    setWorking('exe')
    setError(null)
    try {
      const file = await api.chooseFile({
        title: t('addGames.pc.chooseExe'),
        filters: [{ name: t('addGames.pc.programs'), extensions: ['exe'] }]
      })
      if (!file) return
      const game = await api.addManualGame({ exePath: file })
      setResult({ titles: [displayTitle(game)] })
      toast(t('addGames.pc.added', { title: displayTitle(game) }), 'success')
    } catch (err) {
      log.error('addManualGame failed', err)
      setError(errorText(err))
      toast(t('addGames.pc.addFailed'), 'error')
    } finally {
      setWorking(null)
    }
  }, [working, busy, toast, t])

  const scanFolder = useCallback(async (): Promise<void> => {
    if (working || busy) return
    setWorking('folder')
    setError(null)
    try {
      const folder = await api.chooseFolder(t('addGames.pc.chooseFolder'))
      if (!folder) return
      const added = await api.addGamesFromFolder(folder)
      setResult({ titles: added.map(displayTitle), folder })
      toast(
        added.length > 0
          ? t('addGames.pc.addedFrom', { count: added.length, folder })
          : t('addGames.pc.noneIn', { folder }),
        added.length > 0 ? 'success' : 'info'
      )
    } catch (err) {
      log.error('addGamesFromFolder failed', err)
      setError(errorText(err))
      toast(t('addGames.pc.scanFailed'), 'error')
    } finally {
      setWorking(null)
    }
  }, [working, busy, toast, t])

  return (
    <article
      className="srccard srccard--wide"
      aria-label={t('addGames.pc.label')}
      aria-busy={working !== null || undefined}
    >
      <header className="srccard__head">
        <span className="srccard__icon" aria-hidden="true">
          <Monitor />
        </span>
        <div className="srccard__titles">
          <span className="srccard__name">{t('addGames.pc.label')}</span>
          <span className="srccard__status">{t('addGames.pc.status')}</span>
        </div>
        {manualGameCount > 0 ? (
          <Chip accent>{t('addGames.games', { count: manualGameCount })}</Chip>
        ) : null}
      </header>
      <div className="srccard__info">
        <span>{t('addGames.pc.info')}</span>
        {result ? (
          <span>
            {result.titles.length > 0
              ? t('addGames.pc.resultAdded', { titles: summarizeTitles(result.titles, t) })
              : result.folder
                ? t('addGames.pc.resultNoneIn', { folder: result.folder })
                : t('addGames.pc.resultNone')}
          </span>
        ) : null}
      </div>
      <footer className="srccard__foot">
        <Button
          focusKey="addgames:pc:exe"
          icon={working === 'exe' ? <Spinner size="sm" /> : <FilePlus />}
          onPress={() => void addExe()}
        >
          {t('addGames.pc.addExe')}
        </Button>
        <Button
          focusKey="addgames:pc:folder"
          icon={working === 'folder' ? <Spinner size="sm" /> : <FolderSearch />}
          onPress={() => void scanFolder()}
        >
          {t('addGames.pc.scanFolder')}
        </Button>
      </footer>
      {error ? <p className="srccard__error">{error}</p> : null}
    </article>
  )
}

/** The first four titles, then how many more (worded when shown, in the current language). */
function summarizeTitles(titles: string[], t: Translate): string {
  const shown = titles.slice(0, 4)
  const rest = titles.length - shown.length
  return rest > 0
    ? t('addGames.pc.titlesAndMore', { titles: shown.join(', '), count: rest })
    : shown.join(', ')
}

function isStore(id: SourceId): id is StoreSourceId {
  return (STORE_SOURCES as readonly string[]).includes(id)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
