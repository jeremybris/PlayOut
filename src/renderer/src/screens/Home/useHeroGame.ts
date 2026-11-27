import type { Game } from '@shared/types'
import { useEffect, useState } from 'react'
import { findGame } from '../../lib/streaming'
import { useLibraryStore } from '../../state/library'
import { useStreamingStore } from '../../state/streaming'
import { useUiStore } from '../../state/ui'
import { HERO_FOLLOW_MS } from './rows'

/**
 * The game the hero backdrop and text describe: the last focused card's game, settled 150 ms after the
 * last focus change so fast D-pad repeats do not thrash the art (design 6.3), else `fallback`. A paired host's
 * game (a Library card this PC does not have) resolves through the Streaming store.
 */
export function useHeroGame(fallback: Game | undefined): Game | undefined {
  const focusedId = useUiStore((s) => s.focusedGameId)
  const byId = useLibraryStore((s) => s.byId)
  const remote = useStreamingStore((s) => s.remote)
  const [settledId, setSettledId] = useState(focusedId)
  useEffect(() => {
    if (settledId === focusedId) return undefined
    const timer = setTimeout(() => setSettledId(focusedId), HERO_FOLLOW_MS)
    return () => clearTimeout(timer)
  }, [focusedId, settledId])
  return (settledId ? findGame(settledId, byId, remote) : undefined) ?? fallback
}
