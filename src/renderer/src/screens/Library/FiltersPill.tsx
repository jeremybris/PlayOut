import { DIFFICULTIES, difficultyLabel } from '@shared/difficulty'
import {
  ArrowBigUp,
  Check,
  ChevronDown,
  ChevronLeft,
  EyeClosed,
  Globe,
  Handshake,
  Heart,
  HeartHandshake,
  Network,
  Palette,
  PartyPopper,
  Pencil,
  Sword,
  Swords,
  Trash2,
  Trophy,
  Users,
  X,
  type LucideIcon
} from 'lucide-react'
import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Menu, MenuItem } from '../../components/MenuItem'
import { LayerContext, useActionHandlersOnLayer } from '../../hooks/useActionHandlers'
import { useFocusLayer } from '../../hooks/useFocusLayer'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useLanguage, useT, type Translate } from '../../i18n'
import { FocusContext, doesFocusableExist, getCurrentFocusKey, setFocus } from '../../input/focus'
import { cx } from '../../lib/cx'
import { HLTB_BUCKETS } from '../../lib/hltb'
import { CONTROLS_FILTERS, controlsFilterLabel } from '../../lib/controls'
import {
  LOCAL_ALL,
  LAN_PARTY,
  LOCAL_LENGTH_CHOICES,
  localMultiplayerLabel,
  PLAYER_BANDS
} from '../../lib/localMultiplayer'
import { ONLINE_CHOICES, onlineMultiplayerLabel } from '../../lib/onlineMultiplayer'
import {
  CONTROLS_COLORS,
  GENRE_COLORS,
  HIDDEN_COLOR,
  LOCAL_COLORS,
  ONLINE_COLORS
} from '../../lib/filterColors'
import { ConsoleIcon } from '../../components/ConsoleIcon'
import { ControlsIcon } from '../../components/ControlsIcon'
import { DifficultyIcon } from '../../components/DifficultyIcon'
import { EraIcon } from '../../components/EraIcon'
import { GenreIcon } from '../../components/GenreIcon'
import { HltbClock } from '../../components/HltbClock'
import { ReviewStarIcon } from '../../components/ReviewStarIcon'
import { SizePie } from '../../components/SizePie'
import { StoreIcon } from '../../components/StoreIcon'
import { PlayersArt } from '../../components/PlayersArt'
import { SIZE_BUCKETS } from '../../lib/installSize'
import { REVIEW_BANDS, reviewBandLabel } from '../../lib/reviews'
import { clearableChoices, withoutChoice, type ClearableChoice } from '../../lib/libraryTabs'
import {
  MAX_FILTER_CHOICES,
  filterChoiceCount,
  limitedChoiceCount,
  toggleChoice
} from '../../lib/libraryView'
import { registerPopupOpener } from '../../lib/popupOpeners'
import { customFilterNames, knownCustomIds } from '../../lib/customFilters'
import { CustomFilterIconView } from '../../lib/customFilterIcons'
import {
  confirmDeleteCustomFilter,
  openEditCustomFilter,
  useCustomFilters
} from '../../state/customFilters'
import type { CustomFilter } from '@shared/types'
import { tagFilterLabel, type TagFilter } from '../../lib/steamTags'
import { releaseEraLabel, type ReleaseEra } from '../../lib/releaseEras'
import {
  ALL_STORES,
  ALL_STORES_LABEL,
  pickStore,
  storeFilterLabel,
  type StoreFilter
} from '../../lib/storeFilters'
import {
  ALL_ROM_PLATFORMS,
  ALL_ROM_PLATFORMS_LABEL,
  pickPlatform,
  type PlatformFilter
} from '../../lib/platformFilters'
import { CATEGORY_KEY } from './keys'

/** Gap between the pill, the menu and the sub-menu, and the sub-menu's distance from the window edge, in px at 1080p. */
const GAP_U = 8

/**
 * A sub-menu's first option ("All Genres", "All Dates", "All Tags", "All Sizes", "All Times"): clears
 * the list.
 */
const ALL = '*all'

function unit(): number {
  return window.innerHeight / 1080
}

export interface FiltersPillProps {
  /**
   * The pill's focus key, and the base of its menus' keys: CATEGORY_KEY (the default) in the Library header, where RT
   * opens it; another per tab in Settings > Library.
   */
  focusKey?: string
  /** Filters > Platform: platform ids picked (consoles and other systems); empty = every platform. */
  platforms: readonly string[]
  /** The platforms the sub-menu lists: those with games (none: the row is not shown). */
  platformOptions: readonly PlatformFilter[]
  onPlatforms: (platforms: string[]) => void
  /** Filters > Release: the RELEASE_ERAS ids picked (a game released in any of them shows); empty = every year. */
  eras: readonly string[]
  /** The eras the sub-menu lists: those some game in the list was released in (none: the row is not shown). */
  eraOptions: readonly ReleaseEra[]
  onEras: (eras: string[]) => void
  /** Filters > Tags: the TAG_FILTERS ids picked (a game with any of them shows); empty = every game. */
  tags: readonly string[]
  /** The tags the sub-menu lists: those some game in the list has. */
  tagOptions: readonly TagFilter[]
  onTags: (tags: string[]) => void
  /** Filters > Platform, below the line: the stores picked (source ids; a card with a copy from any of them shows); empty = every store. */
  stores: readonly string[]
  /** The stores the sub-menu lists: those with games in the list (none: Platform lists no stores and no line). */
  storeOptions: readonly StoreFilter[]
  onStores: (stores: string[]) => void
  /** Filters > Size: the SIZE_BUCKETS ids picked; empty = all sizes. */
  sizes: readonly string[]
  onSizes: (sizes: string[]) => void
  /** Filters > H.L.T.B.: the HLTB_BUCKETS ids picked; empty = all times. */
  hltb: readonly string[]
  onHltb: (hltb: string[]) => void
  /** Filters > Difficulty: the levels picked (shared/difficulty.ts); empty = every level. */
  difficulty: readonly string[]
  onDifficulty: (difficulty: string[]) => void
  /** Filters > Reviews: the REVIEW_BANDS ids picked (lib/reviews.ts); empty = every game. */
  reviews: readonly string[]
  onReviews: (reviews: string[]) => void
  /** Filters > Controls: the CONTROLS_FILTERS ids picked (VR, Controller, Mouse and Keyboard); empty = any. */
  controls: readonly string[]
  /**
   * The Controls choices some game in the list falls under (lib/controls.ts libraryControlsFilters): only they, and any
   * picked, are offered; "All Controls" always is.
   */
  controlsOptions: readonly string[]
  onControls: (controls: string[]) => void
  /**
   * Filters > Local Multiplayer: 'local-all' and player counts (lib/localMultiplayer.ts); with `coop` (its Nucleus
   * Co-Op choice) a game matching any of them shows.
   */
  players: readonly string[]
  onPlayers: (players: string[]) => void
  /** Filters > Online Multiplayer: 'online-all', 'coop', 'pvp' (lib/onlineMultiplayer.ts); empty = any. */
  online: readonly string[]
  onOnline: (online: string[]) => void
  hidden: boolean
  onHidden: (hidden: boolean) => void
  hiddenCount: number
  favorites: boolean
  onFavorites: (favorites: boolean) => void
  favoriteCount: number
  /** Filters > Nucleus Co-Op: only games with a Co-Op handler (split-screen through Nucleus Co-op). */
  coop: boolean
  onCoop: (coop: boolean) => void
  /** Filters > Recompilations: only games with a recompilation available (the UP button beside Play). */
  recomp: boolean
  onRecomp: (recomp: boolean) => void
  recompCount: number
  /** The developers a game page's button added (a game by any of them shows); not a row of their own. */
  developers: readonly string[]
  onDevelopers: (developers: string[]) => void
  /** The publishers a game page's button added, as `developers`. */
  publishers: readonly string[]
  onPublishers: (publishers: string[]) => void
  /**
   * Filters > Custom: the user's filters picked (settings.library.customFilters ids; a game in any of them shows); the
   * row is there only while the user has a filter.
   */
  custom: readonly string[]
  onCustom: (custom: string[]) => void
  /** How many of this list's cards each filter holds (by filter id); absent: its games' number. */
  customCounts?: ReadonlyMap<string, number>
  /**
   * The menu's Clear filters (shown while any choice is on), or its sub-menu's All (with a developer, publisher or
   * genre on): turns every choice off, developers and publishers included.
   */
  onClearFilters: () => void
}

