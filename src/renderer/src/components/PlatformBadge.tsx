import type { Platform } from '@shared/types'
import { ArrowBigUp } from 'lucide-react'
import { memo, type CSSProperties, type ReactElement } from 'react'
import { useT } from '../i18n'
import { badgeColor, badgeGlyph, type BadgeGlyph } from '../lib/badge'
import { cx } from '../lib/cx'
import { systemLogo } from '../lib/systemLogos'

export interface PlatformBadgeProps {
  /** The platform row (icon slug + name). */
  platform?: Platform | null
  /** Explicit slug when no Platform row is at hand. */
  icon?: string
  /** An emulation system's id when no Platform row is at hand: its logo is shown when it has one. */
  systemId?: string
  /** Name for the letter fallback and the tooltip. */
  name?: string
  /** sm = 24u (row headers), md = 36u (cards, default), lg = 48u, or any CSS length. */
  size?: 'sm' | 'md' | 'lg' | string
  className?: string
  style?: CSSProperties
}

/**
 * Round platform / store badge: a brand glyph (simple-icons path), our own original Xbox / Nintendo marks,
 * a lucide icon, or the platform's initial letter (resolution in lib/badge.ts). Memoised: every GameCard
 * carries one and the glyph lookup must not re-run for cards whose props did not change.
 */
export const PlatformBadge = memo(function PlatformBadge({
  platform,
  icon,
  systemId,
  name,
  size = 'md',
  className,
  style
}: PlatformBadgeProps): ReactElement {
  const slug = icon ?? platform?.icon
  const label = name ?? platform?.name ?? slug ?? ''
  // An emulation system with a logo: the logo on a light plate (the logos are made for a light background).
  const logo = systemLogo(
    platform ? (platform.kind === 'system' ? platform.id : undefined) : systemId
  )
  if (logo) {
    const height =
      size === 'sm'
        ? 'var(--icon-md)'
        : size === 'lg'
          ? '4.8rem'
          : size === 'md'
            ? 'var(--badge-size)'
            : size
    return (
      <span
        className={cx('badge', 'badge--logo', className)}
        style={{ '--plate-h': height, ...style } as CSSProperties}
        role="img"
        aria-label={label}
        title={label}
      >
        <img className="badge__logo" src={logo} alt="" draggable={false} />
      </span>
    )
  }
  const glyph = badgeGlyph(slug, label)
  const preset = size === 'sm' || size === 'md' || size === 'lg'
  const inlineStyle: CSSProperties = {
    background: badgeColor(slug, glyph),
    ...(preset ? {} : { width: size, height: size }),
    ...style
  }
  return (
    <span
      className={cx('badge', preset && size !== 'md' && `badge--${size}`, className)}
      style={inlineStyle}
      role="img"
      aria-label={label}
      title={label}
    >
      {renderGlyph(glyph)}
    </span>
  )
})

function renderGlyph(glyph: BadgeGlyph): ReactElement {
  switch (glyph.kind) {
    case 'simple':
      return (
        <svg className="badge__glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d={glyph.path} />
        </svg>
      )
    case 'lucide': {
      const Icon = glyph.Icon
      return (
        <Icon
          className="badge__glyph"
          style={{ fill: 'none' }}
          strokeWidth={2.25}
          aria-hidden="true"
        />
      )
    }
    case 'xbox':
      // Original mark: two rounded strokes crossing inside a ring (not the trademarked sphere logo).
      return (
        <svg
          className="badge__glyph"
          viewBox="0 0 24 24"
          aria-hidden="true"
          style={{ fill: 'none' }}
        >
          <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.6" opacity="0.55" />
          <path
            d="M7.5 7.5 16.5 16.5M16.5 7.5 7.5 16.5"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'nintendo':
      // Original mark: a bold N on the disc, the same chrome as every other badge (no Nintendo logo).
      return (
        <svg className="badge__glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 19V5h3l6 9V5h3v14h-3L9 10v9Z" fill="currentColor" />
        </svg>
      )
    case 'letter':
      return <span className="badge__letter">{glyph.letter}</span>
  }
}

/**
 * The Recomp badge: stands in for the platform's badge on a game played from its recompilation (shared/recomp-play
 * recompToPlay): the UP mark recompilations have on the game page, on the accent colour, in the same round chrome.
 */
export function RecompBadge({
  size = 'md',
  className
}: {
  size?: 'sm' | 'md' | 'lg' | string
  className?: string
}): ReactElement {
  const t = useT()
  const preset = size === 'sm' || size === 'md' || size === 'lg'
  return (
    <span
      className={cx(
        'badge',
        'badge--recomp',
        preset && size !== 'md' && `badge--${size}`,
        className
      )}
      style={preset ? undefined : { width: size, height: size }}
      role="img"
      aria-label={t('components.recompBadge.label')}
      title={t('components.recompBadge.title')}
    >
      <ArrowBigUp
        className="badge__glyph"
        style={{ fill: 'none' }}
        strokeWidth={2.25}
        aria-hidden="true"
      />
    </span>
  )
}
