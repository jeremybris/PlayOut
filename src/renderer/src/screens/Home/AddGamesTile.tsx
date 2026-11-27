import { useCallback, type ReactElement } from 'react'
import { AddGamesTile } from '../../components/GameCard'
import type { Direction } from '../../input/focus'
import { useUiStore } from '../../state/ui'

export interface HomeAddGamesTileProps {
  rowId: string
  onArrowPress?: (direction: Direction) => boolean
}

/** The dashed Add Games tile wired to the Add Games modal: last card of the Recent row, only card of an empty library. */
export function HomeAddGamesTile({ rowId, onArrowPress }: HomeAddGamesTileProps): ReactElement {
  const openModal = useUiStore((s) => s.openModal)
  const open = useCallback(() => {
    openModal({ type: 'addgames' })
  }, [openModal])
  return <AddGamesTile rowId={rowId} onSelect={open} onArrowPress={onArrowPress} />
}