/** The sub-menus a row of the Filters menu opens with its left arrow. */
type SubMenuKind =
  | 'clear'
  | 'platform'
  | 'genre'
  | 'era'
  | 'size'
  | 'hltb'
  | 'difficulty'
  | 'reviews'
  | 'controls'
  | 'players'
  | 'online'
  | 'custom'

interface Option {
  value: string
  label: string
  /** Shown in place of the label's words (Local Multiplayer's player counts). */
  art?: ReactNode
  /** Shown before the label (Platform's console pictures). */
  icon?: ReactNode
  /** A line between two parts of the list (Platform's systems and stores), not a choice: never focused. */
  separator?: boolean
}

/** Filters > Platform's store choices' values: prefixed, as a store and a system can share an id (Xbox). */
const STORE_PREFIX = 'store:'

/** The line between Filters > Platform's systems and its stores. */
const SEPARATOR_OPTION: Option = { value: '--separator', label: '', separator: true }

/** Its Nucleus Co-Op choice (the tab's `coop`), at the bottom of the Local Multiplayer sub-menu. */
const COOP_CHOICE = 'nucleus-coop'

/** Online Multiplayer's choices' icons ("All Online Multiplayer" has none, like every sub-menu's All). */
const ONLINE_ICONS: Readonly<Partial<Record<string, LucideIcon>>> = {
  pvp: Swords,
  coop: Handshake,
  esports: Trophy,
  mmo: Globe,
  versus: Sword,
  team: Users
}

const ONLINE_OPTIONS: readonly Option[] = ONLINE_CHOICES.map((c) => {
  const Icon = ONLINE_ICONS[c.id]
  return {
    value: c.id,
    label: c.label,
    icon: Icon ? menuIcon(Icon, ONLINE_COLORS[c.id]) : undefined
  }
})

/** A line icon in the box Platform's console pictures use, so the sub-menu's names line up, in its colour. */
function menuIcon(Icon: LucideIcon, color?: string): ReactNode {
  return (
    <span className="console-icon" aria-hidden="true" style={color ? { color } : undefined}>
      <Icon className="console-icon__generic" />
    </span>
  )
}

/** Local Multiplayer's length choices' icons: a party for Party Games, a heart handshake for S.O. Games. */
const LOCAL_LENGTH_ICONS: Readonly<Record<string, LucideIcon>> = {
  party: PartyPopper,
  so: HeartHandshake
}

/** An icon drawn in the text colour, in `color` instead (lib/filterColors.ts); `display: contents` adds no box. */
function tinted(icon: ReactNode, color: string | undefined): ReactNode {
  return color ? (
    <span className="filters-menu__tint" style={{ color }}>
      {icon}
    </span>
  ) : (
    icon
  )
}

/*
 * The sub-menus' option lists below are functions of `t`, not constants: their "All …" rows are translated, and a
 * constant would keep the language of the moment the module loaded (FiltersMenu builds them per language).
 */

const playersOptions = (t: Translate): readonly Option[] => [
  { value: LOCAL_ALL, label: t('library.filters.allLocalMultiplayer') },
  // All Local Multiplayer of a length: Party Games (0-10 hours), then S.O. Games (10 hours and more).
  ...LOCAL_LENGTH_CHOICES.map((choice) => ({
    value: choice.id,
    label: choice.label,
    icon: menuIcon(LOCAL_LENGTH_ICONS[choice.id]!, LOCAL_COLORS[choice.id])
  })),
  // The games PeerParty is offered for, with the game page's PeerParty square's icon.
  {
    value: LAN_PARTY.id,
    label: LAN_PARTY.label,
    icon: menuIcon(Network, LOCAL_COLORS[LAN_PARTY.id])
  },
  // The player counts: their picture (a controller with the number) as the icon, then the words ("2-4 Players").
  ...PLAYER_BANDS.map((band) => ({
    value: band.id,
    label: band.label,
    icon: (
      <span className="console-icon" aria-hidden="true" style={{ color: LOCAL_COLORS[band.id] }}>
        <PlayersArt count={band.badge} />
      </span>
    )
  })),
  // With the game page's Co-Op square's icon.
  {
    value: COOP_CHOICE,
    label: t('library.filters.nucleusCoop'),
    icon: menuIcon(Users, LOCAL_COLORS[COOP_CHOICE])
  }
]

const sizeOptions = (t: Translate): readonly Option[] => [
  { value: ALL, label: t('library.filters.allSizes') },
  // Each band with its pie ("All Sizes" has none): more filled and bigger as the band grows.
  ...SIZE_BUCKETS.map((bucket, i) => ({
    value: bucket.id,
    label: bucket.label,
    icon: <SizePie step={i + 1} steps={SIZE_BUCKETS.length} colored />
  }))
]

/**
 * Filters > Controls: "All Controls", then each choice with games (`available`) or picked (so it can be un-picked), in
 * the menu's order, with its picture ("All Controls" has none).
 */
const controlsOptions = (
  t: Translate,
  available: readonly string[],
  picked: readonly string[]
): readonly Option[] => [
  { value: ALL, label: t('library.filters.allControls') },
  ...CONTROLS_FILTERS.filter((c) => available.includes(c.id) || picked.includes(c.id)).map((c) => ({
    value: c.id,
    label: c.label,
    icon: tinted(<ControlsIcon controlsId={c.id} />, CONTROLS_COLORS[c.id])
  }))
]

