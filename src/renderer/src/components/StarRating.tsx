import type { ReactElement } from 'react'
import { useT } from '../i18n'
import { STAR } from '../lib/bandIcon'
import { starsFor } from '../lib/format'

function Stars({ className }: { className: string }): ReactElement {
  return (
    <span className={className} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 24 24" className="stars__star">
          <path d={STAR} />
        </svg>
      ))}
    </span>
  )
}

/**
 * A review score out of 100 as five stars filled in proportion (84: four stars and a fifth's first fifth), in the
 * theme's white over faint outlines.
 */
export function StarRating({ score, source }: { score: number; source?: string }): ReactElement {
  const t = useT()
  const stars = starsFor(score)
  const text = source
    ? t('components.starRating.labelWithSource', { stars, source })
    : t('components.starRating.label', { stars })
  return (
    <span className="stars" role="img" aria-label={text} title={text}>
      <Stars className="stars__row stars__row--empty" />
      <span className="stars__fill" style={{ width: `${(stars / 5) * 100}%` }}>
        <Stars className="stars__row stars__row--full" />
      </span>
    </span>
  )
}
