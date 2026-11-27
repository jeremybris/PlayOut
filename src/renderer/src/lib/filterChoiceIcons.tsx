import { isDifficultyId, isToolsDifficulty } from '@shared/difficulty'
import {
  ArrowBigUp,
  EyeClosed,
  Globe,
  Handshake,
  Heart,
  HeartHandshake,
  Network,
  PartyPopper,
  Sword,
  Swords,
  Trophy,
  Users,
  type LucideIcon
} from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { ConsoleIcon } from '../components/ConsoleIcon'
import { ControlsIcon } from '../components/ControlsIcon'
import { DifficultyIcon } from '../components/DifficultyIcon'
import { EraIcon } from '../components/EraIcon'
import { GENRE_LINE_ICONS, GenreIcon } from '../components/GenreIcon'
import { HltbClock } from '../components/HltbClock'
import { PlayersArt } from '../components/PlayersArt'
import { ReviewStarIcon } from '../components/ReviewStarIcon'
import { SizePie } from '../components/SizePie'
import { StoreIcon } from '../components/StoreIcon'
import { consoleIcon } from './consoleIcons'
import { CONTROLS_FILTERS } from './controls'
import { CustomFilterIconView } from './customFilterIcons'
import { difficultyIcon } from './difficultyIcons'
import { eraIcon } from './eraIcons'
import { genrePicture } from './genrePictures'
import {
  CONTROLS_COLORS,
  GENRE_COLORS,
  HIDDEN_COLOR,
  LOCAL_COLORS,
  ONLINE_COLORS
} from './filterColors'
import { HLTB_BUCKETS } from './hltb'
import { SIZE_BUCKETS } from './installSize'
import type { TabNamePart } from './libraryTabs'
import { LAN_PARTY, LOCAL_LENGTH_CHOICES, PLAYER_BANDS } from './localMultiplayer'
import { REVIEW_BANDS } from './reviews'
import { OTHER_PC, STORE_FILTERS } from './storeFilters'

/**
 * The icon of each Filters choice, as the Filters sub-menus draw it before the choice's name (Library/FiltersPill.tsx)
 * and the Library's tabs draw it in place of the choice's words while Settings > Library "Icons for tabs" is on
 * (Library/TabStrip.tsx). Each returns null for a choice without an icon (an "All …" choice, a genre without a
 * picture), which then keeps its words.
 */

/** Filters > Local Multiplayer's Nucleus Co-Op choice (a tab's `coop`), at the bottom of its sub-menu. */
export const COOP_CHOICE = 'nucleus-coop'

/** Online Multiplayer's choices' icons ("All Online Multiplayer" has none, like every sub-menu's All). */
const onlineIcons: Readonly<Partial<Record<string, LucideIcon>>> = {
  pvp: Swords,
  coop: Handshake,
  esports: Trophy,
  mmo: Globe,
  versus: Sword,
  team: Users
}

/** Local Multiplayer's length choices' icons: a party for Party Games, a heart handshake for S.O. Games. */
const localLengthIcons: Readonly<Partial<Record<string, LucideIcon>>> = {
  party: PartyPopper,
  so: HeartHandshake
}

/** A line icon in the box Platform's console pictures use, so the sub-menu's names line up, in its colour. */
export function menuIcon(Icon: LucideIcon, color?: string): ReactElement {
  return (
    <span className="console-icon" aria-hidden="true" style={color ? { color } : undefined}>
      <Icon className="console-icon__generic" />
    </span>
  )
}

/** An icon drawn in the text colour, in `color` instead (lib/filterColors.ts); `display: contents` adds no box. */
export function tinted(icon: ReactNode, color: string | undefined): ReactNode {
  return color ? (
    <span className="filters-menu__tint" style={{ color }}>
      {icon}
    </span>
  ) : (
    icon
  )
}

/**
 * Filters > Platform below the line: a store's badge, or Other's PC badge. "All Stores" has none, and neither has an
 * id that is no longer a store (StoreIcon would draw it as a PC badge, which would not say which one it is).
 */
export function storeChoiceIcon(id: string): ReactNode {
  return id === OTHER_PC || STORE_FILTERS.some((f) => f.id === id) ? (
    <StoreIcon storeId={id} />
  ) : null
}

/**
 * Filters > Platform above the line: a system's console picture. The sub-menu draws a plain controller for a system
 * without one (ConsoleIcon); here that is no icon, as a controller would not say which system it is.
 */
export function platformChoiceIcon(id: string): ReactNode {
  return consoleIcon(id) ? <ConsoleIcon systemId={id} /> : null
}

/** Filters > Genre: its picture in its colour; none for a genre without one. */
export function genreChoiceIcon(id: string): ReactNode {
  return GENRE_LINE_ICONS[id] || genrePicture(id)
    ? tinted(<GenreIcon genreId={id} />, GENRE_COLORS[id])
    : null
}

/** Filters > Release: an era's picture. */
export function eraChoiceIcon(id: string): ReactNode {
  return eraIcon(id) ? <EraIcon eraId={id} /> : null
}

/** Filters > Size: the band's pie, more filled and bigger as the band grows. */
export function sizeChoiceIcon(id: string): ReactNode {
  const i = SIZE_BUCKETS.findIndex((b) => b.id === id)
  return i < 0 ? null : <SizePie step={i + 1} steps={SIZE_BUCKETS.length} colored />
}

/** Filters > H.L.T.B.: the band's stopwatch with its red slice. */
export function hltbChoiceIcon(id: string): ReactNode {
  const i = HLTB_BUCKETS.findIndex((b) => b.id === id)
  return i < 0 ? null : <HltbClock step={i + 1} steps={HLTB_BUCKETS.length} redSlice />
}