const hltbOptions = (t: Translate): readonly Option[] => [
  { value: ALL, label: t('library.filters.allTimes') },
  // Each band with its stopwatch ("All Times" has none): more filled and bigger as the band grows.
  ...HLTB_BUCKETS.map((bucket, i) => ({
    value: bucket.id,
    label: bucket.label,
    icon: <HltbClock step={i + 1} steps={HLTB_BUCKETS.length} redSlice />
  }))
]

const difficultyOptions = (t: Translate): readonly Option[] => [
  { value: ALL, label: t('library.filters.allDifficulties') },
  // Each level with its picture, easiest first ("All Difficulties" has none).
  ...DIFFICULTIES.map((d) => ({
    value: d.id,
    label: d.label,
    icon: <DifficultyIcon difficultyId={d.id} />
  }))
]

const reviewsOptions = (t: Translate): readonly Option[] => [
  { value: ALL, label: t('library.filters.allReviews') },
  // Each band with its star, best first ("All Reviews" has none): full and brightest gold for 95-100, a dim sliver for 0-40.
  ...REVIEW_BANDS.map((band, i) => ({
    value: band.id,
    label: band.label,
    icon: <ReviewStarIcon step={REVIEW_BANDS.length - i} steps={REVIEW_BANDS.length} gold />
  }))
]

/**
 * The Library header's Filters pill. Its menu has Genre, Release, Tags, Platform, Size, H.L.T.B. (HowLongToBeat)
 * and Difficulty rows, whose left arrows open a sub-menu (the genres; the release-year ranges with games; the chosen
 * Steam tags; the systems, then the stores, with games; the install size bands; the time-to-beat bands; the difficulty levels) to the left of the menu (the pill
 * sits at the right of the header), a Hidden row that toggles the list of hidden games, and a Favorites row that
 * keeps only favourite games. A sub-menu takes several choices (a game matching any of them shows; different filters
 * narrow together), up to MAX_FILTER_CHOICES across the whole menu (Hidden and Favorites count; a game page's
 * developers and publishers do not, though the pill's number has them). Picking a choice
 * again turns it off. Clear filters (first, while any choice is on) turns them all off; with a developer, publisher
 * or genre on, it opens a sub-menu instead: All, then one row per developer, publisher and genre, each turning only
 * itself off. The menu stays open while choices are picked: B / Escape steps back one level, and the menu
 * closes on RT (the controller's filter button) or a click outside. Each menu is its own focus and action layer.
 */
export const FiltersPill = memo(function FiltersPill(props: FiltersPillProps): ReactElement {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  // Where focus goes back to on close: the pill, or the card RT opened the menu from.
  const baseKey = props.focusKey ?? CATEGORY_KEY
  const returnTo = useRef<string>(baseKey)
  const { ref, props: controlProps } = useFocusableControl<HTMLDivElement>({
    focusKey: baseKey,
    onPress: () => {
      returnTo.current = baseKey
      setAnchor(ref.current)
    }
  })
  // RT in the Library (lib/popupOpeners.ts) opens the header's menu over the focused card, which gets focus back after.
  useEffect(() => {
    if (baseKey !== CATEGORY_KEY) return undefined
    return registerPopupOpener(CATEGORY_KEY, () => {
      returnTo.current = getCurrentFocusKey() ?? CATEGORY_KEY
      setAnchor(ref.current)
    })
  }, [ref, baseKey])
  // Only the user's filters this PC has count (a tab synced from another PC may name others).
  const customFilters = useCustomFilters()
  const active = filterChoiceCount({
    ...props,
    custom: knownCustomIds(customFilters, props.custom)
  })
  const close = (): void => {
    setAnchor(null)
    const target = returnTo.current
    // Past the commit that removes the menus: the sub-menu's own restore target has gone with them. A card
    // that left the grid with the new filters falls back to the pill.
    setTimeout(() => void setFocus(doesFocusableExist(target) ? target : baseKey), 0)
  }
  return (
    <>
      <div
        ref={ref}
        className="select select--pill library__select library__select--category"
        role="group"
        aria-label={t('library.filters.pill')}
        aria-expanded={anchor !== null}
        title={t('library.filters.pill')}
        {...controlProps}
      >
        <span className="select__value" aria-live="polite">
          {active ? t('library.filters.pillCount', { n: active }) : t('library.filters.pill')}
        </span>
        <span className="select__chevron" aria-hidden="true">
          <ChevronDown />
        </span>
      </div>
      {anchor ? <FiltersMenu {...props} anchor={anchor} onClose={close} /> : null}
    </>
  )
})

interface FiltersMenuProps extends FiltersPillProps {
  anchor: HTMLElement
  onClose: () => void
}

/** The Filters menu's sub-menu rows (the keys of their sub-menus). */
type FilterRow =
  | 'genre'
  | 'era'
  | 'platform'
  | 'size'
  | 'hltb'
  | 'difficulty'
  | 'reviews'
  | 'controls'
  | 'players'
  | 'online'
  | 'custom'

/** The rows that are shown, in alphabetical order of their names in `language` ("H.L.T.B." sorts as "HLTB"). */
function sortedFilterRows(
  rows: readonly (readonly [FilterRow, string, boolean])[],
  language: string
): FilterRow[] {
  const key = (label: string): string => label.replace(/[^\p{L}\p{N}\s-]/gu, '')
  return rows
    .filter(([, , shown]) => shown)
    .sort(([, a], [, b]) => key(a).localeCompare(key(b), language, { sensitivity: 'base' }))
    .map(([row]) => row)
}

/** "Action", or "Action +2" when several are picked; null when none is. */
function pickedText(
  t: Translate,
  picked: readonly string[],
  labelOf: (value: string) => string
): string | null {
  if (picked.length === 0) return null
  const first = labelOf(picked[0]!)
  return picked.length === 1
    ? first
    : t('library.filters.picked', { first, more: picked.length - 1 })
}

