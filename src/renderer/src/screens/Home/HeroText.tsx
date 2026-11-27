import type { Game, Platform } from '@shared/types'
import { useState, type ReactElement } from 'react'
import { useT } from '../../i18n'
import { displayTitle } from '../../lib/library'
import { logoUrl } from '../../lib/media'
import { heroMetaParts } from './heroMeta'

export interface HeroTextProps {
  game: Game | undefined
  platforms: Platform[]
}

/**
 * Top-left text block of the featured game: its logo (or the title in large bold text when there is no
 * logo or it fails to load) and the meta line `Played 19.6 hours · RPG · 2026 · Steam` (design 2.2).
 * Re-keyed per game so a change fades in.
 */
export function HeroText({ game, platforms }: HeroTextProps): ReactElement | null {
  if (!game) return null
  return (
    <div className="featured" aria-live="polite">
      <FeaturedContent key={game.id} game={game} platforms={platforms} />
    </div>
  )
}

function FeaturedContent({ game, platforms }: { game: Game; platforms: Platform[] }): ReactElement {
  const t = useT()
  const logo = logoUrl(game)
  const [brokenLogo, setBrokenLogo] = useState<string | null>(null)
  const title = displayTitle(game)
  const showLogo = logo !== undefined && logo !== brokenLogo
  const parts = heroMetaParts(game, platforms, t)
  return (
    <div className="featured__content">
      {showLogo ? (
        <img
          className="featured__logo"
          src={logo}
          alt={title}
          decoding="async"
          draggable={false}
          onError={() => setBrokenLogo(logo)}
        />
      ) : (
        <h1 className="featured__title">{title}</h1>
      )}
      <div className="featured__meta">
        {parts.map((part, index) => (
          <span key={`${index}:${part}`} className="featured__meta-part">
            {index > 0 ? (
              <span className="featured__sep" aria-hidden="true">
                &middot;
              </span>
            ) : null}
            {part}
          </span>
        ))}
      </div>
    </div>
  )
}
