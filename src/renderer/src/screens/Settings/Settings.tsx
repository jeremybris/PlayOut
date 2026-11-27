import {
  ArrowBigUp,
  Cast,
  Gamepad2,
  Glasses,
  HardDrive,
  Image,
  Info,
  Library,
  Monitor,
  Palette,
  Repeat,
  Settings2,
  type LucideIcon
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ButtonHints } from '../../components/ButtonHints'
import { Menu, MenuItem } from '../../components/MenuItem'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { useActionHandlers } from '../../hooks/useActionHandlers'
import { useT, type Translate } from '../../i18n'
import { FocusContext, setFocus, useFocusable } from '../../input/focus'
import { useSettingsStore } from '../../state/settings'
import { SETTINGS_SECTIONS, useUiStore, type SettingsSection } from '../../state/ui'
import { isSection, navFocusKey, useSettingsPatch, type SectionProps } from './common'
import { AboutSection } from './sections/About'
import { AppearanceSection } from './sections/Appearance'
import { ConvertSection } from './sections/Convert'
import { EmulatorsSection } from './sections/Emulators'
import { InputSection } from './sections/Input'
import { LibrarySection } from './sections/Library'
import { MetadataSection } from './sections/Metadata'
import { RecompilationsSection } from './sections/Recompilations'
import { StorageSection } from './sections/Storage'
import { StreamingSection } from './sections/Streaming'
import { SystemSection } from './sections/System'
import { VrSection } from './sections/Vr'
import './settings.css'

const CONTENT_FOCUS_KEY = 'settings:content'

interface SectionMeta {
  id: SettingsSection
  /** The section's name in the current language (called per render, never kept). */
  label: (t: Translate) => string
  icon: LucideIcon
  component: (props: SectionProps) => ReactElement
}

/**
 * What each section shows. Keyed by SettingsSection so a section id added to SETTINGS_SECTIONS (state/ui.ts) without
 * an entry here does not compile, instead of opening the first section in its place.
 */
const SECTION_META: Record<SettingsSection, Omit<SectionMeta, 'id'>> = {
  library: {
    label: (t) => t('settings.sections.library'),
    icon: Library,
    component: LibrarySection
  },
  emulators: {
    label: (t) => t('settings.sections.emulators'),
    icon: Gamepad2,
    component: EmulatorsSection
  },
  recompilations: {
    label: (t) => t('settings.sections.recompilations'),
    icon: ArrowBigUp,
    component: RecompilationsSection
  },
  vr: { label: (t) => t('settings.sections.vr'), icon: Glasses, component: VrSection },
  convert: {
    label: (t) => t('settings.sections.convert'),
    icon: Repeat,
    component: ConvertSection
  },
  streaming: {
    label: (t) => t('settings.sections.streaming'),
    icon: Cast,
    component: StreamingSection
  },
  metadata: {
    label: (t) => t('settings.sections.metadata'),
    icon: Image,
    component: MetadataSection
  },
  appearance: {
    label: (t) => t('settings.sections.appearance'),
    icon: Palette,
    component: AppearanceSection
  },
  input: { label: (t) => t('settings.sections.input'), icon: Settings2, component: InputSection },
  storage: {
    label: (t) => t('settings.sections.storage'),
    icon: HardDrive,
    component: StorageSection
  },
  system: { label: (t) => t('settings.sections.system'), icon: Monitor, component: SystemSection },
  about: { label: (t) => t('settings.sections.about'), icon: Info, component: AboutSection }
}

/** The sections in the menu's order, which is SETTINGS_SECTIONS' order: the one list of section ids. */
const SECTIONS: SectionMeta[] = SETTINGS_SECTIONS.map((id) => ({ id, ...SECTION_META[id] }))

export interface SettingsModalProps {
  /** Section to open first (one of SETTINGS_SECTIONS: 'library', 'emulators', 'streaming', 'metadata', …). */
  section?: string
  onClose: () => void
}

/**
 * Settings panel: a section list on the left, the active section's controls on the right. LB/RB step
 * through the sections; focusing a list entry shows its section, A on it moves into the controls.
 */
