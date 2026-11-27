import { artSourcesConfigured } from '@shared/art-sources'
import type { CredentialService, ScraperId, Settings } from '@shared/types'
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  ExternalLink,
  Globe,
  HardDrive,
  Image,
  RefreshCw,
  Share2,
  Sparkles,
  Tags
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { IconButton } from '../../../components/IconButton'
import { SelectField } from '../../../components/SelectField'
import { Spinner } from '../../../components/Spinner'
import { Toggle } from '../../../components/Toggle'
import { useT, type Translate } from '../../../i18n'
import { setFocus, type Direction } from '../../../input/focus'
import {
  CREDENTIAL_SERVICE_NAMES,
  igdbMissingHalf,
  screenScraperNeedsDev
} from '../../../lib/credentials'
import { useUiStore } from '../../../state/ui'
import { fk, log, useDebouncedPatch, type SectionProps } from '../common'
import { SecretField } from '../SecretField'
import { useCredentialTest } from '../useCredentialTest'
import { CloudMetadata } from './CloudMetadata'

const SECTION = 'metadata'

/** The art sources by name: the services' own names, but the Steam store's in the current language. */
function scraperName(id: ScraperId, t: Translate): string {
  switch (id) {
    case 'steamgriddb':
      return 'SteamGridDB'
    case 'igdb':
      return 'IGDB'
    case 'screenscraper':
      return 'ScreenScraper'
    case 'thegamesdb':
      return 'TheGamesDB'
    case 'steam':
      return t('settingsMetadata.steamStore')
    case 'hltb':
      return 'HowLongToBeat'
    case 'gog':
      return 'GOG'
    default:
      return id
  }
}

/** The services with fields on this page; RetroAchievements signs in under Settings > Emulators. */
type CredentialGroup = Exclude<CredentialService, 'retroachievements'>

/** Where each service hands out the credentials its fields ask for (labelled per render, in the current language). */
function credentialLink(group: CredentialGroup, t: Translate): { label: string; url: string } {
  switch (group) {
    case 'steamgriddb':
      return {
        label: t('settingsMetadata.links.getApiKey'),
        url: 'https://www.steamgriddb.com/profile/preferences/api'
      }
    case 'igdb':
      return {
        label: t('settingsMetadata.links.getClientId'),
        url: 'https://dev.twitch.tv/console/apps'
      }
    case 'screenscraper':
      return {
        label: t('settingsMetadata.links.createAccount'),
        url: 'https://www.screenscraper.fr/membreinscription.php'
      }
    case 'thegamesdb':
      return {
        label: t('settingsMetadata.links.getApiKey'),
        url: 'https://api.thegamesdb.net/key.php'
      }
    case 'steam':
      return {
        label: t('settingsMetadata.links.getWebApiKey'),
        url: 'https://steamcommunity.com/dev/apikey'
      }
  }
}

function regions(t: Translate): { value: 'us' | 'eu' | 'jp' | 'wor'; label: string }[] {
  return [
    { value: 'us', label: t('settingsMetadata.regions.us') },
    { value: 'eu', label: t('settingsMetadata.regions.eu') },
    { value: 'jp', label: t('settingsMetadata.regions.jp') },
    { value: 'wor', label: t('settingsMetadata.regions.wor') }
  ]
}

function move<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta
  if (target < 0 || target >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item as T)
  return next
}

const linkKey = (group: CredentialGroup): string => fk(SECTION, `keyLink:${group}`)

/**
 * Arrow handler for a credential field: Up goes to its own section's key link, Down to the next section's. The
 * links are too narrow beside full-width fields for the focus engine to pick them on its own.
 */
function toLinks(up?: CredentialGroup, down?: CredentialGroup) {
  return (direction: Direction): boolean => {
    const group = direction === 'up' ? up : direction === 'down' ? down : undefined
    if (!group) return true
    void setFocus(linkKey(group))
    return false
  }
}

