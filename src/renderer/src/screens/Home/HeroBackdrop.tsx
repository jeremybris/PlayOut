import type { Game } from '@shared/types'
import { useState, type ReactElement } from 'react'
import { cx } from '../../lib/cx'
import { createLog } from '../../lib/log'
import { heroIsCoverFallback, heroUrl } from '../../lib/media'
import {
  EMPTY_HERO_LAYERS,
  advanceHeroLayers,
  dropHeroLayer,
  markHeroLayerLoaded,
  settleHeroLayer
} from './heroLayers'

const log = createLog('home:hero')

export interface HeroBackdropProps {
  game: Game | undefined
  /** Darken the art while a panel sits on top of it (design 3.1 "page behind"). */
  dimmed?: boolean
  /** Draw the left and bottom gradients over the art (default true; the Library's blurred copy has none). */
  gradients?: boolean
}

/**
 * Full-bleed hero art of the featured game with the left and bottom gradients (design 2.1). A new image is
 * stacked on top of the current one and faded in once it has loaded (crossfade --dur-hero); the layers
 * underneath, including the art on screen, are kept until the new one has fully faded in and are dropped
 * when that fade ends, so the art never flashes to the background between games, even when focus moves
 * again before the new art has loaded (rules in heroLayers.ts).
 */
export function HeroBackdrop({
  game,
  dimmed = false,
  gradients = true
}: HeroBackdropProps): ReactElement {
  const url = game ? heroUrl(game) : undefined
  const blur = game ? heroIsCoverFallback(game) : false
  const [state, setState] = useState(EMPTY_HERO_LAYERS)

  // Adjust the layer stack from the new props during render (React's "previous props" pattern).
  const next = advanceHeroLayers(state, url, blur)
  if (next !== state) setState(next)

  const markLoaded = (key: number): void => setState((s) => markHeroLayerLoaded(s, key))
  const dropLayer = (key: number): void => setState((s) => dropHeroLayer(s, key))
  const settle = (key: number): void => setState((s) => settleHeroLayer(s, key))

  return (
    <div className={cx('backdrop', dimmed && 'backdrop--dimmed')} aria-hidden="true">
      {state.layers.map((layer) => (
        <div
          key={layer.key}
          className={cx(
            'backdrop__layer',
            layer.loaded && !layer.leaving && 'backdrop__layer--visible'
          )}
          onTransitionEnd={(event) => {
            if (event.propertyName === 'opacity') settle(layer.key)
          }}
        >
          <img
            className={cx('backdrop__art', layer.blur && 'backdrop__art--blur')}
            src={layer.url}
            alt=""
            decoding="async"
            draggable={false}
            onLoad={() => markLoaded(layer.key)}
            onError={() => {
              log.warn(`hero art failed to load: ${layer.url}`)
              dropLayer(layer.key)
            }}
          />
        </div>
      ))}
      {gradients ? (
        <>
          <div className="backdrop__gradient-left" />
          <div className="backdrop__gradient-bottom" />
        </>
      ) : null}
    </div>
  )
}
