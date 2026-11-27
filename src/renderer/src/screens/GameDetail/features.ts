// The four-square grid right of Play (FeatureGrid.tsx): what each square needs, its focus keys and the order of the
// squares. Kept apart from the component so fast refresh keeps working on it.

/** Focus keys of the grid and its four squares (they keep the keys the old Play-attached buttons had). */
export const FEATURE_FOCUS = {
  features: 'detail:features',
  recomp: 'detail:recomp',
  upgrade: 'detail:upgrade',
  coop: 'detail:coop',
  peerParty: 'detail:peerparty'
} as const

/**
 * Recompilations (main/recomp): the game has a native PC port. 'available' opens the Recompilation page, 'installed'
 * starts the chosen recompilation (or opens its page when Play already starts it), 'busy' while one installs or
 * updates (it opens the page, which shows the progress). `label` is its tooltip and accessible name.
 */
export interface RecompFeature {
  state: 'available' | 'installed' | 'busy'
  onPress: () => void
  label: string
}

/** Upgrades (PC games, main upgrades/): opens the Upgrade menu anchored to the grid. `open` while that menu is shown. */
export interface UpgradeFeature {
  onPress: (anchor: HTMLElement) => void
  open: boolean
}

/** Co-Op (Nucleus Co-op split-screen) for a game with a Co-Op handler. `busy` while a session is being prepared. */
export interface CoopFeature {
  onPress: () => void
  busy: boolean
}

/**
 * PeerParty (main/peerparty): LAN play for an eligible installed game. `busy` while PeerParty downloads, is checked or
 * starts the game (`label` then says how far it got); `running` while this game runs through PeerParty.
 */
export interface PeerPartyFeature {
  onPress: () => void
  busy: boolean
  label?: string
  running: boolean
}

/** The features a game has; a missing one leaves its square empty. */
export interface Features {
  recomp?: RecompFeature
  upgrade?: UpgradeFeature
  coop?: CoopFeature
  peerParty?: PeerPartyFeature
}

export type FeatureSlot = keyof Features

/** The squares in grid order: top left, top right, bottom left, bottom right. */
export const FEATURE_SLOTS: readonly FeatureSlot[] = ['recomp', 'upgrade', 'coop', 'peerParty']

/**
 * Whether Co-Op and PeerParty must wait: the game runs, its install has just finished, or a stream from a host is
 * starting or running in the Play slot (either would start this PC's copy beside the stream).
 */
export function featuresWaitForPlay(state: {
  running: boolean
  justInstalled: boolean
  streamConnecting: boolean
  streamLive: boolean
}): boolean {
  return state.running || state.justInstalled || state.streamConnecting || state.streamLive
}

/** The squares the game has, in grid order ('recomp|coop'); empty when it has none. */
export function presentFeatures(features: Features): string {
  return FEATURE_SLOTS.filter((slot) => !!features[slot]).join('|')
}
