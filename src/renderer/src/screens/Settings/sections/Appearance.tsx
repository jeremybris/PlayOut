import { Clock, History, Maximize2, Minimize2, Sparkles } from 'lucide-react'
import type { ReactElement } from 'react'
import { Slider } from '../../../components/Slider'
import { Toggle } from '../../../components/Toggle'
import { useT } from '../../../i18n'
import { fk, type SectionProps } from '../common'

const SECTION = 'appearance'

/** Window, clock, motion and home-row options. */
export function AppearanceSection({ settings, patch }: SectionProps): ReactElement {
  const { ui } = settings
  const t = useT()
  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsAppearance.title')}</h2>
          <p className="settings-section__lead">{t('settingsAppearance.lead')}</p>
        </div>
      </div>

      <div className="section">
        <div className="section__title">{t('settingsAppearance.window.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'fullscreen')}
          icon={<Maximize2 />}
          label={t('settingsAppearance.window.fullscreen.label')}
          description={t('settingsAppearance.window.fullscreen.description')}
          checked={ui.startFullscreen}
          onChange={(v) => patch({ ui: { startFullscreen: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'minimize')}
          icon={<Minimize2 />}
          label={t('settingsAppearance.window.minimize.label')}
          description={t('settingsAppearance.window.minimize.description')}
          checked={ui.minimizeWhilePlaying}
          onChange={(v) => patch({ ui: { minimizeWhilePlaying: v } })}
        />
      </div>

      <div className="section">
        <div className="section__title">{t('settingsAppearance.dashboard.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'clock')}
          icon={<Clock />}
          label={t('settingsAppearance.dashboard.clock.label')}
          description={t('settingsAppearance.dashboard.clock.description')}
          checked={ui.clock24h}
          onChange={(v) => patch({ ui: { clock24h: v } })}
        />
        <Slider
          focusKey={fk(SECTION, 'recent')}
          icon={<History />}
          label={t('settingsAppearance.dashboard.recent.label')}
          description={t('settingsAppearance.dashboard.recent.description')}
          value={ui.recentCount}
          min={4}
          max={40}
          step={1}
          formatValue={(v) => String(v)}
          onChange={(v) => patch({ ui: { recentCount: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'animations')}
          icon={<Sparkles />}
          label={t('settingsAppearance.dashboard.animations.label')}
          description={t('settingsAppearance.dashboard.animations.description')}
          checked={ui.animations}
          onChange={(v) => patch({ ui: { animations: v } })}
        />
      </div>
    </>
  )
}
