import type { ControllerWakeStatus } from '@shared/controller-wake'
import type { MemoryStatus } from '@shared/memory'
import type { PerformanceStatus } from '@shared/overlay'
import type { WindowsSettingsPage } from '@shared/types'
import {
  Bluetooth,
  BrushCleaning,
  Download,
  Gamepad2,
  Gauge,
  Languages,
  ListMusic,
  LogOut,
  MemoryStick,
  Minimize2,
  Monitor,
  Moon,
  Music,
  Power,
  ShieldCheck,
  Trash2,
  Volume2,
  Target,
  TrendingDown,
  TrendingUp,
  Wifi,
  Zap
} from 'lucide-react'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { languages, useLanguage, useT, type Translate } from '../../../i18n'
import { flushLibraryTabs } from '../../../state/libraryTabs'
import { Button } from '../../../components/Button'
import { SelectField } from '../../../components/SelectField'
import { Slider } from '../../../components/Slider'
import { Spinner } from '../../../components/Spinner'
import { Toggle } from '../../../components/Toggle'
import {
  defaultProfileOptions,
  GAME_START_OPTIONS,
  targetFpsOptions,
  wattsBoundOptions
} from '../../../overlay/options'
import {
  dynamicAvailable,
  effectiveDefaultProfile,
  wattsBackendText,
  wattsRange
} from '../../../overlay/text'
import { useUiStore } from '../../../state/ui'
import { PathRow } from '../PathRow'
import { fk, log, type SectionProps } from '../common'
import { controllerWakeText, showControllerWakeText } from './controllerWakeText'
import { memoryResultLine, memoryTierHint } from './memoryText'

const SECTION = 'system'

/** The Windows Settings shortcuts, labelled in the current language (built per render, never kept). */
function windowsPages(
  t: Translate
): { page: WindowsSettingsPage; label: string; icon: ReactElement }[] {
  return [
    { page: 'bluetooth', label: t('settingsSystem.windows.pages.bluetooth'), icon: <Bluetooth /> },
    { page: 'wifi', label: t('settingsSystem.windows.pages.wifi'), icon: <Wifi /> },
    { page: 'sound', label: t('settingsSystem.windows.pages.sound'), icon: <Volume2 /> },
    { page: 'display', label: t('settingsSystem.windows.pages.display'), icon: <Monitor /> },
    { page: 'power', label: t('settingsSystem.windows.pages.power'), icon: <Zap /> },
    { page: 'gamepad', label: t('settingsSystem.windows.pages.controllers'), icon: <Gamepad2 /> }
  ]
}

/**
 * PlayOut's language (src/shared/i18n): every language PlayOut has, by its own name, the machine-made ones marked.
 * The choice applies at once, here and in main.
 */
function LanguageGroup({ patch }: SectionProps): ReactElement {
  const t = useT()
  // The language shown, not the saved code: one PlayOut does not have (or none yet) shows as what is used instead.
  const value = useLanguage()
  const options = languages().map((lang) => ({
    value: lang.code,
    label: lang.machineTranslated
      ? t('settingsSystem.language.machineTranslated', { language: lang.nativeName })
      : lang.nativeName
  }))
  return (
    <div className="section">
      <div className="section__title">{t('settingsSystem.language.title')}</div>
      <SelectField
        focusKey={fk(SECTION, 'language')}
        icon={<Languages />}
        label={t('settingsSystem.language.label')}
        description={t('settingsSystem.language.description')}
        value={value}
        options={options}
        onChange={(v) => patch({ system: { language: v } })}
      />
    </div>
  )
}

/** The power profiles' status (the watts backend), loaded once and kept current by 'performance:status'. */
function usePerformanceStatus(): [PerformanceStatus | null, (s: PerformanceStatus) => void] {
  const [status, setStatus] = useState<PerformanceStatus | null>(null)
  useEffect(() => {
    let live = true
    api
      .getPerformanceStatus()
      .then((s) => {
        if (live) setStatus(s)
      })
      .catch((err) => log.error('getPerformanceStatus failed', err))
    const off = api.on('performance:status', setStatus)
    return () => {
      live = false
      off()
    }
  }, [])
  return [status, setStatus]
}

