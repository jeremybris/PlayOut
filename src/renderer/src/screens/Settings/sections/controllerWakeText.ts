import type { ControllerWakeStatus } from '@shared/controller-wake'
import { t } from '../../../i18n'

/** Whether the line under the switch shows: always while it is on; while it is off, only for a step to report. */
export function showControllerWakeText(s: ControllerWakeStatus): boolean {
  return s.enabled || s.step !== 'idle'
}

/**
 * Settings › System › Wake with the Xbox button: the line under the switch. Each case is one whole sentence in the
 * language files (settingsSystem.controllerWake.*), with the device names as variables.
 */
export function controllerWakeText(s: ControllerWakeStatus): string {
  if (s.step === 'working') return t('settingsSystem.controllerWake.working')
  if (!s.enabled) {
    if (s.step === 'declined') return t('settingsSystem.controllerWake.offDeclined')
    if (s.step === 'failed')
      return s.armed.length
        ? t('settingsSystem.controllerWake.offFailedFor', { devices: s.armed.join(', ') })
        : t('settingsSystem.controllerWake.offFailed')
    return ''
  }
  if (!s.readable) return t('settingsSystem.controllerWake.unreadable')
  if (s.step === 'declined') return t('settingsSystem.controllerWake.declined')
  const refused = s.programmable.filter((name) => !s.armed.includes(name))
  const wakes = s.armed.join(', ')
  if (s.step === 'failed' && refused.length)
    return wakes
      ? t('settingsSystem.controllerWake.refusedBeside', { wakes, refused: refused.join(', ') })
      : t('settingsSystem.controllerWake.refused', { refused: refused.join(', ') })
  if (wakes) return t('settingsSystem.controllerWake.wakes', { devices: wakes })
  if (refused.length)
    return t('settingsSystem.controllerWake.waiting', { devices: refused.join(', ') })
  if (s.capable.length)
    return t('settingsSystem.controllerWake.locked', { devices: s.capable.join(', ') })
  return s.adapter
    ? t('settingsSystem.controllerWake.adapterCannotWake')
    : t('settingsSystem.controllerWake.noDevice')
}
