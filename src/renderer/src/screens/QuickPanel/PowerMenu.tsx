import type { PowerAction } from '@shared/types'
import { LogOut, Minimize2, Moon, Power, RotateCcw } from 'lucide-react'
import { useCallback, useMemo, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Menu, MenuItem } from '../../components/MenuItem'
import { useT, type Translate } from '../../i18n'
import { createLog } from '../../lib/log'
import { useSettingsStore } from '../../state/settings'
import { flushLibraryTabs } from '../../state/libraryTabs'
import { useUiStore } from '../../state/ui'

const log = createLog('powermenu')

interface PowerEntry {
  action: PowerAction
  label: string
  icon: ReactElement
  /** Confirmation copy; entries without one are confirmed only while confirmPowerActions is on. */
  message: string
  /** The toast when main could not do it (a whole sentence per action: word order differs between languages). */
  failed: string
  /** Always confirmed: the action affects the whole PC. */
  critical: boolean
  danger?: boolean
}

/** The menu's entries in the language shown (built per language, never kept in a module constant). */
function powerEntries(t: Translate): PowerEntry[] {
  return [
    {
      action: 'exit',
      label: t('quickPanel.powerMenu.exit.label'),
      icon: <LogOut />,
      message: t('quickPanel.powerMenu.exit.message'),
      failed: t('quickPanel.powerMenu.exit.failed'),
      critical: false
    },
    {
      action: 'minimize',
      label: t('quickPanel.powerMenu.minimize.label'),
      icon: <Minimize2 />,
      message: t('quickPanel.powerMenu.minimize.message'),
      failed: t('quickPanel.powerMenu.minimize.failed'),
      critical: false
    },
    {
      action: 'sleep',
      label: t('quickPanel.powerMenu.sleep.label'),
      icon: <Moon />,
      message: t('quickPanel.powerMenu.sleep.message'),
      failed: t('quickPanel.powerMenu.sleep.failed'),
      critical: true
    },
    {
      action: 'restart',
      label: t('quickPanel.powerMenu.restart.label'),
      icon: <RotateCcw />,
      message: t('quickPanel.powerMenu.restart.message'),
      failed: t('quickPanel.powerMenu.restart.failed'),
      critical: true,
      danger: true
    },
    {
      action: 'shutdown',
      label: t('quickPanel.powerMenu.shutdown.label'),
      icon: <Power />,
      message: t('quickPanel.powerMenu.shutdown.message'),
      failed: t('quickPanel.powerMenu.shutdown.failed'),
      critical: true,
      danger: true
    }
  ]
}

export interface PowerMenuProps {
  /** Prefix for the entries' focus keys: '<focusKey>:<action>'. */
  focusKey: string
  /** Called after an action was sent (the quick panel closes itself for Minimize). */
  onAction?: (action: PowerAction) => void
}

/**
 * Exit / Minimize / Sleep / Restart / Shut down. Sleep, Restart and Shut down always ask first; Exit and
 * Minimize ask only while settings.system.confirmPowerActions is on.
 */
export function PowerMenu({ focusKey, onAction }: PowerMenuProps): ReactElement {
  const t = useT()
  const entries = useMemo(() => powerEntries(t), [t])
  const confirmAll = useSettingsStore((s) => s.settings?.system.confirmPowerActions ?? true)
  const openModal = useUiStore((s) => s.openModal)
  const toast = useUiStore((s) => s.toast)

  const run = useCallback(
    (entry: PowerEntry) => {
      // The last filter pick or card of the Library is written before PlayOut exits or the PC sleeps.
      flushLibraryTabs()
      api.powerAction(entry.action).catch((err) => {
        log.error(`powerAction(${entry.action}) failed`, err)
        toast(entry.failed, 'error')
      })
      onAction?.(entry.action)
    },
    [onAction, toast]
  )

  const press = useCallback(
    (entry: PowerEntry) => {
      if (entry.critical || confirmAll) {
        openModal({
          type: 'confirm',
          title: entry.label,
          message: entry.message,
          confirmLabel: entry.label,
          danger: entry.danger,
          onConfirm: () => run(entry)
        })
        return
      }
      run(entry)
    },
    [confirmAll, openModal, run]
  )

  return (
    <Menu aria-label={t('quickPanel.powerMenu.label')}>
      {entries.map((entry) => (
        <MenuItem
          key={entry.action}
          focusKey={`${focusKey}:${entry.action}`}
          icon={entry.icon}
          label={entry.label}
          danger={entry.danger}
          onPress={() => press(entry)}
        />
      ))}
    </Menu>
  )
}