/** A credential section's title, with a link to the page that issues its key. */
function CredentialTitle({
  group,
  onOpen
}: {
  group: CredentialGroup
  onOpen: (url: string) => void
}): ReactElement {
  const t = useT()
  const name = CREDENTIAL_SERVICE_NAMES[group]
  const link = credentialLink(group, t)
  return (
    <div className="credential-title">
      <div className="section__title">{name}</div>
      <Button
        focusKey={linkKey(group)}
        variant="ghost"
        iconRight={<ExternalLink />}
        onPress={() => onOpen(link.url)}
        aria-label={t('settingsMetadata.links.label', { link: link.label, service: name })}
      >
        {link.label}
      </Button>
    </div>
  )
}

/** API credentials per scraper, scraping switches, region, art source order and refresh actions. */
export function MetadataSection({ settings, patch }: SectionProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const debounced = useDebouncedPatch()
  const [refreshing, setRefreshing] = useState<'all' | 'missing' | null>(null)
  const { scrapers } = settings

  // Credentials are edited through one draft so edits to two fields of the same service within the
  // debounce window both survive (each patch must carry the whole service object).
  const draft = useRef(scrapers)
  useEffect(() => {
    draft.current = scrapers
  }, [scrapers])
  const testCredential = useCredentialTest()
  const setCredential = useCallback(
    <G extends CredentialGroup>(group: G, value: Partial<Settings['scrapers'][G]>) => {
      const next = { ...draft.current[group], ...value }
      draft.current = { ...draft.current, [group]: next }
      debounced({ scrapers: { [group]: next } })
      testCredential(group, next)
    },
    [debounced, testCredential]
  )

  const refresh = useCallback(
    (mode: 'all' | 'missing') => {
      setRefreshing(mode)
      const call =
        mode === 'all' ? api.refreshMetadata(undefined, { force: true }) : api.refreshMetadata()
      // Without a sign-in art source a missing cover has nowhere to come from: the toast says what to add.
      const signInNeeded = mode === 'missing' && !artSourcesConfigured({ scrapers: draft.current })
      call
        .then(({ queued }) => {
          if (mode === 'all') toast(t('settingsMetadata.refresh.allStarted'), 'success')
          else if (queued === 0) toast(t('settingsMetadata.refresh.nothingMissing'), 'info')
          else {
            toast(t('settingsMetadata.refresh.missingQueued', { count: queued }), 'success')
            // Games were queued (unfinished metadata can still finish), but a missing cover needs a sign-in source.
            if (signInNeeded) toast(t('settingsMetadata.refresh.needsSignIn'), 'warning')
          }
        })
        .catch((err) => {
          log.error('refreshMetadata failed', err)
          toast(t('settingsMetadata.refresh.failed'), 'error')
        })
        .finally(() => setRefreshing(null))
    },
    [t, toast]
  )

  const openExternal = useCallback(
    (url: string) => {
      api.openExternal(url).catch((err) => {
        log.error('openExternal failed', err)
        toast(t('settingsMetadata.openLinkFailed'), 'error')
      })
    },
    [t, toast]
  )

  const priority = scrapers.artPriority
  const igdbMissing = igdbMissingHalf(scrapers.igdb)
  const ssNeedsDev = screenScraperNeedsDev(scrapers.screenscraper)
  const noArtSource = !artSourcesConfigured({ scrapers })

  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsMetadata.title')}</h2>
          <p className="settings-section__lead">{t('settingsMetadata.lead')}</p>
        </div>
        <div className="settings-section__actions">
          <Button
            focusKey={fk(SECTION, 'refreshMissing')}
            icon={refreshing === 'missing' ? <Spinner size="sm" /> : <Sparkles />}
            disabled={refreshing !== null}
            onPress={() => refresh('missing')}
          >
            {t('settingsMetadata.refresh.missing')}
          </Button>
          <Button
            focusKey={fk(SECTION, 'refreshAll')}
            variant="primary"
            icon={refreshing === 'all' ? <Spinner size="sm" /> : <RefreshCw />}
            disabled={refreshing !== null}
            onPress={() => refresh('all')}
          >
            {t('settingsMetadata.refresh.all')}
          </Button>
        </div>
      </div>

      {noArtSource && (
        <p className="settings-note settings-note--missing" role="status">
          {t('settingsMetadata.artSourceNeeded')}
        </p>
      )}

      <div className="section">
        <div className="section__title">{t('settingsMetadata.scraping.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'autoScrape')}
          icon={<Sparkles />}
          label={t('settingsMetadata.scraping.autoScrape.label')}
          description={t('settingsMetadata.scraping.autoScrape.description')}
          checked={scrapers.autoScrape}
          onChange={(v) => patch({ scrapers: { autoScrape: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'localArt')}
          icon={<HardDrive />}
          label={t('settingsMetadata.scraping.localArt.label')}
          description={t('settingsMetadata.scraping.localArt.description')}
          checked={scrapers.localArt}
          onChange={(v) => patch({ scrapers: { localArt: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'hltb')}
          icon={<Clock />}
          label={t('settingsMetadata.scraping.hltb.label')}
          description={t('settingsMetadata.scraping.hltb.description')}
          checked={scrapers.hltb.enabled}
          onChange={(v) => patch({ scrapers: { hltb: { enabled: v } } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'steamTags')}
          icon={<Tags />}
          label={t('settingsMetadata.scraping.steamTags.label')}
          description={t('settingsMetadata.scraping.steamTags.description')}
          checked={scrapers.steamTags.enabled}
          onChange={(v) => patch({ scrapers: { steamTags: { enabled: v } } })}
        />
        <SelectField
          focusKey={fk(SECTION, 'region')}
          icon={<Globe />}
          label={t('settingsMetadata.scraping.region.label')}
          description={t('settingsMetadata.scraping.region.description')}
          value={scrapers.region}
          options={regions(t)}
          onChange={(v) => patch({ scrapers: { region: v } })}
        />
      </div>

      <div className="section">
        <div className="section__title">{t('settingsMetadata.database.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'gameDatabase')}
          icon={<Database />}
          label={t('settingsMetadata.database.use.label')}
          description={t('settingsMetadata.database.use.description')}
          checked={scrapers.gameDatabase.enabled}
          onChange={(v) =>
            patch({ scrapers: { gameDatabase: { ...scrapers.gameDatabase, enabled: v } } })
          }
        />
        <Toggle
          focusKey={fk(SECTION, 'gameDatabaseContribute')}
          icon={<Share2 />}
          label={t('settingsMetadata.database.contribute.label')}
          description={t('settingsMetadata.database.contribute.description')}
          checked={scrapers.gameDatabase.enabled && scrapers.gameDatabase.contribute}
          disabled={!scrapers.gameDatabase.enabled}
          onChange={(v) =>
            patch({ scrapers: { gameDatabase: { ...scrapers.gameDatabase, contribute: v } } })
          }
        />
      </div>

      <div className="section">
        <div className="section__title">{t('settingsMetadata.artwork.title')}</div>
        <div className="priority">
          {priority.map((id, index) => (
            <div key={id} className="priority__row">
              <span className="priority__index">{index + 1}</span>
              <span className="control__icon">
                <Image />
              </span>
              <span className="priority__name">{scraperName(id, t)}</span>
              <IconButton
                focusKey={fk(SECTION, `art:${id}:up`)}
                icon={<ChevronUp />}
                aria-label={t('settingsMetadata.artwork.moveUp', { source: scraperName(id, t) })}
                size="sm"
                disabled={index === 0}
                onArrowPress={
                  index === priority.length - 1 ? toLinks(undefined, 'steamgriddb') : undefined
                }
                onPress={() => patch({ scrapers: { artPriority: move(priority, index, -1) } })}
              />
              <IconButton
                focusKey={fk(SECTION, `art:${id}:down`)}
                icon={<ChevronDown />}
                aria-label={t('settingsMetadata.artwork.moveDown', { source: scraperName(id, t) })}
                size="sm"
                disabled={index === priority.length - 1}
                onPress={() => patch({ scrapers: { artPriority: move(priority, index, 1) } })}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <CredentialTitle group="steamgriddb" onOpen={openExternal} />
        <p className="settings-note">{t('settingsMetadata.steamgriddb.note')}</p>
        <SecretField
          focusKey={fk(SECTION, 'sgdb')}
          onArrowPress={toLinks('steamgriddb', 'igdb')}
          label={t('settingsMetadata.steamgriddb.apiKey')}
          value={scrapers.steamgriddb.apiKey}
          onChange={(apiKey) => setCredential('steamgriddb', { apiKey })}
        />
      </div>

      <div className="section">
        <CredentialTitle group="igdb" onOpen={openExternal} />
        <p className="settings-note">{t('settingsMetadata.igdb.note')}</p>
        <div className="settings-grid">
          <SecretField
            focusKey={fk(SECTION, 'igdbId')}
            onArrowPress={toLinks('igdb', 'screenscraper')}
            label={t('settingsMetadata.igdb.clientId')}
            plain
            value={scrapers.igdb.clientId}
            onChange={(clientId) => setCredential('igdb', { clientId })}
          />
          <SecretField
            focusKey={fk(SECTION, 'igdbSecret')}
            onArrowPress={toLinks('igdb', 'screenscraper')}
            label={t('settingsMetadata.igdb.clientSecret')}
            value={scrapers.igdb.clientSecret}
            onChange={(clientSecret) => setCredential('igdb', { clientSecret })}
          />
        </div>
        {igdbMissing && (
          <p className="settings-note settings-note--missing" role="status">
            {igdbMissing}
          </p>
        )}
      </div>

      <div className="section">
        <CredentialTitle group="screenscraper" onOpen={openExternal} />
        <p className="settings-note">{t('settingsMetadata.screenscraper.note')}</p>
        <div className="settings-grid">
          <SecretField
            focusKey={fk(SECTION, 'ssUser')}
            onArrowPress={toLinks('screenscraper')}
            label={t('settingsMetadata.screenscraper.username')}
            plain
            value={scrapers.screenscraper.user}
            onChange={(user) => setCredential('screenscraper', { user })}
          />
          <SecretField
            focusKey={fk(SECTION, 'ssPassword')}
            onArrowPress={toLinks('screenscraper')}
            label={t('settingsMetadata.screenscraper.password')}
            value={scrapers.screenscraper.password}
            onChange={(password) => setCredential('screenscraper', { password })}
          />
          <SecretField
            focusKey={fk(SECTION, 'ssDevId')}
            onArrowPress={toLinks(undefined, 'thegamesdb')}
            label={t('settingsMetadata.screenscraper.devId')}
            plain
            value={scrapers.screenscraper.devId}
            onChange={(devId) => setCredential('screenscraper', { devId })}
          />
          <SecretField
            focusKey={fk(SECTION, 'ssDevPassword')}
            onArrowPress={toLinks(undefined, 'thegamesdb')}
            label={t('settingsMetadata.screenscraper.devPassword')}
            value={scrapers.screenscraper.devPassword}
            onChange={(devPassword) => setCredential('screenscraper', { devPassword })}
          />
        </div>
        {ssNeedsDev && (
          <p className="settings-note settings-note--missing" role="status">
            {ssNeedsDev}
          </p>
        )}
      </div>

      <div className="section">
        <CredentialTitle group="thegamesdb" onOpen={openExternal} />
        <p className="settings-note">{t('settingsMetadata.thegamesdb.note')}</p>
        <SecretField
          focusKey={fk(SECTION, 'tgdb')}
          onArrowPress={toLinks('thegamesdb', 'steam')}
          label={t('settingsMetadata.thegamesdb.apiKey')}
          value={scrapers.thegamesdb.apiKey}
          onChange={(apiKey) => setCredential('thegamesdb', { apiKey })}
        />
      </div>

      <div className="section">
        <CredentialTitle group="steam" onOpen={openExternal} />
        <p className="settings-note">{t('settingsMetadata.steam.note')}</p>
        <div className="settings-grid">
          <SecretField
            focusKey={fk(SECTION, 'steamKey')}
            onArrowPress={toLinks('steam')}
            label={t('settingsMetadata.steam.apiKey')}
            value={scrapers.steam.apiKey}
            onChange={(apiKey) => setCredential('steam', { apiKey })}
          />
          <SecretField
            focusKey={fk(SECTION, 'steamId')}
            onArrowPress={toLinks('steam')}
            label="SteamID64"
            plain
            value={scrapers.steam.steamId64}
            onChange={(steamId64) => setCredential('steam', { steamId64 })}
          />
        </div>
      </div>

      <CloudMetadata onOpen={openExternal} />
    </>
  )
}
