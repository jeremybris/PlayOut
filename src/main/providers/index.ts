import type { SourceId } from '../../shared/types'
import type { EmulationService } from '../emulation/types'
import type { Logger } from '../logger'
import type { LibraryService } from '../services/library-service'
import type { SettingsStore } from '../store/settings-store'
import { battlenetProvider } from './battlenet'
import { eaProvider } from './ea'
import { epicProvider } from './epic'
import { gogProvider } from './gog'
import { createManualProvider } from './manual'
import { createRomProvider } from './rom'
import { steamProvider } from './steam'
import type { GameProvider, ProviderRegistry } from './types'
import { ubisoftProvider } from './ubisoft'
import { xboxProvider } from './xbox'

export interface ProviderDeps {
  library: LibraryService
  emulation: EmulationService
  settings: SettingsStore
  log: Logger
}

export function createProviders(deps: ProviderDeps): ProviderRegistry {
  const manual = createManualProvider({ library: deps.library, log: deps.log })
  const rom = createRomProvider({ emulation: deps.emulation, log: deps.log })
  const all: GameProvider[] = [
    steamProvider,
    epicProvider,
    gogProvider,
    eaProvider,
    battlenetProvider,
    ubisoftProvider,
    xboxProvider,
    manual,
    rom
  ]
  const byId = new Map<SourceId, GameProvider>(all.map((p) => [p.id, p]))
  return {
    all: () => all,
    get: (id) => byId.get(id),
    manual,
    rom
  }
}

export type {
  GameProvider,
  ManualProvider,
  ProviderRegistry,
  RomProvider,
  ScanContext
} from './types'