export function SettingsModal({ section, onClose }: SettingsModalProps): ReactElement {
  // Counted while mounted, its exit animation included: the Library's Settings tab shares these focus keys and
  // waits until no Settings modal is left (Norigin forgets a focusable by key, so the closing modal's unmount
  // would otherwise remove the tab's freshly registered controls).
  useEffect(() => {
    const note = useUiStore.getState().noteSettingsModal
    note(1)
    return () => note(-1)
  }, [])
  const [active, setActive] = useState<SettingsSection>(isSection(section) ? section : 'library')
  // Set when LB/RB changed the section so the list entry takes focus once it is rendered as selected.
  const focusNav = useRef(false)

  const step = useCallback((delta: -1 | 1) => {
    setActive((current) => {
      const index = SECTIONS.findIndex((s) => s.id === current)
      const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length]
      if (!next || next.id === current) return current
      focusNav.current = true
      return next.id
    })
  }, [])

  useEffect(() => {
    if (!focusNav.current) return
    focusNav.current = false
    void setFocus(navFocusKey(active))
  }, [active])
  const t = useT()

  return (
    <Modal
      size="panel"
      scrim
      focusKey="settings"
      preferredChildFocusKey={navFocusKey(active)}
      title={t('settings.title')}
      onClose={onClose}
      className="settings-modal"
      bodyClassName="settings__body"
    >
      <SectionKeys onStep={step} />
      <SettingsPanel active={active} onActive={setActive} />
      <ButtonHints
        hints={[
          { button: 'lb', label: t('settings.hints.section') },
          { button: 'rb', label: t('settings.hints.section') },
          { button: 'a', label: t('settings.hints.select') },
          { button: 'b', label: t('settings.hints.back') }
        ]}
      />
    </Modal>
  )
}

export interface SettingsPanelProps {
  /** The section shown. */
  active: SettingsSection
  /** A section's entry took focus or was pressed. */
  onActive: (section: SettingsSection) => void
}

/**
 * The Settings menu itself: the section list on the left, the active section's controls on the right. Shown in
 * the Settings modal and, the same, in the Library's Settings tab (Library/SettingsTab.tsx). Their controls share
 * focus keys, so the two are never mounted together: the tab gives way while the modal is open.
 */
export function SettingsPanel({ active, onActive }: SettingsPanelProps): ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsPatch()
  const t = useT()
  const meta = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]!
  const Section = meta.component
  return (
    <>
      <nav className="settings__nav" aria-label={t('settings.navLabel')}>
        <Menu>
          {SECTIONS.map((entry) => {
            const Icon = entry.icon
            return (
              <MenuItem
                key={entry.id}
                focusKey={navFocusKey(entry.id)}
                icon={<Icon />}
                label={entry.label(t)}
                selected={entry.id === active}
                onFocus={() => onActive(entry.id)}
                onPress={() => {
                  onActive(entry.id)
                  void setFocus(CONTENT_FOCUS_KEY)
                }}
              />
            )
          })}
        </Menu>
      </nav>
      <SectionPane sectionId={meta.id} label={meta.label(t)}>
        {settings ? (
          <Section settings={settings} patch={patch} />
        ) : (
          <Spinner label={t('settings.loading')} className="settings-spinner" />
        )}
      </SectionPane>
    </>
  )
}

/**
 * LB/RB (Tab / Shift+Tab, [ / ]) step through the sections. Rendered inside the Modal so the handlers
 * land on the modal's action layer; registered from SettingsModal itself they would sit on the root layer
 * underneath it and never fire.
 */
function SectionKeys({ onStep }: { onStep: (delta: -1 | 1) => void }): null {
  useActionHandlers({
    lb: () => onStep(-1),
    rb: () => onStep(1)
  })
  return null
}

/** The scrollable right pane: a focus container so A on a list entry can jump into its first control. */
function SectionPane({
  sectionId,
  label,
  children
}: {
  sectionId: SettingsSection
  label: string
  children: ReactElement
}): ReactElement {
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: CONTENT_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true
  })
  // A new section starts at the top, whatever the previous one was scrolled to.
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 })
  }, [ref, sectionId])
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="settings__content" role="region" aria-label={label}>
        {children}
      </div>
    </FocusContext.Provider>
  )
}
