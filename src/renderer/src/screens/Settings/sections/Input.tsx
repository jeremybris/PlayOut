import {
  PAD_BUTTON_LABELS,
  type HomeButtonStatus,
  type OverrideStatus,
  type PadButton
} from '@shared/overlay'
import {
  ArrowLeftRight,
  Gamepad2,
  Hand,
  Home,
  Keyboard,
  Layers,
  LayoutGrid,
  Pause,
  Pencil,
  Timer,
  Vibrate,
  Pointer,
  X
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { Chip } from '../../../components/Chip'
import { Modal } from '../../../components/Modal'
import { Slider } from '../../../components/Slider'
import { Toggle } from '../../../components/Toggle'
import { ModalClosingContext } from '../../../hooks/modalClosing'
import { useT, type Translate } from '../../../i18n'
import { STANDARD_BUTTONS, activeGamepad, setFocus } from '../../../input'
import { cx } from '../../../lib/cx'
import { displayTitle } from '../../../lib/library'
import {
  captureNotice,
  comboProblem,
  comboText,
  overrideText,
  readerText
} from '../../../overlay/text'
import { useLibraryStore } from '../../../state/library'
import { useUiStore } from '../../../state/ui'
import { fk, log, type SectionProps } from '../common'
import './homeButton.css'

const SECTION = 'input'

/**
 * Standard-mapping button indices in display order with their Xbox names (the d-pad's directions in the current
 * language; built per render, never kept).
 */
function testerButtons(t: Translate): { index: number; label: string }[] {
  return [
    { index: STANDARD_BUTTONS.a, label: 'A' },
    { index: STANDARD_BUTTONS.b, label: 'B' },
    { index: STANDARD_BUTTONS.x, label: 'X' },
    { index: STANDARD_BUTTONS.y, label: 'Y' },
    { index: STANDARD_BUTTONS.lb, label: 'LB' },
    { index: STANDARD_BUTTONS.rb, label: 'RB' },
    { index: STANDARD_BUTTONS.lt, label: 'LT' },
    { index: STANDARD_BUTTONS.rt, label: 'RT' },
    { index: STANDARD_BUTTONS.select, label: 'View' },
    { index: STANDARD_BUTTONS.start, label: 'Menu' },
    { index: STANDARD_BUTTONS.ls, label: 'LS' },
    { index: STANDARD_BUTTONS.rs, label: 'RS' },
    { index: STANDARD_BUTTONS.up, label: t('settingsInput.tester.buttons.up') },
    { index: STANDARD_BUTTONS.down, label: t('settingsInput.tester.buttons.down') },
    { index: STANDARD_BUTTONS.left, label: t('settingsInput.tester.buttons.left') },
    { index: STANDARD_BUTTONS.right, label: t('settingsInput.tester.buttons.right') },
    { index: STANDARD_BUTTONS.guide, label: 'Guide' }
  ]
}

interface PadSnapshot {
  id: string
  mapping: string
  pressed: number[]
  /** Left and right stick positions, -1..1. */
  sticks: [number, number, number, number]
}

function readPad(): PadSnapshot | null {
  let pad = activeGamepad()
  if (!pad && typeof navigator.getGamepads === 'function') {
    pad = navigator.getGamepads().find((p): p is Gamepad => !!p && p.connected) ?? null
  }
  if (!pad) return null
  const pressed: number[] = []
  pad.buttons.forEach((button, index) => {
    if (button.pressed || button.value > 0.5) pressed.push(index)
  })
  const axis = (i: number): number => Math.round((pad.axes[i] ?? 0) * 100) / 100
  return {
    id: pad.id,
    mapping: pad.mapping,
    pressed,
    sticks: [axis(0), axis(1), axis(2), axis(3)]
  }
}

function sameSnapshot(a: PadSnapshot | null, b: PadSnapshot | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.id === b.id &&
    a.mapping === b.mapping &&
    a.pressed.length === b.pressed.length &&
    a.pressed.every((v, i) => v === b.pressed[i]) &&
    a.sticks.every((v, i) => v === b.sticks[i])
  )
}

