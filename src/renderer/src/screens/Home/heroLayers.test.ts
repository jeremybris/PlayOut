import { describe, expect, it } from 'vitest'
import {
  EMPTY_HERO_LAYERS,
  advanceHeroLayers,
  dropHeroLayer,
  markHeroLayerLoaded,
  settleHeroLayer,
  type HeroLayerState
} from './heroLayers'

const urls = (state: HeroLayerState): string[] => state.layers.map((l) => l.url)
const visible = (state: HeroLayerState): string[] =>
  state.layers.filter((l) => l.loaded && !l.leaving).map((l) => l.url)

describe('hero backdrop layers', () => {
  it('is unchanged when the featured url stays the same', () => {
    const a = advanceHeroLayers(EMPTY_HERO_LAYERS, 'a', false)
    expect(advanceHeroLayers(a, 'a', false)).toBe(a)
    expect(advanceHeroLayers(EMPTY_HERO_LAYERS, undefined, false)).toBe(EMPTY_HERO_LAYERS)
  })

  it('keeps the visible art when focus moves twice before the new art has loaded (A -> B -> C)', () => {
    let state = advanceHeroLayers(EMPTY_HERO_LAYERS, 'a', false)
    state = markHeroLayerLoaded(state, 1)
    state = advanceHeroLayers(state, 'b', false) // b still downloading
    state = advanceHeroLayers(state, 'c', false)
    expect(urls(state)).toEqual(['a', 'b', 'c'])
    // A is still the layer on screen: no flash to the background.
    expect(visible(state)).toEqual(['a'])

    // Whichever of B / C loads first fades in over A and, once in, prunes everything below it.
    state = markHeroLayerLoaded(state, 3)
    expect(visible(state)).toEqual(['a', 'c'])
    state = settleHeroLayer(state, 3)
    expect(urls(state)).toEqual(['c'])
  })

  it('drops pending layers that were never visible but never the loaded one (bounded at three)', () => {
    let state = markHeroLayerLoaded(advanceHeroLayers(EMPTY_HERO_LAYERS, 'a', false), 1)
    for (const url of ['b', 'c', 'd', 'e']) state = advanceHeroLayers(state, url, false)
    expect(urls(state)).toEqual(['a', 'd', 'e'])
    expect(visible(state)).toEqual(['a'])
  })

  it('fades in B over A and removes A when the fade ends', () => {
    let state = markHeroLayerLoaded(advanceHeroLayers(EMPTY_HERO_LAYERS, 'a', false), 1)
    state = advanceHeroLayers(state, 'b', true)
    state = markHeroLayerLoaded(state, 2)
    expect(visible(state)).toEqual(['a', 'b'])
    state = settleHeroLayer(state, 2)
    expect(urls(state)).toEqual(['b'])
    expect(state.layers[0]?.blur).toBe(true)
  })

  it('fades out only loaded layers when the featured game has no art', () => {
    let state = markHeroLayerLoaded(advanceHeroLayers(EMPTY_HERO_LAYERS, 'a', false), 1)
    state = advanceHeroLayers(state, 'b', false) // pending, never shown
    state = advanceHeroLayers(state, undefined, false)
    expect(state.layers).toHaveLength(1)
    expect(state.layers[0]).toMatchObject({ url: 'a', leaving: true })
    state = settleHeroLayer(state, 1)
    expect(state.layers).toEqual([])
    // New art after a fade-out starts a fresh stack with a fresh key.
    state = advanceHeroLayers(state, 'c', false)
    expect(state.layers.map((l) => l.key)).toEqual([3])
  })

  it('drops a layer whose image failed and ignores settles of unknown or unloaded layers', () => {
    let state = advanceHeroLayers(EMPTY_HERO_LAYERS, 'a', false)
    state = advanceHeroLayers(state, 'b', false)
    expect(settleHeroLayer(state, 2)).toBe(state) // not loaded: nothing to prune
    expect(settleHeroLayer(state, 99)).toBe(state)
    state = dropHeroLayer(state, 2)
    expect(urls(state)).toEqual(['a'])
    state = markHeroLayerLoaded(state, 1)
    expect(settleHeroLayer(state, 1)).toBe(state) // bottom layer: nothing below it
  })
})
