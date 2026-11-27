import { PEERPARTY_REPO_URL } from '@shared/peerparty'
import type { AppInfo, UpdateStatus } from '@shared/types'
import { siDiscord, siKofi } from 'simple-icons'
import { Bug, Download, ExternalLink, FolderOpen, Info, RefreshCw, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { useT, type Translate } from '../../../i18n'
import { cx } from '../../../lib/cx'
import { updateView, type UpdateAction } from '../../../lib/updates'
import { useUiStore } from '../../../state/ui'
import { fk, log } from '../common'

const SECTION = 'about'

interface Credit {
  id: string
  name: string
  url: string
  text: string
}

/** The projects and services PlayOut builds on; their text in the current language (built per render, never kept). */
function credits(t: Translate): Credit[] {
  return [
    {
      id: 'esde',
      name: 'ES-DE',
      url: 'https://es-de.org/',
      text: t('settingsAbout.credits.esde')
    },
    {
      id: 'playnite',
      name: 'Playnite',
      url: 'https://playnite.link/',
      text: t('settingsAbout.credits.playnite')
    },
    {
      id: 'xbox-wake',
      name: 'Windows11-Xbox-Controller-Wake',
      url: 'https://github.com/socalit/Windows11-Xbox-Controller-Wake',
      text: t('settingsAbout.credits.xboxWake')
    },
    {
      id: 'nucleus',
      name: 'Nucleus Co-op',
      url: 'https://github.com/jeremybris/PlayOut-CoOp',
      text: t('settingsAbout.credits.nucleus')
    },
    {
      id: 'peerparty',
      name: 'PeerParty',
      url: PEERPARTY_REPO_URL,
      text: t('settingsAbout.credits.peerparty')
    },
    {
      id: 'xisosharp',
      name: 'XISOSharp & CHDSharp',
      url: 'https://github.com/purelogiccode/XISOSharp',
      text: t('settingsAbout.credits.xisosharp')
    },
    {
      id: 'steamgriddb',
      name: 'SteamGridDB',
      url: 'https://www.steamgriddb.com/',
      text: t('settingsAbout.credits.steamgriddb')
    },
    {
      id: 'igdb',
      name: 'IGDB',
      url: 'https://www.igdb.com/',
      text: t('settingsAbout.credits.igdb')
    },
    {
      id: 'screenscraper',
      name: 'ScreenScraper',
      url: 'https://www.screenscraper.fr/',
      text: t('settingsAbout.credits.screenscraper')
    },
    {
      id: 'thegamesdb',
      name: 'TheGamesDB',
      url: 'https://thegamesdb.net/',
      text: t('settingsAbout.credits.thegamesdb')
    },
    {
      id: 'steam',
      name: 'Steam',
      url: 'https://steamcommunity.com/dev',
      text: t('settingsAbout.credits.steam')
    },
    {
      id: 'hltb',
      name: 'HowLongToBeat',
      url: 'https://howlongtobeat.com/',
      text: t('settingsAbout.credits.hltb')
    },
    {
      id: 'simple-icons',
      name: 'Simple Icons & Lucide',
      url: 'https://simpleicons.org/',
      text: t('settingsAbout.credits.simpleIcons')
    }
  ]
}

/** The links at the bottom (built per render: one label is translated). */
function links(t: Translate): { id: string; label: string; url: string }[] {
  return [
    { id: 'esde', label: 'ES-DE', url: 'https://es-de.org/' },
    { id: 'playnite', label: 'Playnite', url: 'https://playnite.link/' },
    { id: 'retroarch', label: 'RetroArch', url: 'https://www.retroarch.com/' },
    { id: 'lucide', label: t('settingsAbout.links.lucide'), url: 'https://lucide.dev/' }
  ]
}

/** PlayOut's author's Ko-fi page (donations) and Discord server. */
export const KOFI_URL = 'https://ko-fi.com/jeremyb'
export const DISCORD_URL = 'https://discord.gg/Cxj8cBTP6'
/** A new issue on PlayOut's GitHub repository: bug reports and feedback. */
export const ISSUES_URL = 'https://github.com/jeremybris/PlayOut/issues/new'

/** A Simple Icons brand mark in the current text colour. */
function BrandMark({ path }: { path: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

const UPDATE_ICONS: Record<NonNullable<UpdateAction>, ReactElement> = {
  check: <RefreshCw />,
  download: <Download />,
  install: <RotateCw />,
  release: <ExternalLink />
}

/** The update check, its one button and the progress bar of the update under way. */
function UpdateRow({ openExternal }: { openExternal: (url: string) => void }): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  // The service outlives this tab: a download under way shows its progress when the user comes back.
  useEffect(() => {
    let cancelled = false
    const off = api.on('update:status', setStatus)
    api
      .getUpdateStatus()
      .then((current) => {
        if (!cancelled) setStatus((seen) => seen ?? current)
      })
      .catch((err) => log.error('getUpdateStatus failed', err))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const view = status ? updateView(status) : null
  const onPress = (): void => {
    if (!status || !view?.action) return
    if (view.action === 'release') {
      openExternal(status.releaseUrl)
      return
    }
    const step =
      view.action === 'check'
        ? api.checkForUpdates()
        : view.action === 'download'
          ? api.downloadUpdate()
          : api.installUpdate()
    step.then(setStatus).catch((err) => {
      log.error(`update ${view.action} failed`, err)
      toast(
        (err as Error).message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''),
        'error'
      )
    })
  }

  const progress = view?.progress ?? null
  const indeterminate = progress === 'indeterminate'
  return (
    <div className="settings-row">
      <span className="control__icon">
        <RefreshCw />
      </span>
      <div className="settings-row__text">
        <span className="settings-row__label">{t('settingsAbout.install.updates')}</span>
        <span className="settings-row__desc" aria-live="polite">
          {view?.text ?? t('settingsAbout.install.loading')}
        </span>
        {progress !== null ? (
          <span
            className={cx('update-progress', indeterminate && 'update-progress--indeterminate')}
            style={indeterminate ? undefined : ({ '--p': progress } as CSSProperties)}
            role="progressbar"
            aria-label={t('settingsAbout.install.progress')}
            aria-valuenow={indeterminate ? undefined : Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        ) : null}
      </div>
      <div className="settings-row__actions">
        <Button
          focusKey={fk(SECTION, 'update')}
          variant={
            view?.action === 'download' || view?.action === 'install' ? 'primary' : 'secondary'
          }
          icon={UPDATE_ICONS[view?.action ?? 'check']}
          aria-disabled={!view?.action}
          onPress={onPress}
        >
          {view?.label ?? t('settingsAbout.install.check')}
        </Button>
      </div>
    </div>
  )
}

/** App name and version, updates, data folder, attributions and links. */
export function AboutSection(): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [infoError, setInfoError] = useState(false)

  useEffect(() => {
    api
      .getAppInfo()
      .then(setInfo)
      .catch((err) => {
        log.error('getAppInfo failed', err)
        setInfoError(true)
      })
  }, [])

  const openExternal = useCallback(
    (url: string) => {
      api.openExternal(url).catch((err) => {
        log.error('openExternal failed', err)
        toast(t('settingsAbout.toasts.linkFailed'), 'error')
      })
    },
    [t, toast]
  )

  const openData = useCallback(() => {
    if (!info) return
    api.openPath(info.userDataPath).catch((err) => {
      log.error('openPath failed', err)
      toast(t('settingsAbout.toasts.dataFolderFailed'), 'error')
    })
  }, [info, t, toast])

  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsAbout.title')}</h2>
          <p className="settings-section__lead">
            {info
              ? info.isPackaged
                ? t('settingsAbout.version', {
                    name: info.name,
                    version: info.version,
                    platform: info.platform
                  })
                : t('settingsAbout.versionDev', {
                    name: info.name,
                    version: info.version,
                    platform: info.platform
                  })
              : infoError
                ? t('settingsAbout.versionUnavailable')
                : t('settingsAbout.versionLoading')}
          </p>
        </div>
      </div>

      <div className="section">
        <div className="section__title">{t('settingsAbout.support.title')}</div>
        <div className="settings-row">
          <span className="control__icon">
            <BrandMark path={siKofi.path} />
          </span>
          <div className="settings-row__text">
            <span className="settings-row__label">{t('settingsAbout.support.kofi')}</span>
            <span className="settings-row__desc">{t('settingsAbout.support.kofiDescription')}</span>
          </div>
          <div className="settings-row__actions">
            <Button
              focusKey={fk(SECTION, 'kofi')}
              variant="primary"
              icon={<BrandMark path={siKofi.path} />}
              onPress={() => openExternal(KOFI_URL)}
            >
              {t('settingsAbout.support.donate')}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <span className="control__icon">
            <BrandMark path={siDiscord.path} />
          </span>
          <div className="settings-row__text">
            <span className="settings-row__label">{t('settingsAbout.support.discord')}</span>
            <span className="settings-row__desc">
              {t('settingsAbout.support.discordDescription')}
            </span>
          </div>
          <div className="settings-row__actions">
            <Button
              focusKey={fk(SECTION, 'discord')}
              icon={<BrandMark path={siDiscord.path} />}
              onPress={() => openExternal(DISCORD_URL)}
            >
              {t('settingsAbout.support.join')}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <span className="control__icon">
            <Bug />
          </span>
          <div className="settings-row__text">
            <span className="settings-row__label">{t('settingsAbout.support.feedback')}</span>
            <span className="settings-row__desc">
              {t('settingsAbout.support.feedbackDescription')}
            </span>
          </div>
          <div className="settings-row__actions">
            <Button
              focusKey={fk(SECTION, 'feedback')}
              icon={<Bug />}
              onPress={() => openExternal(ISSUES_URL)}
            >
              {t('settingsAbout.support.report')}
            </Button>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section__title">{t('settingsAbout.install.title')}</div>
        <UpdateRow openExternal={openExternal} />
        <div className="settings-row">
          <span className="control__icon">
            <Info />
          </span>
          <div className="settings-row__text">
            <span className="settings-row__label">{t('settingsAbout.install.dataFolder')}</span>
            <span className="settings-row__value" title={info?.userDataPath}>
              {info?.userDataPath ?? '—'}
            </span>
            <span className="settings-row__desc">
              {t('settingsAbout.install.dataFolderDescription')}
            </span>
          </div>
          <div className="settings-row__actions">
            <Button
              focusKey={fk(SECTION, 'data')}
              icon={<FolderOpen />}
              disabled={!info}
              onPress={openData}
            >
              {t('settingsAbout.install.openFolder')}
            </Button>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section__title">{t('settingsAbout.credits.title')}</div>
        <p className="settings-note">{t('settingsAbout.credits.note')}</p>
        <div className="credits">
          {credits(t).map((credit) => (
            <div key={credit.id} className="credit">
              <div className="credit__head">
                <span className="credit__name">{credit.name}</span>
                <Button
                  focusKey={fk(SECTION, `credit:${credit.id}`)}
                  variant="ghost"
                  iconRight={<ExternalLink />}
                  onPress={() => openExternal(credit.url)}
                  aria-label={t('settingsAbout.credits.websiteLabel', { name: credit.name })}
                >
                  {t('settingsAbout.credits.website')}
                </Button>
              </div>
              <p className="credit__text">{credit.text}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section__title">{t('settingsAbout.links.title')}</div>
        <div className="shortcuts">
          {links(t).map((link) => (
            <Button
              key={link.id}
              focusKey={fk(SECTION, `link:${link.id}`)}
              iconRight={<ExternalLink />}
              onPress={() => openExternal(link.url)}
            >
              {link.label}
            </Button>
          ))}
        </div>
      </div>
    </>
  )
}
