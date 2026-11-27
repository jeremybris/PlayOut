import { ArrowBigUp, Network, Sparkles, Users } from 'lucide-react'
import type { ReactElement, RefObject } from 'react'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { FocusContext, useFocusable } from '../../input/focus'
import { cx } from '../../lib/cx'
import {
  FEATURE_FOCUS,
  FEATURE_SLOTS as SLOTS,
  type CoopFeature,
  type Features,
  type PeerPartyFeature,
  type RecompFeature,
  type UpgradeFeature
} from './features'

export interface FeatureGridProps extends Features {
  /** Play is disabled (the game is running, or its install has just finished): Co-Op and PeerParty wait as well. */
  playDisabled: boolean
}

/**
 * The four-square grid right of Play: Recompilation, Upgrade, Co-Op and PeerParty, top left to bottom right. A
 * feature the game does not have leaves its square empty (not focusable, so navigation passes over it); a game with
 * none of them shows no grid at all. Right from Play enters it on the last square used, else the first one there.
 */
export function FeatureGrid(props: FeatureGridProps): ReactElement | null {
  const t = useT()
  const { recomp, upgrade, coop, peerParty, playDisabled } = props
  const first = SLOTS.find((slot) => !!props[slot])
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: FEATURE_FOCUS.features,
    focusable: first !== undefined,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: first ? FEATURE_FOCUS[first] : undefined
  })
  if (!first) return null
  const empty = <span className="gdetail__features-empty" aria-hidden="true" />
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="gdetail__features"
        role="group"
        aria-label={t('gameDetail.features.label')}
      >
        {recomp ? <RecompSquare recomp={recomp} /> : empty}
        {upgrade ? <UpgradeSquare upgrade={upgrade} gridRef={ref} /> : empty}
        {coop ? <CoopSquare coop={coop} disabled={playDisabled} /> : empty}
        {peerParty ? <PeerPartySquare peerParty={peerParty} disabled={playDisabled} /> : empty}
      </div>
    </FocusContext.Provider>
  )
}

/**
 * Recompilation (UP arrow): accent-filled once a recompilation is installed, pulsing while one installs or updates.
 */
function RecompSquare({ recomp }: { recomp: RecompFeature }): ReactElement {
  const busy = recomp.state === 'busy'
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey: FEATURE_FOCUS.recomp,
    onPress: recomp.onPress,
    scroll: false
  })
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'gdetail__feature',
        'gdetail__recomp',
        recomp.state === 'installed' && 'gdetail__feature--accent',
        busy && 'gdetail__feature--busy'
      )}
      aria-label={recomp.label}
      title={recomp.label}
      aria-busy={busy || undefined}
      {...props}
    >
      <ArrowBigUp aria-hidden="true" />
    </button>
  )
}

/** Upgrade (sparkles): opens the Upgrade menu above the grid, left-aligned with it. */
function UpgradeSquare({
  upgrade,
  gridRef
}: {
  upgrade: UpgradeFeature
  gridRef: RefObject<HTMLDivElement | null>
}): ReactElement {
  const t = useT()
  const control = useFocusableControl<HTMLButtonElement>({
    focusKey: FEATURE_FOCUS.upgrade,
    onPress: () => {
      const el = gridRef.current ?? control.ref.current
      if (el) upgrade.onPress(el)
    },
    scroll: false
  })
  const { ref, props } = control
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'gdetail__feature',
        'gdetail__upgrade',
        upgrade.open && 'gdetail__feature--open'
      )}
      aria-label={t('gameDetail.features.upgrade')}
      title={t('gameDetail.features.upgrade')}
      aria-haspopup="menu"
      aria-expanded={upgrade.open}
      {...props}
    >
      <Sparkles aria-hidden="true" />
    </button>
  )
}

/**
 * Co-Op (two people): starts the game in Nucleus Co-op split-screen. While a session is being prepared it pulses and
 * a press does nothing (it stays focusable, so focus does not drop off the bar).
 */
function CoopSquare({ coop, disabled }: { coop: CoopFeature; disabled: boolean }): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey: FEATURE_FOCUS.coop,
    onPress: () => {
      if (!coop.busy) coop.onPress()
    },
    disabled,
    scroll: false
  })
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'gdetail__feature',
        'gdetail__coop-square',
        coop.busy && 'gdetail__feature--busy'
      )}
      disabled={disabled}
      aria-label={
        coop.busy ? t('gameDetail.features.coopStarting') : t('gameDetail.features.coopPlay')
      }
      aria-busy={coop.busy || undefined}
      title={t('gameDetail.features.coopTitle')}
      {...props}
    >
      <Users aria-hidden="true" />
    </button>
  )
}

/**
 * PeerParty (network tree): starts the game through PeerParty for LAN play. Pulses while PeerParty downloads, is
 * checked or starts the game; accent-filled while this game runs through it.
 */
function PeerPartySquare({
  peerParty,
  disabled
}: {
  peerParty: PeerPartyFeature
  disabled: boolean
}): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey: FEATURE_FOCUS.peerParty,
    onPress: () => {
      if (!peerParty.busy) peerParty.onPress()
    },
    disabled,
    scroll: false
  })
  const title = peerParty.label ?? t('gameDetail.features.peerPartyTitle')
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'gdetail__feature',
        'gdetail__peerparty',
        peerParty.running && 'gdetail__feature--accent',
        peerParty.busy && 'gdetail__feature--busy'
      )}
      disabled={disabled}
      aria-label={t('gameDetail.features.peerPartyPlay')}
      aria-busy={peerParty.busy || undefined}
      title={title}
      {...props}
    >
      <Network aria-hidden="true" />
    </button>
  )
}