/** Live view of the active gamepad: polled each frame while the section is open. */
function GamepadTester({ deadzone }: { deadzone: number }): ReactElement {
  const t = useT()
  const [pad, setPad] = useState<PadSnapshot | null>(null)
  useEffect(() => {
    let frame = 0
    let last: PadSnapshot | null = null
    const poll = (): void => {
      const next = readPad()
      if (!sameSnapshot(last, next)) {
        last = next
        setPad(next)
      }
      frame = requestAnimationFrame(poll)
    }
    frame = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(frame)
  }, [])

  const pressed = new Set(pad?.pressed ?? [])
  const name = pad ? pad.id.replace(/\s*\(.*$/, '').trim() || pad.id : null

  return (
    <div className="tester" aria-live="polite">
      <div className="tester__status">
        <Gamepad2 className={cx('tester__icon', pad && 'tester__icon--on')} />
        <div className="settings-row__text">
          <span className="settings-row__label">
            {pad ? name : t('settingsInput.tester.noController')}
          </span>
          <span className="settings-row__desc">
            {pad
              ? pad.mapping === 'standard'
                ? t('settingsInput.tester.standard')
                : t('settingsInput.tester.nonStandard', {
                    mapping: pad.mapping || t('settingsInput.tester.unknownMapping')
                  })
              : t('settingsInput.tester.connect')}
          </span>
        </div>
      </div>
      <div className="tester__buttons">
        {testerButtons(t).map((button) => (
          <span
            key={button.index}
            className={cx('tester__button', pressed.has(button.index) && 'tester__button--on')}
          >
            {button.label}
          </span>
        ))}
      </div>
      <div className="tester__sticks">
        <Stick
          label={t('settingsInput.tester.leftStick')}
          x={pad?.sticks[0] ?? 0}
          y={pad?.sticks[1] ?? 0}
          deadzone={deadzone}
        />
        <Stick
          label={t('settingsInput.tester.rightStick')}
          x={pad?.sticks[2] ?? 0}
          y={pad?.sticks[3] ?? 0}
          deadzone={deadzone}
        />
      </div>
    </div>
  )
}

function Stick({
  label,
  x,
  y,
  deadzone
}: {
  label: string
  x: number
  y: number
  deadzone: number
}): ReactElement {
  const magnitude = Math.hypot(x, y)
  const active = magnitude > deadzone
  return (
    <div className="tester__stick">
      <div className="tester__pad" aria-label={`${label} ${x}, ${y}`}>
        <span
          className="tester__deadzone"
          style={{ width: `${deadzone * 100}%`, height: `${deadzone * 100}%` }}
        />
        <span
          className={cx('tester__dot', active && 'tester__dot--on')}
          style={{ left: `${50 + x * 50}%`, top: `${50 + y * 50}%` }}
        />
      </div>
      <span className="tester__stick-label">
        {label}
        <span className="tester__stick-value">
          {x.toFixed(2)}, {y.toFixed(2)}
        </span>
      </span>
    </div>
  )
}

/** The buttons of a combo as chips ('View' 'Menu'); `live` marks buttons being held during a capture. */
function ComboChips({
  buttons,
  live,
  empty
}: {
  buttons: readonly PadButton[]
  live?: boolean
  empty: string
}): ReactElement {
  if (buttons.length === 0) return <span className="home-combo__empty">{empty}</span>
  return (
    <span className="home-combo" aria-label={comboText(buttons)}>
      {buttons.map((button, i) => (
        <span key={button} className="home-combo__item">
          {i > 0 ? <span className="home-combo__plus">+</span> : null}
          <Chip className={cx('home-combo__chip', live && 'home-combo__chip--live')}>
            {PAD_BUTTON_LABELS[button]}
          </Chip>
        </span>
      ))}
    </span>
  )
}

/** The capture dialog sits above the Settings modal and must not take on its closing state. */
const NOT_CLOSING = { closing: false, onClosed: () => undefined }

/**
 * "Press the new buttons": the main process records the pads (any controller, Guide included) and reports the held
 * buttons live on 'home:capture'; the combo is the buttons held together once all are let go. Gamepad presses are
 * what is being recorded, so only the keyboard (Escape), the mouse or touch can cancel.
 */
function ComboCaptureDialog({
  onDone,
  onCancel
}: {
  onDone: (combo: PadButton[]) => void
  /** Closed without a combo; the notice says why when the buttons pressed could not be used. */
  onCancel: (notice?: string) => void
}): ReactElement {
  const t = useT()
  const [held, setHeld] = useState<PadButton[]>([])
  /** The most buttons held at once during this capture (0: nothing was pressed). */
  const mostHeld = useRef(0)
  // The capture starts once; its failure toast reads the text of the latest render, like the callbacks.
  const readFailed = t('settingsInput.capture.readFailed')
  const latest = useRef({ onDone, onCancel, readFailed })
  useEffect(() => {
    latest.current = { onDone, onCancel, readFailed }
  })
  useEffect(() => {
    const off = api.on('home:capture', (event) => {
      setHeld(event.held)
      mostHeld.current = Math.max(mostHeld.current, event.held.length)
      if (!event.done) return
      // done: [] is a capture the main process rejected (a single button other than Home, too many) or cancelled.
      const problem = event.done.length ? comboProblem(event.done) : null
      if (event.done.length && !problem) latest.current.onDone(event.done)
      else latest.current.onCancel(captureNotice(event.done, mostHeld.current))
    })
    api.startComboCapture().catch((err) => {
      log.error('startComboCapture failed', err)
      useUiStore.getState().toast(latest.current.readFailed, 'error')
      latest.current.onCancel()
    })
    return () => {
      off()
      // Harmless after a finished capture; ends one that the dialog's closing cut short.
      api.stopComboCapture().catch((err) => log.error('stopComboCapture failed', err))
    }
  }, [])

  const cancel = (): void => {
    if (useUiStore.getState().inputMethod === 'gamepad') return
    onCancel()
  }

  return createPortal(
    <ModalClosingContext.Provider value={NOT_CLOSING}>
      <Modal
        size="dialog"
        narrow
        hideClose
        focusKey="settings:homeCapture"
        title={t('settingsInput.capture.title')}
        onClose={cancel}
        footer={
          <Button focusKey="settings:homeCapture:cancel" onPress={cancel}>
            {t('settingsInput.capture.cancel')}
          </Button>
        }
      >
        <p className="dialog__message">{t('settingsInput.capture.message')}</p>
        <div className="home-capture" aria-live="polite">
          <ComboChips buttons={held} live empty={t('settingsInput.capture.waiting')} />
        </div>
      </Modal>
    </ModalClosingContext.Provider>,
    document.body
  )
}

/** The home button's status, loaded once and kept current by 'home:status'. */
function useHomeButtonStatus(): HomeButtonStatus | null {
  const [status, setStatus] = useState<HomeButtonStatus | null>(null)
  useEffect(() => {
    let live = true
    api
      .getHomeButtonStatus()
      .then((s) => {
        if (live) setStatus(s)
      })
      .catch((err) => log.error('getHomeButtonStatus failed', err))
    const off = api.on('home:status', setStatus)
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

function OverrideNote({
  status,
  kind
}: {
  status?: OverrideStatus
  kind: 'steam' | 'gameBar'
}): ReactElement {
  return (
    <p
      className={cx('settings-note', status?.state === 'error' && 'settings-note--missing')}
      role="status"
    >
      {overrideText(kind, status)}
    </p>
  )
}

/** Settings › Controls › Home button: on/off, the combo and its capture, hold time, overrides, the reader, clashes. */
function HomeButtonGroup({ settings, patch }: SectionProps): ReactElement {
  const { input } = settings
  const t = useT()
  const status = useHomeButtonStatus()
  const [capturing, setCapturing] = useState(false)
  const off = !input.homeButtonEnabled
  const usesGuide = input.homeCombo.includes('guide')

  return (
    <div className="section">
      <div className="section__title">{t('settingsInput.home.title')}</div>
      <Toggle
        focusKey={fk(SECTION, 'homeEnabled')}
        icon={<Home />}
        label={t('settingsInput.home.enabled.label')}
        description={t('settingsInput.home.enabled.description')}
        checked={input.homeButtonEnabled}
        onChange={(v) => patch({ input: { homeButtonEnabled: v } })}
      />
      <div className={cx('settings-row', off && 'control--disabled')}>
        <span className="control__icon">
          <LayoutGrid />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">{t('settingsInput.combo.buttons')}</span>
          <ComboChips buttons={input.homeCombo} empty={t('settingsInput.combo.notSet')} />
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={fk(SECTION, 'homeCombo')}
            icon={<Pencil />}
            disabled={off}
            onPress={() => setCapturing(true)}
          >
            {t('settingsInput.combo.change')}
          </Button>
        </div>
      </div>
      <Slider
        focusKey={fk(SECTION, 'homeHold')}
        icon={<Hand />}
        label={t('settingsInput.home.hold.label')}
        description={t('settingsInput.home.hold.description')}
        value={input.homeHoldMs}
        min={0}
        max={1000}
        step={100}
        disabled={off}
        formatValue={(v) =>
          v === 0 ? t('settingsInput.home.hold.atOnce') : t('settingsInput.ms', { value: v })
        }
        onChange={(v) => patch({ input: { homeHoldMs: v } })}
      />
      <Toggle
        focusKey={fk(SECTION, 'homeSteam')}
        icon={<Gamepad2 />}
        label={t('settingsInput.home.steam.label')}
        description={t('settingsInput.home.steam.description')}
        checked={input.homeOverrideSteam}
        disabled={off || !usesGuide}
        onChange={(v) => patch({ input: { homeOverrideSteam: v } })}
      />
      <OverrideNote kind="steam" status={status?.steam} />
      {!usesGuide ? (
        <p className="settings-note">{t('settingsInput.home.steam.onlyWithHome')}</p>
      ) : null}
      <Toggle
        focusKey={fk(SECTION, 'homeGameBar')}
        icon={<Gamepad2 />}
        label={t('settingsInput.home.gameBar.label')}
        description={t('settingsInput.home.gameBar.description')}
        checked={input.homeOverrideGameBar}
        disabled={off}
        onChange={(v) => patch({ input: { homeOverrideGameBar: v } })}
      />
      <OverrideNote kind="gameBar" status={status?.gameBar} />
      <Toggle
        focusKey={fk(SECTION, 'homePause')}
        icon={<Pause />}
        label={t('settingsInput.home.pause.label')}
        description={t('settingsInput.home.pause.description')}
        checked={input.homePauseGame}
        disabled={off}
        onChange={(v) => patch({ input: { homePauseGame: v } })}
      />
      <Toggle
        focusKey={fk(SECTION, 'touchSwipe')}
        icon={<Pointer />}
        label={t('settingsInput.home.touchSwipe.label')}
        description={t('settingsInput.home.touchSwipe.description')}
        checked={input.touchSwipeOverlay}
        onChange={(v) => patch({ input: { touchSwipeOverlay: v } })}
      />
      <p
        className={cx(
          'settings-note',
          status?.reader.state === 'unavailable' && 'settings-note--missing'
        )}
        role="status"
      >
        {readerText(status)}
      </p>
      {status?.clash ? (
        <p className="settings-note settings-note--missing" role="alert">
          {status.clash}
        </p>
      ) : null}
      {capturing ? (
        <ComboCaptureDialog
          onDone={(combo) => {
            setCapturing(false)
            // Never an empty, oversized or single non-Home combo: the old one stays.
            const problem =
              comboProblem(combo) ??
              (combosOverlap(combo, input.keyboardCombo ?? [])
                ? t('settingsInput.combo.overlapsKeyboard')
                : null)
            if (problem) useUiStore.getState().toast(problem)
            else patch({ input: { homeCombo: combo } })
          }}
          onCancel={(notice) => {
            setCapturing(false)
            if (notice) useUiStore.getState().toast(notice)
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Settings › Controls › In-game overlay (docs/home-overlay.md, "In-game overlay"): on / off, and the games it is never
 * used for (a game PlayOut took off after it crashed with the overlay inside), each with a button to allow it again.
 */
function IngameOverlayGroup({ settings, patch }: SectionProps): ReactElement {
  const { input } = settings
  const never = input.ingameNever ?? []
  const t = useT()
  const byId = useLibraryStore((s) => s.byId)
  const off = !input.ingameOverlay

  const allow = (id: string): void => {
    const next = never.filter((g) => g !== id)
    // The row (and its button) goes away: focus moves to the next row, or back to the toggle after the last one.
    const at = never.indexOf(id)
    const after = next[Math.min(at, next.length - 1)]
    patch({ input: { ingameNever: next } })
    void setFocus(after ? fk(SECTION, `ingameNever:${after}`) : fk(SECTION, 'ingameOverlay'))
  }

  return (
    <div className="section">
      <div className="section__title">{t('settingsInput.ingame.title')}</div>
      <Toggle
        focusKey={fk(SECTION, 'ingameOverlay')}
        icon={<Layers />}
        label={t('settingsInput.ingame.label')}
        description={t('settingsInput.ingame.description')}
        checked={input.ingameOverlay}
        onChange={(v) => patch({ input: { ingameOverlay: v } })}
      />
      {never.length ? (
        <>
          <p className="settings-note">{t('settingsInput.ingame.never')}</p>
          <div role="list">
            {never.map((id) => {
              const game = byId.get(id)
              const title = game ? displayTitle(game) : id
              return (
                <div
                  key={id}
                  className={cx('settings-row', off && 'control--disabled')}
                  role="listitem"
                >
                  <span className="control__icon">
                    <Layers />
                  </span>
                  <div className="settings-row__text">
                    <span className="settings-row__label">{title}</span>
                    <span className="settings-row__desc">
                      {t('settingsInput.ingame.neverDescription')}
                    </span>
                  </div>
                  <div className="settings-row__actions">
                    <Button
                      focusKey={fk(SECTION, `ingameNever:${id}`)}
                      icon={<X />}
                      aria-label={t('settingsInput.ingame.allowLabel', { title })}
                      onPress={() => allow(id)}
                    >
                      {t('settingsInput.ingame.remove')}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * Two combos clash when pressing one also completes the other (one's buttons include all of the other's): both would
 * fire.
 */
function combosOverlap(a: readonly PadButton[], b: readonly PadButton[]): boolean {
  if (!a.length || !b.length) return false
  return a.every((x) => b.includes(x)) || b.every((x) => a.includes(x))
}

/**
 * Settings › Controls › On-screen keyboard: the buttons that open Windows' on-screen keyboard over any game, recorded
 * like the home button's (not set by default), and Clear.
 */
function KeyboardButtonGroup({ settings, patch }: SectionProps): ReactElement {
  const { input } = settings
  const [capturing, setCapturing] = useState(false)
  const combo = input.keyboardCombo ?? []
  const t = useT()
  return (
    <div className="section">
      <div className="section__title">{t('settingsInput.keyboard.title')}</div>
      <div className="settings-row">
        <span className="control__icon">
          <Keyboard />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">{t('settingsInput.combo.buttons')}</span>
          <ComboChips buttons={combo} empty={t('settingsInput.combo.notSet')} />
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={fk(SECTION, 'keyboardCombo')}
            icon={<Pencil />}
            onPress={() => setCapturing(true)}
          >
            {combo.length ? t('settingsInput.combo.change') : t('settingsInput.combo.set')}
          </Button>
          {combo.length ? (
            <Button
              focusKey={fk(SECTION, 'keyboardClear')}
              icon={<X />}
              onPress={() => patch({ input: { keyboardCombo: [] } })}
            >
              {t('settingsInput.combo.clear')}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="settings-note">{t('settingsInput.keyboard.note')}</p>
      {capturing ? (
        <ComboCaptureDialog
          onDone={(next) => {
            setCapturing(false)
            const problem =
              comboProblem(next) ??
              (input.homeButtonEnabled && combosOverlap(next, input.homeCombo)
                ? t('settingsInput.combo.overlapsHome')
                : null)
            if (problem) useUiStore.getState().toast(problem)
            else patch({ input: { keyboardCombo: next } })
          }}
          onCancel={(notice) => {
            setCapturing(false)
            if (notice) useUiStore.getState().toast(notice)
          }}
        />
      ) : null}
    </div>
  )
}

/** Home button, controller dead zone, rumble, A/B swap, repeat timing and the live gamepad tester. */
export function InputSection({ settings, patch }: SectionProps): ReactElement {
  const { input } = settings
  const t = useT()
  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsInput.title')}</h2>
          <p className="settings-section__lead">{t('settingsInput.lead')}</p>
        </div>
      </div>

      <HomeButtonGroup settings={settings} patch={patch} />
      <IngameOverlayGroup settings={settings} patch={patch} />
      <KeyboardButtonGroup settings={settings} patch={patch} />

      <div className="section">
        <div className="section__title">{t('settingsInput.controller.title')}</div>
        <Slider
          focusKey={fk(SECTION, 'deadzone')}
          icon={<Gamepad2 />}
          label={t('settingsInput.controller.deadzone.label')}
          description={t('settingsInput.controller.deadzone.description')}
          value={Math.round(input.deadzone * 100)}
          min={5}
          max={60}
          step={5}
          onChange={(v) => patch({ input: { deadzone: v / 100 } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'vibration')}
          icon={<Vibrate />}
          label={t('settingsInput.controller.vibration.label')}
          description={t('settingsInput.controller.vibration.description')}
          checked={input.vibration}
          onChange={(v) => patch({ input: { vibration: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'swapAB')}
          icon={<ArrowLeftRight />}
          label={t('settingsInput.controller.swapAB.label')}
          description={t('settingsInput.controller.swapAB.description')}
          checked={input.swapAB}
          onChange={(v) => patch({ input: { swapAB: v } })}
        />
      </div>

      <div className="section">
        <div className="section__title">{t('settingsInput.repeat.title')}</div>
        <Slider
          focusKey={fk(SECTION, 'repeatDelay')}
          icon={<Timer />}
          label={t('settingsInput.repeat.delay.label')}
          description={t('settingsInput.repeat.delay.description')}
          value={input.repeatDelayMs}
          min={150}
          max={1000}
          step={50}
          formatValue={(v) => t('settingsInput.ms', { value: v })}
          onChange={(v) => patch({ input: { repeatDelayMs: v } })}
        />
        <Slider
          focusKey={fk(SECTION, 'repeatRate')}
          icon={<Timer />}
          label={t('settingsInput.repeat.rate.label')}
          description={t('settingsInput.repeat.rate.description')}
          value={input.repeatRateMs}
          min={40}
          max={300}
          step={10}
          formatValue={(v) => t('settingsInput.ms', { value: v })}
          onChange={(v) => patch({ input: { repeatRateMs: v } })}
        />
      </div>

      <div className="section">
        <div className="section__title">{t('settingsInput.tester.title')}</div>
        <GamepadTester deadzone={input.deadzone} />
      </div>
    </>
  )
}
