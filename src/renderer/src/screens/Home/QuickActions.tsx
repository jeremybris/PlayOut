import { Power, Settings as SettingsIcon } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { FocusContext, useFocusable } from '../../input/focus'
import { useUiStore } from '../../state/ui'
import { QUICK_KEY } from './rows'

/**
 * The two glass pills above the row area (design 2.7), shown with an empty library only: [Settings] opens
 * the settings modal, [Exit] the quick panel whose top section is the power menu. They are focus row 1
 * and remember the last focused pill.
 */
export function QuickActions(): ReactElement {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal)
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: QUICK_KEY,
    trackChildren: true,
    saveLastFocusedChild: true
  })
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="quick-bar" role="toolbar" aria-label={t('home.quickActions.label')}>
        <QuickPill
          icon={<SettingsIcon />}
          label={t('home.quickActions.settings')}
          focusKey={`${QUICK_KEY}:settings`}
          onPress={() => openModal({ type: 'settings' })}
        />
        <QuickPill
          icon={<Power />}
          label={t('home.quickActions.exit')}
          focusKey={`${QUICK_KEY}:exit`}
          onPress={() => openModal({ type: 'quickpanel' })}
        />
      </div>
    </FocusContext.Provider>
  )
}

function QuickPill({
  icon,
  label,
  focusKey,
  onPress
}: {
  icon: ReactNode
  label: string
  focusKey: string
  onPress: () => void
}): ReactElement {
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey,
    onPress,
    scroll: false
  })
  return (
    <button ref={ref} type="button" className="quick-bar__pill glass" {...controlProps}>
      {icon}
      <span>{label}</span>
    </button>
  )
}