/** Filters > Difficulty: the level's picture. */
export function difficultyChoiceIcon(id: string): ReactNode {
  return isDifficultyId(id) && !isToolsDifficulty(id) && difficultyIcon(id) ? (
    <DifficultyIcon difficultyId={id} />
  ) : null
}

/** Filters > Reviews: the band's gold star, full for the best band. */
export function reviewChoiceIcon(id: string): ReactNode {
  const i = REVIEW_BANDS.findIndex((b) => b.id === id)
  return i < 0 ? null : (
    <ReviewStarIcon step={REVIEW_BANDS.length - i} steps={REVIEW_BANDS.length} gold />
  )
}

/** Filters > Controls: the choice's picture in its colour. */
export function controlsChoiceIcon(id: string): ReactNode {
  return CONTROLS_FILTERS.some((c) => c.id === id)
    ? tinted(<ControlsIcon controlsId={id} />, CONTROLS_COLORS[id])
    : null
}

/**
 * Filters > Local Multiplayer: a length's icon, PeerParty's network, a player count's controller with its number, or
 * Nucleus Co-Op's people (COOP_CHOICE), each in its colour ("All Local Multiplayer" has none).
 */
export function localChoiceIcon(id: string): ReactNode {
  const length = LOCAL_LENGTH_CHOICES.some((c) => c.id === id) ? localLengthIcons[id] : undefined
  if (length) return menuIcon(length, LOCAL_COLORS[id])
  if (id === LAN_PARTY.id) return menuIcon(Network, LOCAL_COLORS[id])
  if (id === COOP_CHOICE) return menuIcon(Users, LOCAL_COLORS[id])
  const band = PLAYER_BANDS.find((b) => b.id === id)
  return band ? (
    <span className="console-icon" aria-hidden="true" style={{ color: LOCAL_COLORS[band.id] }}>
      <PlayersArt count={band.badge} />
    </span>
  ) : null
}

/** Filters > Online Multiplayer: the choice's icon in its colour. */
export function onlineChoiceIcon(id: string): ReactNode {
  const Icon = onlineIcons[id]
  return Icon ? menuIcon(Icon, ONLINE_COLORS[id]) : null
}

/** Filters > Custom: one of the user's filters' icon in its own colour. */
export function customChoiceIcon(icon: string): ReactElement {
  return (
    <span className="console-icon" aria-hidden="true">
      <CustomFilterIconView icon={icon} className="console-icon__generic" />
    </span>
  )
}

/** Filters > Hidden: a closed eye, the games kept out of sight. */
export function hiddenIcon(className: string): ReactElement {
  return <EyeClosed className={className} style={{ color: HIDDEN_COLOR }} aria-hidden="true" />
}

/** Filters > Favorites: the game page's heart in red, filled while the filter is on. */
export function favoritesIcon(className: string, on: boolean): ReactElement {
  return (
    <Heart
      className={`${className} filters-menu__icon--favorite`}
      fill={on ? 'currentColor' : 'none'}
      aria-hidden="true"
    />
  )
}

/** Filters > Recompilations: the recompilation mark (the UP button beside Play), filled while the filter is on. */
export function recompIcon(className: string, on: boolean): ReactElement {
  return (
    <ArrowBigUp
      className={`${className} filters-menu__icon--recomp`}
      fill={on ? 'currentColor' : 'none'}
      aria-hidden="true"
    />
  )
}

/** The class of a Hidden / Favorites / Recompilations icon in a tab, in the box the other choices' icons use. */
const TAB_FLAG_ICON = 'console-icon__generic library__tab-flag'

/**
 * A tab's choice's icon (lib/libraryTabs.ts tabNameGroups): the icon its Filters sub-menu shows for it, or null when it
 * has none (a developer, a publisher, an "All …" choice, a genre without a picture), which keeps its words.
 * `customIcon` gives a custom filter's icon by its id.
 */
export function tabPartIcon(
  part: TabNamePart,
  customIcon: (id: string) => string | undefined = () => undefined
): ReactNode {
  switch (part.kind) {
    case 'platform':
      return platformChoiceIcon(part.id)
    case 'store':
      return storeChoiceIcon(part.id)
    case 'era':
      return eraChoiceIcon(part.id)
    case 'genre':
      return genreChoiceIcon(part.id)
    case 'size':
      return sizeChoiceIcon(part.id)
    case 'hltb':
      return hltbChoiceIcon(part.id)
    case 'difficulty':
      return difficultyChoiceIcon(part.id)
    case 'reviews':
      return reviewChoiceIcon(part.id)
    case 'controls':
      return controlsChoiceIcon(part.id)
    case 'players':
      return localChoiceIcon(part.id)
    case 'online':
      return onlineChoiceIcon(part.id)
    case 'coop':
      return localChoiceIcon(COOP_CHOICE)
    case 'custom': {
      const icon = customIcon(part.id)
      return icon ? customChoiceIcon(icon) : null
    }
    case 'hidden':
      return (
        <span className="console-icon" aria-hidden="true">
          {hiddenIcon(TAB_FLAG_ICON)}
        </span>
      )
    case 'favorites':
      return (
        <span className="console-icon" aria-hidden="true">
          {favoritesIcon(TAB_FLAG_ICON, true)}
        </span>
      )
    case 'recomp':
      return (
        <span className="console-icon" aria-hidden="true">
          {recompIcon(TAB_FLAG_ICON, true)}
        </span>
      )
    default:
      // genreName (a genre name saved before 0.1.185), developer, publisher: words only.
      return null
  }
}
