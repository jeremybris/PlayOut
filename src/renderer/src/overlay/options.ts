/** Option lists shared by the overlay's Settings tab and PlayOut's Settings › System. */
import { DYNAMIC_FPS_PRESETS, type PowerHelperState } from '@shared/overlay'
import type { Settings } from '@shared/types'
import type { SelectOption } from '../components/SelectField'
import { t } from '../i18n'
import {
  formatFps,
  PROFILE_CHOICES,
  profileChoices,
  profileLabel,
  type ProfileChoice
} from './text'

/**
 * An option whose label is read in the current language each time it is shown. The lists below are module
 * constants other screens import, so a label kept as plain text would stay in the language of the moment the module
 * loaded.
 */
function liveOption<T extends string>(value: T, label: () => string): SelectOption<T> {
  return {
    value,
    get label() {
      return label()
    }
  }
}

const profileOption = (choice: ProfileChoice): SelectOption<ProfileChoice> =>
  liveOption(choice, () =>
    choice === 'none'
      ? t('overlay.options.profileOff')
      : choice === 'dynamic'
        ? t('overlay.options.dynamic')
        : choice === 'custom'
          ? t('overlay.options.customWatts')
          : profileLabel(choice)
  )

/** 'Outside games' without a ready power helper (the profiles). */
export const DEFAULT_PROFILE_OPTIONS: SelectOption<ProfileChoice>[] =
  PROFILE_CHOICES.map(profileOption)

/**
 * 'Outside games' for this PC: with a ready power helper Dynamic TDP, Custom watts and Off (a fallback profile saved
 * before the helper shows, and runs, as Dynamic TDP: effectiveDefaultProfile); without it the profiles.
 */
export function defaultProfileOptions(
  helper: PowerHelperState | undefined
): SelectOption<ProfileChoice>[] {
  return profileChoices(helper).map(profileOption)
}

/** Dynamic TDP's target frame rate (values are the fps as text): the presets, and the current value. */
export function targetFpsOptions(current?: number): SelectOption[] {
  const values = [...DYNAMIC_FPS_PRESETS]
  if (current !== undefined && !values.includes(current)) values.push(current)
  return values.sort((a, b) => a - b).map((v) => ({ value: String(v), label: formatFps(v) }))
}

/**
 * A watts floor or ceiling for Dynamic TDP (values are the watts as text, 'none' = the PC's own): every 5 W inside
 * the PC's range, and the current value.
 */
export function wattsBoundOptions(
  range: { min: number; max: number },
  current: number | null
): SelectOption[] {
  const values: number[] = []
  for (let w = Math.ceil(range.min / 5) * 5; w <= range.max; w += 5) values.push(w)
  if (current !== null && !values.includes(current)) values.push(current)
  return [
    { value: 'none', label: t('overlay.options.noLimit') },
    ...values.sort((a, b) => a - b).map((w) => ({ value: String(w), label: String(w) + ' W' }))
  ]
}

export const GAME_START_OPTIONS: SelectOption<Settings['music']['gameStart']>[] = [
  liveOption('keep', () => t('overlay.options.gameStart.keep')),
  liveOption('play', () => t('overlay.options.gameStart.play')),
  liveOption('load', () => t('overlay.options.gameStart.load'))
]