/** Power profiles (docs/home-overlay.md): outside games, per game, watts and the power helper. */
function PowerProfilesGroup({ settings, patch }: SectionProps): ReactElement {
  const { performance } = settings
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [status, setStatus] = usePerformanceStatus()
  const [busy, setBusy] = useState(false)
  const watts = status?.watts
  const helperState = status?.helper
  const dynamic = dynamicAvailable(helperState)
  const range = wattsRange(watts)
  const bound = (v: string): number | null => (v === 'none' ? null : Number(v))

  const helper = (install: boolean): void => {
    if (busy) return
    setBusy(true)
    ;(install ? api.installPowerHelper() : api.removePowerHelper())
      .then(setStatus)
      .catch((err) => {
        log.error(`${install ? 'install' : 'remove'}PowerHelper failed`, err)
        toast(
          install
            ? t('settingsSystem.power.helper.installFailed')
            : t('settingsSystem.power.helper.removeFailed'),
          'error'
        )
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="section">
      <div className="section__title">{t('settingsSystem.power.title')}</div>
      <p className="settings-note">
        {dynamic ? t('settingsSystem.power.noteDynamic') : t('settingsSystem.power.noteStatic')}
      </p>
      <SelectField
        focusKey={fk(SECTION, 'defaultProfile')}
        icon={<Gauge />}
        label={t('settingsSystem.power.defaultProfile.label')}
        description={t('settingsSystem.power.defaultProfile.description')}
        value={effectiveDefaultProfile(performance.defaultProfile, helperState)}
        options={defaultProfileOptions(helperState)}
        onChange={(v) => patch({ performance: { defaultProfile: v } })}
      />
      {dynamic ? (
        <>
          <SelectField
            focusKey={fk(SECTION, 'targetFps')}
            icon={<Target />}
            label={t('settingsSystem.power.targetFps.label')}
            description={t('settingsSystem.power.targetFps.description')}
            value={String(performance.dynamic.targetFps)}
            options={targetFpsOptions(performance.dynamic.targetFps)}
            onChange={(v) =>
              patch({ performance: { dynamic: { ...performance.dynamic, targetFps: Number(v) } } })
            }
          />
          <SelectField
            focusKey={fk(SECTION, 'dynamicMin')}
            icon={<TrendingDown />}
            label={t('settingsSystem.power.dynamicMin.label')}
            description={t('settingsSystem.power.dynamicMin.description')}
            value={
              performance.dynamic.minWatts === null ? 'none' : String(performance.dynamic.minWatts)
            }
            options={wattsBoundOptions(range, performance.dynamic.minWatts)}
            onChange={(v) =>
              patch({ performance: { dynamic: { ...performance.dynamic, minWatts: bound(v) } } })
            }
          />
          <SelectField
            focusKey={fk(SECTION, 'dynamicMax')}
            icon={<TrendingUp />}
            label={t('settingsSystem.power.dynamicMax.label')}
            description={t('settingsSystem.power.dynamicMax.description')}
            value={
              performance.dynamic.maxWatts === null ? 'none' : String(performance.dynamic.maxWatts)
            }
            options={wattsBoundOptions(range, performance.dynamic.maxWatts)}
            onChange={(v) =>
              patch({ performance: { dynamic: { ...performance.dynamic, maxWatts: bound(v) } } })
            }
          />
        </>
      ) : null}
      <Toggle
        focusKey={fk(SECTION, 'perGame')}
        icon={<Gamepad2 />}
        label={t('settingsSystem.power.perGame.label')}
        description={t('settingsSystem.power.perGame.description')}
        checked={performance.perGame}
        onChange={(v) => patch({ performance: { perGame: v } })}
      />
      <Toggle
        focusKey={fk(SECTION, 'useWatts')}
        icon={<Zap />}
        label={t('settingsSystem.power.useWatts.label')}
        description={t('settingsSystem.power.useWatts.description')}
        checked={performance.useWatts}
        onChange={(v) => patch({ performance: { useWatts: v } })}
      />
      <div className="settings-row">
        <span className="control__icon">
          <Zap />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">{t('settingsSystem.power.helper.label')}</span>
          <span className="settings-row__desc" role="status">
            {wattsBackendText(watts)}
          </span>
        </div>
        <div className="settings-row__actions">
          {watts?.state === 'not-installed' ||
          (helperState === 'outdated' && watts?.state === 'ready') ? (
            <Button
              focusKey={fk(SECTION, 'helperInstall')}
              icon={busy ? <Spinner size="sm" /> : <Download />}
              aria-disabled={busy}
              onPress={() => helper(true)}
            >
              {helperState === 'outdated'
                ? t('settingsSystem.power.helper.update')
                : t('settingsSystem.power.helper.install')}
            </Button>
          ) : null}
          {watts?.state === 'ready' || watts?.state === 'error' ? (
            <Button
              focusKey={fk(SECTION, 'helperRemove')}
              icon={busy ? <Spinner size="sm" /> : <Trash2 />}
              aria-disabled={busy}
              onPress={() => helper(false)}
            >
              {t('settingsSystem.power.helper.remove')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Wake with the Xbox button (main/controller-wake): the switch, and under it what Windows reports (read when the page
 * opens, and again after the administrator step).
 */
function ControllerWakeToggle({ settings, patch }: SectionProps): ReactElement {
  const on = settings.system.controllerWake
  const t = useT()
  const [status, setStatus] = useState<ControllerWakeStatus | null>(null)
  useEffect(() => {
    let live = true
    api
      .getControllerWakeStatus()
      .then((s) => {
        if (live) setStatus(s)
      })
      .catch((err) => log.error('getControllerWakeStatus failed', err))
    const off = api.on('controller-wake:status', setStatus)
    return () => {
      live = false
      off()
    }
  }, [on])
  return (
    <>
      <Toggle
        focusKey={fk(SECTION, 'controllerWake')}
        icon={<Gamepad2 />}
        label={t('settingsSystem.startup.controllerWake.label')}
        description={t('settingsSystem.startup.controllerWake.description')}
        checked={on}
        onChange={(v) => patch({ system: { controllerWake: v } })}
      />
      {status && showControllerWakeText({ ...status, enabled: on }) ? (
        <p className="settings-note" role="status">
          {controllerWakeText({ ...status, enabled: on })}
        </p>
      ) : null}
    </>
  )
}

/** The memory cleanup's status, loaded once and kept current by 'memory:status'. */
function useMemoryStatus(): [MemoryStatus | null, (s: MemoryStatus) => void] {
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  useEffect(() => {
    let live = true
    api
      .getMemoryStatus()
      .then((s) => {
        if (live) setStatus(s)
      })
      .catch((err) => log.error('getMemoryStatus failed', err))
    const off = api.on('memory:status', setStatus)
    return () => {
      live = false
      off()
    }
  }, [])
  return [status, setStatus]
}

/** Free up memory while PlayOut is running (docs/USER-GUIDE.md): the switch, the button and the last result. */
function MemoryGroup({ settings, patch }: SectionProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [status, setStatus] = useMemoryStatus()
  const [busy, setBusy] = useState(false)
  // "2 minutes ago" moves on while the page stays open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const running = busy || status?.running === true
  const hint = memoryTierHint(status?.systemWide)

  const freeNow = (): void => {
    if (running) return
    setBusy(true)
    api
      .freeMemoryNow()
      .then((s) => {
        setNow(Date.now())
        setStatus(s)
      })
      .catch((err) => {
        log.error('freeMemoryNow failed', err)
        toast(t('settingsSystem.memory.failed'), 'error')
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="section">
      <div className="section__title">{t('settingsSystem.memory.title')}</div>
      <Toggle
        focusKey={fk(SECTION, 'memory')}
        icon={<MemoryStick />}
        label={t('settingsSystem.memory.label')}
        description={t('settingsSystem.memory.description')}
        checked={settings.performance.memory?.enabled === true}
        onChange={(v) => patch({ performance: { memory: { enabled: v } } })}
      />
      <div className="settings-row">
        <span className="control__icon">
          <BrushCleaning />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">{t('settingsSystem.memory.manual')}</span>
          <span className="settings-row__desc" role="status">
            {memoryResultLine(status && running ? { ...status, running: true } : status, now)}
          </span>
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={fk(SECTION, 'memoryNow')}
            icon={running ? <Spinner size="sm" /> : <BrushCleaning />}
            aria-disabled={running}
            onPress={freeNow}
          >
            {t('settingsSystem.memory.freeNow')}
          </Button>
        </div>
      </div>
      {hint ? <p className="settings-note">{hint}</p> : null}
    </div>
  )
}

/** The overlay's music player: the folder, what happens when a game starts, the volume. */
function MusicGroup({ settings, patch }: SectionProps): ReactElement {
  const { music } = settings
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const choose = useCallback(() => {
    api
      .chooseMusicFolder()
      .then((folder) => {
        if (folder) patch({ music: { folder } })
      })
      .catch((err) => {
        log.error('chooseMusicFolder failed', err)
        toast(t('settingsSystem.music.folder.chooseFailed'), 'error')
      })
  }, [patch, t, toast])

  return (
    <div className="section">
      <div className="section__title">{t('settingsSystem.music.title')}</div>
      <PathRow
        focusKey={fk(SECTION, 'musicFolder')}
        icon={<Music />}
        label={t('settingsSystem.music.folder.label')}
        description={t('settingsSystem.music.folder.description')}
        value={music.folder}
        placeholder={t('settingsSystem.music.folder.notSet')}
        onChoose={choose}
        onClear={music.folder ? () => patch({ music: { folder: null } }) : undefined}
      />
      <SelectField
        focusKey={fk(SECTION, 'musicGameStart')}
        icon={<ListMusic />}
        label={t('settingsSystem.music.gameStart.label')}
        description={t('settingsSystem.music.gameStart.description')}
        value={music.gameStart}
        options={GAME_START_OPTIONS}
        onChange={(v) => patch({ music: { gameStart: v } })}
      />
      <p className="settings-note">{t('settingsSystem.music.note')}</p>
      <Slider
        focusKey={fk(SECTION, 'musicVolume')}
        icon={<Volume2 />}
        label={t('settingsSystem.music.volume')}
        value={Math.round(music.volume * 100)}
        step={5}
        onChange={(v) => patch({ music: { volume: v / 100 } })}
      />
    </div>
  )
}

/** Language, startup, power confirmation, power profiles, music, Windows settings shortcuts and Exit. */
export function SystemSection({ settings, patch }: SectionProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const { system } = settings

  const openWindows = useCallback(
    (page: WindowsSettingsPage) => {
      api.openWindowsSettings(page).catch((err) => {
        log.error(`openWindowsSettings(${page}) failed`, err)
        toast(t('settingsSystem.windows.failed'), 'error')
      })
    },
    [t, toast]
  )

  const exit = useCallback(() => {
    const run = (): void => {
      flushLibraryTabs()
      api.powerAction('exit').catch((err) => {
        log.error('powerAction(exit) failed', err)
        toast(t('settingsSystem.exit.failed'), 'error')
      })
    }
    if (system.confirmPowerActions) {
      openModal({
        type: 'confirm',
        title: t('settingsSystem.exit.confirmTitle'),
        message: system.minimizeToTray
          ? t('settingsSystem.exit.confirmToTray')
          : t('settingsSystem.exit.confirmToDesktop'),
        confirmLabel: t('settingsSystem.exit.confirmButton'),
        onConfirm: run
      })
    } else {
      run()
    }
  }, [openModal, system.confirmPowerActions, system.minimizeToTray, t, toast])

  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsSystem.title')}</h2>
          <p className="settings-section__lead">{t('settingsSystem.lead')}</p>
        </div>
        <Button focusKey={fk(SECTION, 'exit')} variant="danger" icon={<LogOut />} onPress={exit}>
          {t('settingsSystem.exit.button')}
        </Button>
      </div>

      <LanguageGroup settings={settings} patch={patch} />

      <div className="section">
        <div className="section__title">{t('settingsSystem.startup.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'login')}
          icon={<Power />}
          label={t('settingsSystem.startup.launchAtLogin.label')}
          description={t('settingsSystem.startup.launchAtLogin.description')}
          checked={system.launchAtLogin}
          onChange={(v) => patch({ system: { launchAtLogin: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'tray')}
          icon={<Minimize2 />}
          label={t('settingsSystem.startup.minimizeToTray.label')}
          description={t('settingsSystem.startup.minimizeToTray.description')}
          checked={system.minimizeToTray}
          onChange={(v) => patch({ system: { minimizeToTray: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'confirmPower')}
          icon={<ShieldCheck />}
          label={t('settingsSystem.startup.confirmPowerActions.label')}
          description={t('settingsSystem.startup.confirmPowerActions.description')}
          checked={system.confirmPowerActions}
          onChange={(v) => patch({ system: { confirmPowerActions: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'sleepWake')}
          icon={<Moon />}
          label={t('settingsSystem.startup.enhancedSleepWake.label')}
          description={t('settingsSystem.startup.enhancedSleepWake.description')}
          checked={system.enhancedSleepWake}
          onChange={(v) => patch({ system: { enhancedSleepWake: v } })}
        />
        <ControllerWakeToggle settings={settings} patch={patch} />
      </div>

      <PowerProfilesGroup settings={settings} patch={patch} />
      <MemoryGroup settings={settings} patch={patch} />
      <MusicGroup settings={settings} patch={patch} />

      <div className="section">
        <div className="section__title">{t('settingsSystem.windows.title')}</div>
        <p className="settings-note">{t('settingsSystem.windows.note')}</p>
        <div className="shortcuts">
          {windowsPages(t).map((entry) => (
            <Button
              key={entry.page}
              focusKey={fk(SECTION, `win:${entry.page}`)}
              icon={entry.icon}
              onPress={() => openWindows(entry.page)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </div>
    </>
  )
}
