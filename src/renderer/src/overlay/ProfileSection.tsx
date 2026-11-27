import {
  Activity,
  Download,
  Feather,
  Gauge,
  Leaf,
  Rocket,
  SlidersHorizontal,
  Zap,
  ZapOff
} from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { DYNAMIC_FPS } from '@shared/overlay'
import { Button } from '../components/Button'
import { useT } from '../i18n'
import { setFocus } from '../input/focus'
import { Toggle } from '../components/Toggle'
import { displayTitle } from '../lib/library'
import { useLibraryStore } from '../state/library'
import { useSettingsStore } from '../state/settings'
import { CustomProfileEditor } from './CustomProfileEditor'
import { DynamicTdpControls } from './DynamicTdpControls'
import { useOverlayStore } from './overlayStore'
import { ChoiceCard, OverlayGroup } from './parts'
import { useRunningGameId } from './shared'
import {
  dynamicAvailable,
  profileChoices,
  profileDetail,
  profileLabel,
  shownChoice,
  wattsBackendText,
  wattsReady,
  type ProfileChoice
} from './text'

const PROFILE_ICONS: Record<ProfileChoice, ReactElement> = {
  dynamic: <Activity />,
  silent: <Leaf />,
  balanced: <Feather />,
  performance: <Rocket />,
  custom: <SlidersHorizontal />,
  none: <ZapOff />
}

/**
 * POWER PROFILE: the cards, the per-game switch, the Custom editor and the power helper's install action. With the
 * power helper ready the cards are Dynamic TDP (the default: watts follow a target frame rate), Custom watts and Off
 * (a fallback profile saved before the helper runs, and shows, as Dynamic TDP); without it the fallback profiles
 * Silent, Balanced, Performance, Custom and Off.
 */
export function ProfileSection(): ReactElement {
  const performance = useOverlayStore((s) => s.performance)
  const applyProfile = useOverlayStore((s) => s.applyProfile)
  const installHelper = useOverlayStore((s) => s.installHelper)
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const gameId = useRunningGameId()
  const game = useLibraryStore((s) => (gameId ? s.byId.get(gameId) : undefined))
  const [editing, setEditing] = useState(false)
  const [installing, setInstalling] = useState(false)
  const t = useT()

  const useWatts = settings?.performance.useWatts ?? true
  const ready = wattsReady(performance?.watts, useWatts)
  const dynamic = dynamicAvailable(performance?.helper)
  const active: ProfileChoice = shownChoice(performance?.active ?? 'none', performance?.helper)
  const choices = profileChoices(performance?.helper)
  const forGame = performance?.gameProfile !== undefined
  const profiles = settings?.performance.profiles
  const targetFps =
    performance?.dynamic?.targetFps ??
    settings?.performance.dynamic?.targetFps ??
    DYNAMIC_FPS.default

  const pick = (choice: ProfileChoice): void => {
    // With the per-game switch on, a new pick becomes the game's profile too; Off clears it.
    if (forGame && gameId) void applyProfile(choice, choice === 'none' ? null : gameId)
    else void applyProfile(choice)
  }

  const setForGame = (on: boolean): void => {
    if (!gameId) return
    const fallback: ProfileChoice = dynamic ? 'dynamic' : 'balanced'
    const choice = active === 'none' ? fallback : active
    if (on) void applyProfile(choice, gameId, choice === 'dynamic' ? { targetFps } : undefined)
    else void applyProfile(active, null)
  }

  const setTarget = (fps: number): void => {
    // The game's own target with "Use for <game>", else the default target (Settings › System).
    if (forGame && gameId) void applyProfile('dynamic', gameId, { targetFps: fps })
    else if (settings)
      void update({ performance: { dynamic: { ...settings.performance.dynamic, targetFps: fps } } })
  }

  const install = (): void => {
    if (installing) return
    setInstalling(true)
    void installHelper().finally(() => setInstalling(false))
  }

  const needsUpdate =
    useWatts && performance?.helper === 'outdated' && performance.watts.state === 'ready'

  return (
    <OverlayGroup
      title={t('overlay.profiles.title')}
      aside={
        performance?.error ? (
          <span className="ov-group__warn" role="status">
            {performance.error}
          </span>
        ) : undefined
      }
    >
      <div
        className={choices.length < 5 ? `ov-cards ov-cards--${choices.length}` : 'ov-cards'}
        role="radiogroup"
        aria-label={t('overlay.profiles.title')}
      >
        {choices.map((choice) => (
          <ChoiceCard
            key={choice}
            focusKey={`overlay:profile:${choice}`}
            icon={PROFILE_ICONS[choice]}
            title={
              dynamic && choice === 'custom'
                ? t('overlay.profiles.customWatts')
                : profileLabel(choice)
            }
            detail={profileDetail(
              choice,
              choice === 'none' || choice === 'dynamic' ? undefined : profiles?.[choice],
              ready,
              choice === 'dynamic' ? targetFps : undefined
            )}
            selected={active === choice}
            onPress={() => pick(choice)}
          />
        ))}
      </div>

      {gameId ? (
        <Toggle
          focusKey="overlay:profile:forGame"
          icon={<Gauge />}
          label={
            game
              ? t('overlay.profiles.useFor', { game: displayTitle(game) })
              : t('overlay.profiles.useForThisGame')
          }
          description={
            settings?.performance.perGame === false
              ? t('overlay.profiles.perGameOff')
              : active === 'dynamic'
                ? t('overlay.profiles.dynamicEveryStart')
                : t('overlay.profiles.profileEveryStart')
          }
          checked={forGame}
          onChange={setForGame}
        />
      ) : null}

      {dynamic && active === 'dynamic' ? (
        <DynamicTdpControls
          targetFps={targetFps}
          status={performance?.dynamic}
          onTarget={setTarget}
        />
      ) : null}

      {active === 'custom' || editing ? (
        profiles ? (
          <CustomProfileEditor
            config={profiles.custom}
            profiles={profiles}
            watts={ready ? performance?.watts : undefined}
          />
        ) : null
      ) : (
        <Button
          focusKey="overlay:profile:edit"
          variant="ghost"
          icon={<SlidersHorizontal />}
          onPress={() => {
            setEditing(true)
            // The button goes away with the press: focus moves on to the editor it opened.
            requestAnimationFrame(() => void setFocus('overlay:custom:mode'))
          }}
        >
          {dynamic ? t('overlay.profiles.editCustomWatts') : t('overlay.profiles.editCustom')}
        </Button>
      )}

      {(performance?.watts.state === 'not-installed' && useWatts) || needsUpdate ? (
        <div className="ov-note">
          <Zap className="ov-note__icon" />
          <span className="ov-note__text">
            {needsUpdate
              ? t('overlay.profiles.helperNeedsUpdate')
              : wattsBackendText(performance?.watts)}
          </span>
          <Button
            focusKey="overlay:profile:install"
            icon={<Download />}
            onPress={install}
            aria-disabled={installing}
          >
            {installing
              ? t('overlay.profiles.installing')
              : needsUpdate || performance?.helper === 'outdated'
                ? t('overlay.profiles.updateHelper')
                : t('overlay.profiles.installHelper')}
          </Button>
        </div>
      ) : null}
    </OverlayGroup>
  )
}
