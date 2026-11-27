import type { Game, Platform } from '@shared/types'
import { memo, type ReactElement } from 'react'
import { GameCard } from '../../components/GameCard'
import { Row } from '../../components/Row'
import { useT } from '../../i18n'
import type { Direction } from '../../input/focus'
import { HomeAddGamesTile } from './AddGamesTile'
import { RECENT_ROW } from './rows'

export interface RecentRowProps {
  /** 'Recent Games', 'Recently Added' or 'Favorites' (Settings > Library > Front page: lib/recent.ts homeRowTitle). */
  title: string
  games: Game[]
  platformsById: Map<string, Platform>
  /** Copies across stores per shown game id (lib/copies.ts collapsedGames). */
  copies?: ReadonlyMap<string, number>
  onOpen: (game: Game) => void
  /** Direction pressed on a card before the focus engine moves; return false to consume it (down opens the Library). */
  onArrowPress?: (direction: Direction) => boolean
}

/**
 * Home's row: 'Recent Games' (the default; or Recently Added, Favorites: Settings > Library > Front page): the games (settings.ui.recentCount, at most a dozen or so) followed by the
 * Add Games tile. Short enough that it needs no windowing. Memoised, with stable callbacks, so a focus
 * change elsewhere on Home never re-renders its cards.
 */
export const RecentRow = memo(function RecentRow({
  title,
  games,
  platformsById,
  copies,
  onOpen,
  onArrowPress
}: RecentRowProps): ReactElement {
  return (
    <Row id={RECENT_ROW} title={title}>
      {games.map((game) => (
        <GameCard
          key={game.id}
          game={game}
          rowId={RECENT_ROW}
          platform={platformsById.get(game.platformId)}
          onSelect={onOpen}
          onArrowPress={onArrowPress}
          copies={copies?.get(game.id)}
        />
      ))}
      <HomeAddGamesTile rowId={RECENT_ROW} onArrowPress={onArrowPress} />
    </Row>
  )
})

/** The empty-library variant: the same row position with the 'Your library is empty' heading and only the tile. */
export function EmptyLibraryRow(): ReactElement {
  const t = useT()
  return (
    <Row id={RECENT_ROW} title={t('home.emptyLibrary')}>
      <HomeAddGamesTile rowId={RECENT_ROW} />
    </Row>
  )
}
