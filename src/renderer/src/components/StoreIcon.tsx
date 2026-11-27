import { PC_PLATFORM, STORE_PLATFORMS } from '@shared/platforms'
import type { StoreSourceId } from '@shared/types'
import type { ReactElement } from 'react'
import { PlatformBadge } from './PlatformBadge'

/**
 * A store's badge before its name in Filters > Platform below the line (the same round badge game cards show for the store), or the PC
 * badge for Other and any id that is not a store, in the box Platform's console pictures use so the rows line up.
 */
export function StoreIcon({ storeId }: { storeId: string }): ReactElement {
  const platform = STORE_PLATFORMS[storeId as StoreSourceId] ?? PC_PLATFORM
  return (
    <span className="console-icon" aria-hidden="true">
      <PlatformBadge platform={platform} size="calc(32 * var(--u))" />
    </span>
  )
}
