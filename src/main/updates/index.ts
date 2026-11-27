// App self-update from GitHub releases (ARCHITECTURE.md §4.9). electron-updater reads `latest.yml` from the newest
// release of UPDATE_REPO, downloads the NSIS installer and checks its sha512. Nothing happens on its own: the user
// starts the check, the download and the install from Settings > About.
import type { UpdateState, UpdateStatus } from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import { tMain } from '../i18n'

/** Keep in step with `publish:` in electron-builder.yml (updates/index.test.ts compares them). */
export const UPDATE_REPO = { owner: 'jeremybris', repo: 'PlayOut' } as const
const RELEASES_URL = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`
/**
 * Where the updater reads latest.yml and the installer: the newest published release's files, through GitHub's
 * /releases/latest/download/<file> redirect. electron-updater's own GitHub provider first opens the
 * /releases/latest web page to learn the tag, and that page can fail for hours (HTTP 504 while GitHub's file downloads
 * and API still work), which left PlayOut unable to update. The download redirect only ever serves a published
 * release (never a draft), so a release still being uploaded is not offered.
 */
export const UPDATE_FEED_URL = `${RELEASES_URL}/download`

/** The part of electron-updater's AppUpdater this service uses. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: unknown
  setFeedURL(options: { provider: 'generic'; url: string }): void
  on(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateServiceDeps {
  events: Pick<EventBus, 'emit'>
  log: Logger
  currentVersion: string
  /** Development runs have no installer to replace. */
  packaged: boolean
  /** The portable exe has no installed copy to update: the user downloads the new version. */
  portable: boolean
  /** Lazy: electron-updater's instance is only created once a check needs it. */
  updater: () => UpdaterLike
}

export interface UpdateService {
  status(): UpdateStatus
  check(): Promise<UpdateStatus>
  download(): Promise<UpdateStatus>
  install(): UpdateStatus
}

/**
 * A repository not created yet (404 on the feed) or with no release (an empty feed: ERR_XML_MISSED_ELEMENT): nothing
 * to update to, not a failure. ERR_UPDATER_LATEST_VERSION_NOT_FOUND also wraps outages of /releases/latest, so only
 * its 404 counts: an outage must not read as "no updates".
 */
function hasNoRelease(err: unknown): boolean {
  const { code, statusCode, message } = err as {
    code?: unknown
    statusCode?: unknown
    message?: unknown
  }
  if (statusCode === 404) return true
  if (code === 'ERR_XML_MISSED_ELEMENT' || code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') return true
  return (
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' &&
    typeof message === 'string' &&
    /\b404\b/.test(message)
  )
}

/** electron-updater appends response headers and bodies to its messages: the first line is the useful one. */
function shortMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.split('\n')[0].trim().slice(0, 200)
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const { events, log } = deps
  let status: UpdateStatus = {
    state: 'idle',
    currentVersion: deps.currentVersion,
    manual: deps.portable,
    releaseUrl: RELEASES_URL
  }
  let updater: UpdaterLike | null = null

  function set(state: UpdateState, patch: Partial<UpdateStatus> = {}): UpdateStatus {
    status = {
      state,
      currentVersion: status.currentVersion,
      manual: status.manual,
      releaseUrl: status.releaseUrl,
      version: status.version,
      ...patch
    }
    events.emit('update:status', status)
    return status
  }

  /** Both the rejected promise and the 'error' event report a failure; only the first finds a step in progress. */
  function fail(err: unknown): void {
    const step = status.state
    if (step !== 'checking' && step !== 'downloading') {
      log.warn(`updater error outside a check or download: ${shortMessage(err)}`)
      return
    }
    if (step === 'checking' && hasNoRelease(err)) {
      set('up-to-date', { message: tMain('mainApp.updates.nonePublished') })
      return
    }
    log.warn(`update ${step} failed: ${shortMessage(err)}`)
    const error = shortMessage(err)
    set('error', {
      message:
        step === 'checking'
          ? tMain('mainApp.updates.checkFailed', { error })
          : tMain('mainApp.updates.downloadFailed', { error })
    })
  }

  function getUpdater(): UpdaterLike {
    if (updater) return updater
    const u = deps.updater()
    u.autoDownload = false
    u.autoInstallOnAppQuit = false
    u.logger = log
    u.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL })
    u.on('update-available', (info: { version: string }) => {
      set('available', { version: info.version })
    })
    u.on('update-not-available', () => {
      set('up-to-date', { version: undefined })
    })
    u.on(
      'download-progress',
      (progress: {
        percent: number
        transferred: number
        total: number
        bytesPerSecond: number
      }) => {
        if (status.state !== 'downloading') return
        set('downloading', {
          percent: Math.min(100, Math.max(0, progress.percent)),
          bytesDone: progress.transferred,
          bytesTotal: progress.total,
          bytesPerSecond: progress.bytesPerSecond
        })
      }
    )
    u.on('update-downloaded', (info: { version: string }) => {
      set('downloaded', { version: info.version, percent: 100 })
    })
    // Required: an EventEmitter 'error' without a listener would reach the fatal uncaughtException handler.
    u.on('error', (err: unknown) => fail(err))
    updater = u
    return u
  }

  return {
    status: () => status,

    async check() {
      const busy: UpdateState[] = ['checking', 'downloading', 'downloaded', 'installing']
      if (busy.includes(status.state)) return status
      if (!deps.packaged)
        return set('unsupported', { message: tMain('mainApp.updates.installedOnly') })
      set('checking', { version: undefined })
      try {
        const result = await getUpdater().checkForUpdates()
        // null: electron-updater decided it cannot update this copy, and no event follows.
        if (result === null && status.state === 'checking') set('up-to-date')
      } catch (err) {
        fail(err)
      }
      return status
    },

    async download() {
      if (status.state !== 'available' || status.manual || !updater) return status
      set('downloading', { percent: 0 })
      try {
        await updater.downloadUpdate()
      } catch (err) {
        fail(err)
      }
      return status
    },

    install() {
      if (status.state !== 'downloaded' || !updater) return status
      set('installing')
      // Silent, and restart afterwards: the user already chose this, and PlayOut may be running full screen.
      updater.quitAndInstall(true, true)
      return status
    }
  }
}
