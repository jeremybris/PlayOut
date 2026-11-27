/**
 * The hero backdrop's layer stack (HeroBackdrop.tsx), kept as pure functions so the crossfade rules can be
 * unit tested without a DOM. A layer is one <img>: it is stacked on top when the featured game changes,
 * fades in once loaded and, once fully in, hides everything underneath (which settle() then removes).
 */
export interface HeroLayer {
  key: number
  url: string
  /** No wide art: the cover is shown blurred and enlarged. */
  blur: boolean
  loaded: boolean
  /** Fading out (the featured game has no art any more). */
  leaving: boolean
}

export interface HeroLayerState {
  layers: HeroLayer[]
  nextKey: number
}

export const EMPTY_HERO_LAYERS: HeroLayerState = { layers: [], nextKey: 1 }

/** The url the stack currently shows or is fading in; undefined when empty or fading out. */
export function topHeroUrl(state: HeroLayerState): string | undefined {
  const top = state.layers[state.layers.length - 1]
  return top && !top.leaving ? top.url : undefined
}

/**
 * Adjust the stack for a new featured url. Returns the same state when nothing changes. The stack keeps
 * the topmost *loaded* layer (the art actually on screen) as well as the current top (which may still be
 * loading), so a second focus change before the new art has loaded never drops the visible art and flashes
 * the background: A(loaded) -> B(loading) -> C gives [A, B, C]; whichever of B/C loads first fades in over A.
 * The stack is therefore bounded at three layers. Without a url, only loaded layers are kept, fading out
 * (never-loaded layers were never visible and would get no transitionend).
 */
export function advanceHeroLayers(
  state: HeroLayerState,
  url: string | undefined,
  blur: boolean
): HeroLayerState {
  if (topHeroUrl(state) === url) return state
  const top = state.layers[state.layers.length - 1]
  const lastLoaded = [...state.layers].reverse().find((layer) => layer.loaded && !layer.leaving)
  const kept = state.layers.filter((layer) => layer === lastLoaded || layer === top)
  if (url) {
    return {
      layers: [...kept, { key: state.nextKey, url, blur, loaded: false, leaving: false }],
      nextKey: state.nextKey + 1
    }
  }
  return {
    layers: kept.filter((layer) => layer.loaded).map((layer) => ({ ...layer, leaving: true })),
    nextKey: state.nextKey
  }
}

/** The image of `key` has loaded: it starts fading in. */
export function markHeroLayerLoaded(state: HeroLayerState, key: number): HeroLayerState {
  return {
    ...state,
    layers: state.layers.map((layer) => (layer.key === key ? { ...layer, loaded: true } : layer))
  }
}

/** Remove one layer (its image failed to load). */
export function dropHeroLayer(state: HeroLayerState, key: number): HeroLayerState {
  return { ...state, layers: state.layers.filter((layer) => layer.key !== key) }
}

/**
 * The opacity transition of `key` ended: a leaving layer is gone; a layer that faded fully in hides
 * everything underneath it, loaded or still pending, so those layers are removed.
 */
export function settleHeroLayer(state: HeroLayerState, key: number): HeroLayerState {
  const index = state.layers.findIndex((layer) => layer.key === key)
  if (index < 0) return state
  const layer = state.layers[index]!
  if (layer.leaving) return { ...state, layers: state.layers.filter((l) => l.key !== key) }
  if (!layer.loaded || index === 0) return state
  return { ...state, layers: state.layers.slice(index) }
}