function FiltersMenu(props: FiltersMenuProps): ReactElement {
  const {
    anchor,
    platforms,
    platformOptions,
    onPlatforms,
    eras,
    eraOptions,
    onEras,
    tags,
    tagOptions,
    onTags,
    stores,
    storeOptions,
    onStores,
    sizes,
    onSizes,
    hltb,
    onHltb,
    difficulty,
    onDifficulty,
    reviews,
    onReviews,
    controls,
    controlsOptions: controlsAvailable,
    onControls,
    players,
    onPlayers,
    online,
    onOnline,
    hidden,
    onHidden,
    hiddenCount,
    favorites,
    onFavorites,
    favoriteCount,
    coop,
    onCoop,
    recomp,
    onRecomp,
    recompCount,
    developers,
    onDevelopers,
    publishers,
    onPublishers,
    custom,
    onCustom,
    customCounts,
    onClearFilters,
    onClose
  } = props
  const t = useT()
  const customFilters = useCustomFilters()
  const customPicked = useMemo(() => knownCustomIds(customFilters, custom), [customFilters, custom])
  const customName = useMemo(() => customFilterNames(customFilters), [customFilters])
  const language = useLanguage()
  // The sub-menu rows, in alphabetical order of their names in the language shown (the sub-menus keep their own
  // order); Clear filters stays first and Hidden, Favorites and Recompilations stay at the bottom.
  const rowOrder = useMemo(() => {
    const rows: [FilterRow, string, boolean][] = [
      ['genre', t('library.filters.genre'), true],
      ['era', t('library.filters.release'), eraOptions.length > 0 || eras.length > 0],
      [
        'platform',
        t('library.filters.platform'),
        platformOptions.length > 0 ||
          platforms.length > 0 ||
          storeOptions.length > 0 ||
          stores.length > 0
      ],
      ['size', t('library.filters.size'), true],
      ['hltb', t('library.filters.hltb'), true],
      ['difficulty', t('library.filters.difficulty'), true],
      ['reviews', t('library.filters.reviews'), true],
      ['controls', t('library.filters.controls'), true],
      ['players', t('library.filters.localMultiplayer'), true],
      ['online', t('library.filters.onlineMultiplayer'), true],
      ['custom', t('library.filters.custom'), customFilters.length > 0]
    ]
    return sortedFilterRows(rows, language)
  }, [
    t,
    language,
    eraOptions,
    eras,
    platformOptions,
    platforms,
    storeOptions,
    stores,
    customFilters
  ])
  const firstRow = rowOrder[0] ?? 'genre'
  const firstRowRef = useRef(firstRow)
  useEffect(() => {
    firstRowRef.current = firstRow
  }, [firstRow])
  const options = useMemo(
    () => ({
      players: playersOptions(t),
      size: sizeOptions(t),
      hltb: hltbOptions(t),
      difficulty: difficultyOptions(t),
      reviews: reviewsOptions(t)
    }),
    [t]
  )
  const controlsMenu = useMemo(
    () => controlsOptions(t, controlsAvailable, controls),
    [t, controlsAvailable, controls]
  )
  const baseKey = props.focusKey ?? CATEGORY_KEY
  const focusKey = `${baseKey}:menu`
  // Opens on Genre, not on the X above it: A right after opening must not clear everything.
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey,
    preferredChildFocusKey: `${focusKey}:${firstRow}`
  })
  useActionHandlersOnLayer(layerId, {
    back: () => {
      onClose()
      return true
    },
    // RT, which opened the menu, closes it again.
    rt: () => {
      onClose()
      return true
    }
  })
  /** The open sub-menu and its position. */
  /**
   * `clearing`: the X (or Clear filters > All) was pressed with this sub-menu open; it closes next without handing
   * focus back. `leaving`: it closes next without handing focus back, and focus goes to this row of the menu instead
   * (Clear filters' last developer, publisher or genre removed).
   */
  const [sub, setSub] = useState<{
    kind: SubMenuKind
    style: CSSProperties
    clearing?: boolean
    leaving?: string
  } | null>(null)
  // The X pressed: every choice goes, the X with them, and Genre (the first row) takes focus after that commit. With a
  // sub-menu open, it is first re-rendered with restoreFocus off and closed in the next commit: its own restore to
  // the row that opened it would otherwise move focus a second time (and leave that row drawn as focused).
  const [clearedFocus, setClearedFocus] = useState(0)
  const clearAll = (): void => {
    onClearFilters()
    setClearedFocus((n) => n + 1)
  }
  const clearAllRef = useRef(clearAll)
  useEffect(() => {
    clearAllRef.current = clearAll
  })
  const clearingSub = sub?.clearing === true
  useEffect(() => {
    if (!clearingSub) return undefined
    // After the commit that turned the sub-menu's restore off (its layer reads the option as it closes).
    const timer = setTimeout(() => {
      setSub(null)
      clearAllRef.current()
    }, 0)
    return () => clearTimeout(timer)
  }, [clearingSub])
  useEffect(() => {
    if (!clearedFocus) return undefined
    // The first row as it is when the focus moves (a ref: the effect runs only when a clear asks for it).
    const timer = setTimeout(() => void setFocus(`${focusKey}:${firstRowRef.current}`), 0)
    return () => clearTimeout(timer)
  }, [clearedFocus, focusKey])
  const leavingTo = sub?.leaving
  useEffect(() => {
    if (!leavingTo) return undefined
    // As for clearing: after the commit that turned the sub-menu's restore off, it closes and focus goes to the row.
    const timer = setTimeout(() => {
      setSub(null)
      setTimeout(() => void setFocus(leavingTo), 0)
    }, 0)
    return () => clearTimeout(timer)
  }, [leavingTo])
  const closeSub = (): void => setSub(null)
  const openSub = (kind: SubMenuKind): void => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const gap = GAP_U * unit()
    setSub({
      kind,
      style: {
        right: Math.round(window.innerWidth - rect.left + gap),
        top: Math.round(rect.top),
        maxHeight: Math.round(window.innerHeight - rect.top - gap)
      }
    })
  }

  const [position, setPosition] = useState(() => placeMenu(anchor))
  useEffect(() => {
    const update = (): void => {
      setPosition(placeMenu(anchor))
      setSub(null)
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchor])

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.target === event.currentTarget) onClose()
  }

  // Every choice on (developers and publishers included: Clear filters shows for a developer-only tab); only the
  // Filters menu's own choices count toward MAX_FILTER_CHOICES, as before developers and publishers were lists.
  const counted = { ...props, custom: customPicked }
  const active = filterChoiceCount(counted)
  const full = limitedChoiceCount(counted) >= MAX_FILTER_CHOICES
  // Clear filters' sub-menu rows: the developers, publishers and genres on.
  const clearable = clearableChoices({ developers, publishers, tags }, tagFilterLabel)
  /**
   * Clear filters > a developer, publisher or genre: only that one goes. The sub-menu stays open on the next row (the
   * one before when it was the last); with none of them left it closes, focus on Clear filters (or on Genre when no
   * filter is left, as that row goes too).
   */
  const removeChoice = (key: string): void => {
    const index = clearable.findIndex((c) => c.key === key)
    const entry = clearable[index]
    if (!entry || !sub) return
    const patch = withoutChoice({ developers, publishers, tags }, entry.choice)
    if (patch.developers) onDevelopers(patch.developers)
    if (patch.publishers) onPublishers(patch.publishers)
    if (patch.tags) onTags(patch.tags)
    const next = clearable[index + 1] ?? clearable[index - 1]
    if (next) {
      const target = `${subMenuKey(baseKey, 'clear')}:${next.key}`
      setTimeout(() => void setFocus(target), 0)
    } else setSub({ ...sub, leaving: active > 1 ? `${focusKey}:clear` : `${focusKey}:${firstRow}` })
  }

  /** A row whose left arrow (or A) opens its sub-menu; with that sub-menu open, left moves into it. */
  const subRow = (
    kind: SubMenuKind,
    label: string,
    value: string | null,
    icon: ReactNode = <ChevronLeft className="filters-menu__arrow" aria-hidden="true" />,
    trailing: ReactNode = value !== null ? (
      <span className="filters-menu__value">{value}</span>
    ) : undefined
  ): ReactElement => (
    <MenuItem
      focusKey={`${focusKey}:${kind}`}
      label={label}
      icon={icon}
      trailing={trailing}
      onPress={() => (sub?.kind === kind ? closeSub() : openSub(kind))}
      onArrowPress={(direction) => {
        if (direction !== 'left') return true
        // Already open with the pointer back on this row: the layer took focus once, on mount.
        if (sub?.kind === kind) void setFocus(subMenuKey(baseKey, kind))
        else openSub(kind)
        return false
      }}
    />
  )

  const platformLabel = (id: string): string =>
    id === ALL_ROM_PLATFORMS
      ? ALL_ROM_PLATFORMS_LABEL
      : (platformOptions.find((p) => p.id === id)?.label ?? id)
  // Filters > Platform's two parts: the stores (fewer, so first), then (below a line) the systems; a part with no choices
  // is left out.
  const showSystems = platformOptions.length > 0 || platforms.length > 0
  const showStores = storeOptions.length > 0 || stores.length > 0
  const platformMenu: Option[] = [
    ...(showStores
      ? [
          // Every PC game (the stores' and Other's, no emulation game); picked again, the stores' filter is off.
          { value: ALL_STORES, label: ALL_STORES_LABEL },
          // Each store with its badge before its name ("All Stores" has none).
          ...storeOptions.map((s) => ({
            value: s.id,
            label: s.label,
            icon: <StoreIcon storeId={s.id} />
          })),
          // A picked store no game in this list is from any more stays listed, so it can be turned off.
          ...stores
            .filter((id) => id !== ALL_STORES && !storeOptions.some((s) => s.id === id))
            .map((id) => ({
              value: id,
              label: storeFilterLabel(id),
              icon: <StoreIcon storeId={id} />
            }))
        ].map((option) => ({ ...option, value: STORE_PREFIX + option.value }))
      : []),
    ...(showSystems && showStores ? [SEPARATOR_OPTION] : []),
    ...(showSystems
      ? [
          // Every ROM game (no PC game); picked again, the systems' filter is off.
          { value: ALL_ROM_PLATFORMS, label: ALL_ROM_PLATFORMS_LABEL },
          // Each platform with its console's picture before its name ("All Platforms" has none).
          ...platformOptions.map((p) => ({
            value: p.id,
            label: p.label,
            icon: <ConsoleIcon systemId={p.id} />
          })),
          // A picked platform with no games any more stays listed, so it can be turned off.
          ...platforms
            .filter((id) => id !== ALL_ROM_PLATFORMS && !platformOptions.some((p) => p.id === id))
            .map((id) => ({ value: id, label: id }))
        ]
      : [])
  ]
  const sizeLabel = (id: string): string => SIZE_BUCKETS.find((b) => b.id === id)?.label ?? id
  const hltbLabel = (id: string): string => HLTB_BUCKETS.find((b) => b.id === id)?.label ?? id
  /**
   * Hidden / Favorites / Recompilations: a toggle; turning one on is not possible while the menu is full. `icon`
   * sits where the other rows have their arrow (Hidden's closed eye, Favorites' heart, Recompilations' up arrow), so
   * the names still line up; without one the name is indented instead.
   */
  const toggleRow = (
    key: string,
    label: string,
    on: boolean,
    count: number,
    onToggle: (next: boolean) => void,
    icon?: ReactElement
  ): ReactElement => (
    <MenuItem
      focusKey={`${focusKey}:${key}`}
      label={label}
      icon={icon}
      className={icon ? undefined : 'filters-menu__indented'}
      selected={on}
      disabled={!on && full}
      trailing={
        on ? (
          <Check className="select-menu__check" />
        ) : (
          <span className="filters-menu__value">{count}</span>
        )
      }
      onPress={() => onToggle(!on)}
    />
  )

  return createPortal(
    <div className="select-menu-backdrop" onClick={onBackdropClick}>
      <LayerContext.Provider value={layerId}>
        <FocusContext.Provider value={focusKey}>
          <div
            ref={ref}
            className={cx('select-menu', position.above && 'select-menu--above')}
            style={position.style}
            role="menu"
            aria-label={t('library.filters.pill')}
            data-focus-key={focusKey}
          >
            <Menu>
              {active && clearable.length ? (
                // With a developer, publisher or genre on: a sub-menu with All and one row for each of them.
                subRow(
                  'clear',
                  t('library.filters.clear'),
                  null,
                  <X aria-hidden="true" />,
                  <ChevronLeft className="filters-menu__arrow" aria-hidden="true" />
                )
              ) : active ? (
                <MenuItem
                  focusKey={`${focusKey}:clear`}
                  label={t('library.filters.clear')}
                  icon={<X aria-hidden="true" />}
                  onPress={() => (sub ? setSub({ ...sub, clearing: true }) : clearAll())}
                />
              ) : null}
              {(() => {
                const rows: Record<FilterRow, ReactNode> = {
                  // Genre: the genres and the Steam tags, one list (lib/steamTags.ts TAG_FILTERS).
                  genre: subRow(
                    'genre',
                    t('library.filters.genre'),
                    pickedText(t, tags, tagFilterLabel)
                  ),
                  era: subRow(
                    'era',
                    t('library.filters.release'),
                    pickedText(t, eras, releaseEraLabel)
                  ),
                  // Platform: the stores, then (below a line) the systems.
                  platform: subRow(
                    'platform',
                    t('library.filters.platform'),
                    [
                      pickedText(t, stores, storeFilterLabel),
                      pickedText(t, platforms, platformLabel)
                    ]
                      .filter((text): text is string => text !== null)
                      .join(', ') || null
                  ),
                  size: subRow('size', t('library.filters.size'), pickedText(t, sizes, sizeLabel)),
                  hltb: subRow('hltb', t('library.filters.hltb'), pickedText(t, hltb, hltbLabel)),
                  difficulty: subRow(
                    'difficulty',
                    t('library.filters.difficulty'),
                    pickedText(t, difficulty, difficultyLabel)
                  ),
                  reviews: subRow(
                    'reviews',
                    t('library.filters.reviews'),
                    pickedText(t, reviews, reviewBandLabel)
                  ),
                  controls: subRow(
                    'controls',
                    t('library.filters.controls'),
                    pickedText(t, controls, controlsFilterLabel)
                  ),
                  players: subRow(
                    'players',
                    t('library.filters.localMultiplayer'),
                    pickedText(t, coop ? [...players, COOP_CHOICE] : players, (id) =>
                      id === COOP_CHOICE ? t('library.filters.coop') : localMultiplayerLabel(id)
                    )
                  ),
                  online: subRow(
                    'online',
                    t('library.filters.onlineMultiplayer'),
                    pickedText(t, online, onlineMultiplayerLabel)
                  ),
                  // Custom: the user's own filters (a game's options menu > Create a filter), once there is one.
                  custom: subRow(
                    'custom',
                    t('library.filters.custom'),
                    pickedText(t, customPicked, (id) => customName(id) ?? id)
                  )
                }
                return rowOrder.map((row) => <Fragment key={row}>{rows[row]}</Fragment>)
              })()}
              {toggleRow(
                'hidden',
                t('library.filters.hidden'),
                hidden,
                hiddenCount,
                onHidden,
                // A closed eye: the games kept out of sight.
                <EyeClosed
                  className="filters-menu__arrow"
                  style={{ color: HIDDEN_COLOR }}
                  aria-hidden="true"
                />
              )}
              {toggleRow(
                'favorites',
                t('library.filters.favorites'),
                favorites,
                favoriteCount,
                onFavorites,
                // Filled while the filter is on, like the game page's favourite button.
                <Heart
                  className="filters-menu__arrow filters-menu__icon--favorite"
                  fill={favorites ? 'currentColor' : 'none'}
                  aria-hidden="true"
                />
              )}
              {toggleRow(
                'recomp',
                t('library.filters.recompilations'),
                recomp,
                recompCount,
                onRecomp,
                // The recompilation mark (the UP button beside Play), filled while the filter is on.
                <ArrowBigUp
                  className="filters-menu__arrow filters-menu__icon--recomp"
                  fill={recomp ? 'currentColor' : 'none'}
                  aria-hidden="true"
                />
              )}
            </Menu>
            {full ? (
              <p className="filters-menu__note" role="status">
                {t('library.filters.full', { max: MAX_FILTER_CHOICES })}
              </p>
            ) : null}
          </div>
        </FocusContext.Provider>
      </LayerContext.Provider>
      {sub?.kind === 'clear' ? (
        <ClearSubMenu
          key="clear"
          baseKey={baseKey}
          style={sub.style}
          choices={clearable}
          onAll={() => setSub({ ...sub, clearing: true })}
          onRemove={removeChoice}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing && !sub.leaving}
        />
      ) : sub?.kind === 'platform' ? (
        <SubMenu
          key="platform"
          baseKey={baseKey}
          kind="platform"
          label={t('library.filters.platform')}
          style={sub.style}
          picked={[...stores.map((id) => STORE_PREFIX + id), ...platforms]}
          // The systems and the stores each count as one choice: either part takes more once it has one.
          full={(value) =>
            full && (value.startsWith(STORE_PREFIX) ? stores.length === 0 : platforms.length === 0)
          }
          options={platformMenu}
          onPick={(value) =>
            value.startsWith(STORE_PREFIX)
              ? onStores(pickStore(stores, value.slice(STORE_PREFIX.length)))
              : onPlatforms(pickPlatform(platforms, value))
          }
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'genre' ? (
        <SubMenu
          baseKey={baseKey}
          key="genre"
          kind="genre"
          label={t('library.filters.genre')}
          style={sub.style}
          picked={tags}
          full={full}
          options={[
            { value: ALL, label: t('library.filters.allGenres') },
            // Each genre with its icon ("All Genres" has none).
            ...tagOptions.map((tag) => ({
              value: tag.id,
              label: tag.label,
              icon: tinted(<GenreIcon genreId={tag.id} />, GENRE_COLORS[tag.id])
            })),
            // A picked genre no game in this list has any more stays listed, so it can be turned off.
            ...tags
              .filter((id) => !tagOptions.some((tag) => tag.id === id))
              .map((id) => ({
                value: id,
                label: tagFilterLabel(id),
                icon: tinted(<GenreIcon genreId={id} />, GENRE_COLORS[id])
              }))
          ]}
          onPick={(value) => onTags(value === ALL ? [] : toggleChoice(tags, value))}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'era' ? (
        <SubMenu
          baseKey={baseKey}
          key="era"
          kind="era"
          label={t('library.filters.release')}
          style={sub.style}
          picked={eras}
          full={full}
          options={[
            { value: ALL, label: t('library.filters.allDates') },
            // Each era with its picture ("All Dates" has none).
            ...eraOptions.map((e) => ({
              value: e.id,
              label: e.label,
              icon: <EraIcon eraId={e.id} />
            })),
            // A picked era no game in this list is from any more stays listed, so it can be turned off.
            ...eras
              .filter((id) => !eraOptions.some((e) => e.id === id))
              .map((id) => ({
                value: id,
                label: releaseEraLabel(id),
                icon: <EraIcon eraId={id} />
              }))
          ]}
          onPick={(value) => onEras(value === ALL ? [] : toggleChoice(eras, value))}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'size' ? (
        <SubMenu
          baseKey={baseKey}
          key="size"
          kind="size"
          label={t('library.filters.size')}
          style={sub.style}
          picked={sizes}
          full={full}
          options={options.size}
          onPick={(value) => onSizes(value === ALL ? [] : toggleChoice(sizes, value))}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'online' ? (
        <SubMenu
          baseKey={baseKey}
          key="online"
          kind="online"
          label={t('library.filters.onlineMultiplayer')}
          style={sub.style}
          picked={online}
          full={full}
          options={ONLINE_OPTIONS}
          onPick={(value) => onOnline(toggleChoice(online, value))}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'players' ? (
        <SubMenu
          baseKey={baseKey}
          key="players"
          kind="players"
          label={t('library.filters.localMultiplayer')}
          style={sub.style}
          picked={coop ? [...players, COOP_CHOICE] : players}
          full={full}
          options={options.players}
          onPick={(value) =>
            value === COOP_CHOICE ? onCoop(!coop) : onPlayers(toggleChoice(players, value))
          }
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'controls' ? (
        <SubMenu
          baseKey={baseKey}
          key="controls"
          kind="controls"
          label={t('library.filters.controls')}
          style={sub.style}
          picked={controls}
          full={full}
          options={controlsMenu}
          onPick={(value) => onControls(value === ALL ? [] : toggleChoice(controls, value))}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'hltb' ? (
        <SubMenu
          baseKey={baseKey}
          key="hltb"
          kind="hltb"
          label={t('library.filters.hltbTitle')}
          style={sub.style}
          picked={hltb}
          full={full}
          options={options.hltb}
          onPick={(value) => onHltb(value === ALL ? [] : toggleChoice(hltb, value))}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'difficulty' ? (
        <SubMenu
          baseKey={baseKey}
          key="difficulty"
          kind="difficulty"
          label={t('library.filters.difficulty')}
          style={sub.style}
          picked={difficulty}
          full={full}
          options={options.difficulty}
          onPick={(value) => onDifficulty(value === ALL ? [] : toggleChoice(difficulty, value))}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'custom' ? (
        <CustomSubMenu
          key="custom"
          baseKey={baseKey}
          style={sub.style}
          filters={customFilters}
          picked={customPicked}
          counts={customCounts}
          full={full}
          onPick={(value) => onCustom(value === ALL ? [] : toggleChoice(customPicked, value))}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : sub?.kind === 'reviews' ? (
        <SubMenu
          baseKey={baseKey}
          key="reviews"
          kind="reviews"
          label={t('library.filters.reviews')}
          style={sub.style}
          picked={reviews}
          full={full}
          options={options.reviews}
          onPick={(value) => onReviews(value === ALL ? [] : toggleChoice(reviews, value))}
          onClose={closeSub}
          onCloseAll={onClose}
          restoreFocus={!sub.clearing}
        />
      ) : null}
    </div>,
    document.body
  )
}

const SUB_MENU_SUFFIX: Record<SubMenuKind, string> = {
  clear: 'clear-filters',
  platform: 'platforms',
  genre: 'genres',
  era: 'eras',
  size: 'sizes',
  hltb: 'hltb-times',
  difficulty: 'difficulties',
  reviews: 'review-bands',
  controls: 'controls',
  players: 'local-multiplayer',
  online: 'online-multiplayer',
  custom: 'custom-filters'
}

const subMenuKey = (baseKey: string, kind: SubMenuKind): string =>
  `${baseKey}:${SUB_MENU_SUFFIX[kind]}`

interface SubMenuProps {
  /** The pill's focus key (FiltersPillProps.focusKey). */
  baseKey: string
  kind: SubMenuKind
  label: string
  style: CSSProperties
  /** The choices picked in this sub-menu (none: its "All …" option is ticked). */
  picked: readonly string[]
  /** The menu holds MAX_FILTER_CHOICES already: choices not picked cannot be added (per choice: Platform's two parts). */
  full: boolean | ((value: string) => boolean)
  options: readonly Option[]
  /** A choice was pressed (picked again: turned off; ALL: every choice of this sub-menu cleared). */
  onPick: (value: string) => void
  onClose: () => void
  /** RT: the whole Filters menu closes. */
  onCloseAll: () => void
  /** False while it closes for the X: focus goes to Genre instead of back to the row that opened it. */
  restoreFocus: boolean
}

/**
 * A sub-menu of the Filters menu (Genre, Release, Tags, Platform, Size, H.L.T.B., Difficulty, Reviews): its options, the picked ones ticked. Pressing a choice turns
 * it on or off and the sub-menu stays open; right or B steps back to the Filters menu, RT closes both.
 */
function SubMenu({
  baseKey,
  kind,
  label,
  style,
  picked,
  full,
  options,
  onPick,
  onClose,
  onCloseAll,
  restoreFocus
}: SubMenuProps): ReactElement {
  const focusKey = subMenuKey(baseKey, kind)
  const itemKey = (option: string): string => `${focusKey}:${option}`
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey,
    // The first picked choice, else the first option (ALL, or Platform's "All Platforms").
    preferredChildFocusKey: itemKey(picked[0] ?? options.find((o) => !o.separator)?.value ?? ALL),
    restoreFocus
  })
  useActionHandlersOnLayer(layerId, {
    back: () => {
      onClose()
      return true
    },
    rt: () => {
      onCloseAll()
      return true
    }
  })
  return (
    <LayerContext.Provider value={layerId}>
      <FocusContext.Provider value={focusKey}>
        <div
          ref={ref}
          className={cx('select-menu', 'filters-menu--genres')}
          style={style}
          role="listbox"
          aria-label={label}
          aria-multiselectable="true"
          data-focus-key={focusKey}
        >
          <Menu>
            {options.map((option) => {
              if (option.separator)
                return (
                  <div
                    key={option.value}
                    className="filters-menu__sep"
                    role="separator"
                    aria-orientation="horizontal"
                    // Only a line to look at: a listbox holds options only, so screen readers skip it.
                    aria-hidden="true"
                  />
                )
              const on = option.value === ALL ? picked.length === 0 : picked.includes(option.value)
              const isFull = typeof full === 'function' ? full(option.value) : full
              const blocked = !on && isFull && option.value !== ALL
              return (
                <MenuItem
                  key={option.value}
                  focusKey={itemKey(option.value)}
                  label={option.label}
                  art={option.art}
                  icon={option.icon}
                  selected={on}
                  // With every filter slot used, the other choices are greyed and do nothing, but stay focusable: a
                  // list without an "All" row (Local / Online Multiplayer) must still hold the controller's focus.
                  className={blocked ? 'control--disabled' : undefined}
                  trailing={on ? <Check className="select-menu__check" /> : undefined}
                  onPress={blocked ? undefined : () => onPick(option.value)}
                  onArrowPress={(direction) => {
                    if (direction !== 'right') return true
                    onClose()
                    return false
                  }}
                />
              )
            })}
          </Menu>
        </div>
      </FocusContext.Provider>
    </LayerContext.Provider>
  )
}

/**
 * Filters > Clear filters' sub-menu (while a developer, publisher or genre is on): All turns every filter of the tab
 * off; each row below is one developer, publisher or genre / tag (what it is on the right), and pressing it turns
 * only that one off. Right or B steps back to the Filters menu, RT closes both.
 */
function ClearSubMenu({
  baseKey,
  style,
  choices,
  onAll,
  onRemove,
  onClose,
  onCloseAll,
  restoreFocus
}: {
  baseKey: string
  style: CSSProperties
  choices: readonly ClearableChoice[]
  onAll: () => void
  /** A row pressed: its ClearableChoice.key. */
  onRemove: (key: string) => void
  onClose: () => void
  onCloseAll: () => void
  /** False while it closes for All or its last row: focus goes elsewhere, not back to Clear filters. */
  restoreFocus: boolean
}): ReactElement {
  const t = useT()
  const focusKey = subMenuKey(baseKey, 'clear')
  const itemKey = (value: string): string => `${focusKey}:${value}`
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey,
    preferredChildFocusKey: itemKey(ALL),
    restoreFocus
  })
  useActionHandlersOnLayer(layerId, {
    back: () => {
      onClose()
      return true
    },
    rt: () => {
      onCloseAll()
      return true
    }
  })
  const closeOnRight = (direction: string): boolean => {
    if (direction !== 'right') return true
    onClose()
    return false
  }
  return (
    <LayerContext.Provider value={layerId}>
      <FocusContext.Provider value={focusKey}>
        <div
          ref={ref}
          className={cx('select-menu', 'filters-menu--genres')}
          style={style}
          role="menu"
          aria-label={t('library.filters.clear')}
          data-focus-key={focusKey}
        >
          <Menu>
            <MenuItem
              focusKey={itemKey(ALL)}
              label={t('library.filters.all')}
              onPress={onAll}
              onArrowPress={closeOnRight}
            />
            {choices.map((entry) => (
              <MenuItem
                key={entry.key}
                focusKey={itemKey(entry.key)}
                label={entry.label}
                trailing={<span className="filters-menu__value">{entry.hint}</span>}
                onPress={() => onRemove(entry.key)}
                onArrowPress={closeOnRight}
              />
            ))}
          </Menu>
        </div>
      </FocusContext.Provider>
    </LayerContext.Provider>
  )
}

/**
 * Filters > Custom's sub-menu: All Custom, then each of the user's filters with its icon (in its colour) and how many
 * cards it holds; picking works as the other sub-menus' (a game in any filter picked shows). Y or a right click on a
 * filter turns the sub-menu into that filter's actions: Rename, Change icon and Delete (asked first); B or right steps
 * back to the list. Each action closes the Filters menu first and opens the filter's dialog (or the question).
 */
function CustomSubMenu({
  baseKey,
  style,
  filters,
  picked,
  counts,
  full,
  onPick,
  onClose,
  onCloseAll,
  restoreFocus
}: {
  baseKey: string
  style: CSSProperties
  filters: readonly CustomFilter[]
  picked: readonly string[]
  counts?: ReadonlyMap<string, number>
  full: boolean
  onPick: (value: string) => void
  onClose: () => void
  onCloseAll: () => void
  restoreFocus: boolean
}): ReactElement {
  const t = useT()
  const focusKey = subMenuKey(baseKey, 'custom')
  const itemKey = (value: string): string => `${focusKey}:${value}`
  const editKey = (action: string): string => `${focusKey}:edit:${action}`
  /** The filter whose actions are shown (null: the list). */
  const [editing, setEditing] = useState<string | null>(null)
  const editingFilter = editing ? filters.find((f) => f.id === editing) : undefined
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey,
    preferredChildFocusKey: itemKey(picked[0] ?? ALL),
    restoreFocus
  })
  const backToList = (id: string): void => {
    setEditing(null)
    setTimeout(() => void setFocus(itemKey(id)), 0)
  }
  const edit = (id: string): void => {
    setEditing(id)
    setTimeout(() => void setFocus(editKey('rename')), 0)
  }
  useActionHandlersOnLayer(layerId, {
    back: () => {
      if (editing) backToList(editing)
      else onClose()
      return true
    },
    rt: () => {
      onCloseAll()
      return true
    },
    // Y on a filter: its actions.
    y: () => {
      if (editing) return true
      const current = getCurrentFocusKey() ?? ''
      const id = current.startsWith(itemKey('')) ? current.slice(itemKey('').length) : ''
      if (filters.some((f) => f.id === id)) edit(id)
      return true
    }
  })
  /** Close the Filters menu, then run `open` (a dialog) once the menu has handed focus back. */
  const leaveFor = (open: () => void): void => {
    onCloseAll()
    setTimeout(open, 0)
  }
  const closeOnRight = (direction: string): boolean => {
    if (direction !== 'right') return true
    if (editing) backToList(editing)
    else onClose()
    return false
  }
  return (
    <LayerContext.Provider value={layerId}>
      <FocusContext.Provider value={focusKey}>
        <div
          ref={ref}
          className={cx('select-menu', 'filters-menu--genres')}
          style={style}
          role={editingFilter ? 'menu' : 'listbox'}
          aria-label={editingFilter ? editingFilter.name : t('library.filters.custom')}
          aria-multiselectable={editingFilter ? undefined : 'true'}
          data-focus-key={focusKey}
        >
          {editingFilter ? (
            <>
              <div className="filters-menu__heading">
                <CustomFilterIconView icon={editingFilter.icon} className="custom-filter-icon" />
                <span className="u-truncate">{editingFilter.name}</span>
              </div>
              <Menu>
                <MenuItem
                  focusKey={editKey('rename')}
                  label={t('library.filters.customRename')}
                  icon={<Pencil />}
                  onPress={() => leaveFor(() => openEditCustomFilter(editingFilter.id, 'name'))}
                  onArrowPress={closeOnRight}
                />
                <MenuItem
                  focusKey={editKey('icon')}
                  label={t('library.filters.customIcon')}
                  icon={<Palette />}
                  onPress={() => leaveFor(() => openEditCustomFilter(editingFilter.id, 'icon'))}
                  onArrowPress={closeOnRight}
                />
                <MenuItem
                  focusKey={editKey('delete')}
                  label={t('library.filters.customDelete')}
                  icon={<Trash2 />}
                  danger
                  onPress={() => leaveFor(() => confirmDeleteCustomFilter(editingFilter.id))}
                  onArrowPress={closeOnRight}
                />
              </Menu>
            </>
          ) : (
            <>
              <Menu>
                <MenuItem
                  focusKey={itemKey(ALL)}
                  label={t('library.filters.allCustom')}
                  selected={picked.length === 0}
                  trailing={
                    picked.length === 0 ? <Check className="select-menu__check" /> : undefined
                  }
                  onPress={() => onPick(ALL)}
                  onArrowPress={closeOnRight}
                />
                {filters.map((filter) => {
                  const on = picked.includes(filter.id)
                  const blocked = !on && full
                  const count = counts?.get(filter.id) ?? filter.gameIds.length
                  return (
                    <MenuItem
                      key={filter.id}
                      focusKey={itemKey(filter.id)}
                      label={filter.name}
                      icon={
                        <span className="console-icon" aria-hidden="true">
                          <CustomFilterIconView
                            icon={filter.icon}
                            className="console-icon__generic"
                          />
                        </span>
                      }
                      selected={on}
                      className={blocked ? 'control--disabled' : undefined}
                      trailing={
                        on ? (
                          <Check className="select-menu__check" />
                        ) : (
                          <span className="filters-menu__value">{count}</span>
                        )
                      }
                      onPress={blocked ? undefined : () => onPick(filter.id)}
                      onArrowPress={closeOnRight}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        edit(filter.id)
                      }}
                    />
                  )
                })}
              </Menu>
              <p className="filters-menu__note">{t('library.filters.customHint')}</p>
            </>
          )}
        </div>
      </FocusContext.Provider>
    </LayerContext.Provider>
  )
}

/** The Filters menu's height for placing it: its twelve rows, the X and the padding, in px at 1080p. */
const MENU_ESTIMATE_U = 13 * 60 + 24

/**
 * Left-aligned with and at least as wide as the pill: below it, or above it when there is more room there (a pill low in
 * Settings > Library); never taller than the window has room for.
 */
function placeMenu(anchor: HTMLElement): { style: CSSProperties; above: boolean } {
  const rect = anchor.getBoundingClientRect()
  const gap = GAP_U * unit()
  const below = window.innerHeight - rect.bottom - gap * 2
  const roomAbove = rect.top - gap * 2
  const above = below < MENU_ESTIMATE_U * unit() && roomAbove > below
  const style: CSSProperties = {
    left: Math.round(rect.left),
    minWidth: Math.round(rect.width),
    maxHeight: Math.round(above ? roomAbove : below),
    overflowY: 'auto'
  }
  if (above) style.bottom = Math.round(window.innerHeight - rect.top + gap)
  else style.top = Math.round(rect.bottom + gap)
  return { style, above }
}
