import { app, BrowserWindow, dialog, shell } from 'electron'
import { DYNAMIC_FPS, POWER_CHOICES, type PowerChoice } from '../../shared/overlay'
import type { Ps3UpdateService } from '../emulation/ps3-update-service'
import { FRAME_LIMIT_MAX, type PerfOverlayLevel } from '../../shared/overlay-extras'
import type { OverlaySuite } from '../overlay/suite'
import { STEAM_ID64 } from '../../shared/friends'
import type { FriendsService } from '../friends/steam-friends'
import { promises as fs } from 'fs'
import { z } from 'zod'
import type { Game, MetadataCandidate, PowerAction, SettingsPatch } from '../../shared/types'
import { recompInPlaceOf, recompToPlay, recompOnlyKey } from '../../shared/recomp-play'
import type { AccountsService } from '../accounts'
import type { AchievementsService } from '../achievements/achievements-service'
import type { InstallSizeService } from '../services/install-size'
import type { EmulationService } from '../emulation/types'
import type { EmulatorSetupService } from '../emulator-setup/service'
import type { EmulationMoveService } from '../emulation/emulation-move-service'
import type { EventBus } from '../events'
import type { InstallService } from '../installs'
import type { LauncherService } from '../launcher/types'
import type { Logger } from '../logger'
import type { ProviderRegistry } from '../providers/types'
import type { ImageCache, MetadataService } from '../scrapers/types'
import type { LibraryService } from '../services/library-service'
import type { ScanService } from '../services/scan-service'
import { generateFolders, generatedFolderPath } from '../emulation/generated-folders'
import type { ConvertService } from '../convert/convert-service'
import { convertPair, directionFormats } from '../../shared/convert'
import { testCredentials } from '../scrapers/credential-check'
import { metadataEditFieldsSchema, parseMetadataEdit } from '../metadata-edits/schema'
import type { SteamScreenshotsService } from '../scrapers/steam-screenshots'
import {
  CREDENTIAL_SCHEMAS,
  CREDENTIAL_SERVICES,
  parseSettingsPatch,
  SCRAPER_IDS,
  SOURCE_IDS,
  STORE_SOURCE_IDS
} from '../store/settings-schema'
import type { SettingsStore } from '../store/settings-store'
import type { SystemService } from '../system/types'
import type { UpdateService } from '../updates'
import { loginItemPath } from '../util/paths'
import type { ApiHandlers } from './register'
import type { CoopService } from '../coop/coop-service'
import type { PeerPartyService } from '../peerparty/service'
import type { PeerPartyOverlay } from '../peerparty/overlay'
import type { RecompService } from '../recomp/service'
import type { VrModsService } from '../vr-mods/service'
import type { StreamingService } from '../streaming/streaming-service'
import { parseRemoteGameId } from '../streaming/remote-library'
import type { LocalDeleteService } from '../services/local-delete'
import type { SteamDlcService } from '../steam-dlc/service'
import type { UpgradesService } from '../upgrades/service'
import { upgradeRunningMessage } from '../../shared/upgrades'
import type { MetadataCloudService } from '../metadata-cloud/service'
import { tMain } from '../i18n'
import { queueMissing } from '../scrapers/missing-art'

export interface AppServices {
  /** Moving the Emulation folder (Settings › Library), and where it may be. */
  emulationMove?: EmulationMoveService
  settings: SettingsStore
  library: LibraryService
  providers: ProviderRegistry
  scan: ScanService
  emulation: EmulationService
  emulatorSetup: EmulatorSetupService
  launcher: LauncherService
  metadata: MetadataService
  imageCache: ImageCache
  steamScreenshots: SteamScreenshotsService
  system: SystemService
  accounts: AccountsService
  achievements: AchievementsService
  installSizes: InstallSizeService
  installs: InstallService
  updates: UpdateService
  coop: CoopService
  /** PeerParty: LAN play for eligible installed games, and the overlay's PeerParty tile (main/peerparty). */
  peerParty: PeerPartyService
  /** The overlay's PeerParty tab: LAN status, players and the LAN invite (main/peerparty/overlay.ts). */
  peerPartyOverlay: PeerPartyOverlay
  convert: ConvertService
  /** Recompilations: the UP button, the Recompilation page, Settings › Recompilations (main/recomp/service.ts). */
  recomp: RecompService
  /** VR mods: Settings › VR and its browser (main/vr-mods/service.ts). */
  vrMods: VrModsService
  streaming: StreamingService
  /** "Delete from this PC" (services/local-delete.ts). */
  localDelete: LocalDeleteService
  /** Steam DLC: the install-time picker and Manage DLC (main/steam-dlc/service.ts). */
  steamDlc: Pick<SteamDlcService, 'steamDlc' | 'setSteamDlc' | 'openSteamDlcPage'>
  /** The game page's Upgrade menu (main/upgrades/service.ts). */
  upgrades: Pick<UpgradesService, 'upgradeStatus' | 'runUpgrade' | 'cancelUpgrade' | 'busyFor'>
  /** Settings › Storage: the fixed drives' size and free space (main system/drives.ts). */
  storageDrives: () => Promise<import('../../shared/types').StorageDrive[]>
  ps3Updates: Pick<Ps3UpdateService, 'updatePs3Game'>
  /** The metadata cloud: sync, owner token, publish / suggest, suggestions (main/metadata-cloud/service.ts). */
  metadataCloud: Pick<
    MetadataCloudService,
    | 'status'
    | 'setConfig'
    | 'checkToken'
    | 'sync'
    | 'suggestions'
    | 'resolveSuggestion'
    | 'shareRelayUrl'
  >
  /** Wake with the Xbox button (main/controller-wake). */
  controllerWake: Pick<import('../controller-wake/service').ControllerWakeService, 'status'>
  /** The home button, the overlay and what it controls (main/overlay/suite.ts). */
  overlay: OverlaySuite
  /** The overlay's Friends tab: Steam friends and Steam's chat (main/friends/steam-friends.ts). */
  friends: FriendsService
  events: EventBus
  log: Logger
  window: {
    get(): BrowserWindow | null
    setFullscreen(fullscreen: boolean): void
    isFullscreen(): boolean
    minimize(): void
    restore(): void
    focus(): void
  }
  /** The app's own Exit: hides to the tray while Minimize to tray is on, quits otherwise (main/tray.ts). */
  exitApp(): void
  /** Shows the Windows touch keyboard; implemented in index.ts. */
  showTouchKeyboard(): Promise<void>
}

const MEDIA_KINDS = ['cover', 'hero', 'logo', 'icon'] as const
const POWER_ACTIONS = ['exit', 'minimize', 'sleep', 'hibernate', 'restart', 'shutdown'] as const
const POWER_MODES = ['efficiency', 'balanced', 'performance'] as const
const SETTINGS_PAGES = ['bluetooth', 'wifi', 'sound', 'display', 'power', 'gamepad'] as const

const idSchema = z.string().min(1).max(500)
/** Steam DLC app ids to turn off (setSteamDlc). */
const steamDlcIdsSchema = z.array(z.number().int().positive()).max(2000)
/** An Upgrade menu action (src/shared/upgrades.ts UpgradeAction). */
const upgradeActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dlls-update') }),
  z.object({ kind: z.literal('dlls-restore') }),
  z.object({ kind: z.literal('dlss5-open') }),
  z.object({ kind: z.literal('shaders-compile') }),
  z.object({ kind: z.literal('optiscaler-install') }),
  z.object({ kind: z.literal('optiscaler-remove') }),
  z.object({
    kind: z.literal('compress'),
    algorithm: z.enum(['xpress4k', 'xpress8k', 'xpress16k', 'lzx'])
  }),
  z.object({ kind: z.literal('uncompress') })
])
const emulatorSetupIdsSchema = z
  .array(z.string().regex(/^[A-Z0-9_]{1,40}$/))
  .max(20)
  .optional()
const pathSchema = z.string().min(1).max(4096)
/** Streaming ids: remote game ids are `remote:<hostId>:<hostGameId>`, longer than library ids. */
const streamIdSchema = z.string().min(1).max(600)
const addressSchema = z.string().trim().min(1).max(255)
const pinSchema = z.string().regex(/^\d{4}$/, 'The PIN is 4 digits')
const storeSourceSchema = z.enum(STORE_SOURCE_IDS)
const storeSourcesSchema = z.array(storeSourceSchema).max(STORE_SOURCE_IDS.length).optional()
const candidateSchema = z.object({
  scraper: z.enum(SCRAPER_IDS),
  externalId: z.string(),
  title: z.string(),
  releaseDate: z.string().optional(),
  platform: z.string().optional(),
  cover: z.string().optional()
})
const userPatchSchema = z.object({
  favorite: z.boolean().optional(),
  hidden: z.boolean().optional(),
  completed: z.boolean().optional(),
  user: z
    .object({
      titleOverride: z.string().max(300).nullable().optional(),
      emulatorId: z.string().max(100).nullable().optional(),
      extraArgs: z.string().max(2000).nullable().optional(),
      installSize: z.number().int().positive().max(1e15).nullable().optional(),
      customMedia: z.record(z.string(), z.string()).nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
      preferredCopy: z.boolean().nullable().optional(),
      performance: z
        .object({
          profile: z.enum(['silent', 'balanced', 'performance', 'custom', 'dynamic']),
          targetFps: z.number().int().min(DYNAMIC_FPS.min).max(DYNAMIC_FPS.max).optional()
        })
        .strict()
        .nullable()
        .optional(),
      playlist: z.array(z.string().min(1).max(1024)).max(2000).nullable().optional(),
      coop: z
        .object({
          exePath: pathSchema.optional(),
          players: z.number().int().min(1).max(64).optional(),
          layout: z
            .enum([
              'FullScreen',
              'DualHorizontal',
              'DualVertical',
              'FourPlayers',
              'SixPlayers',
              'EightPlayers',
              'SixteenPlayers'
            ])
            .optional(),
          devices: z.array(z.string().min(1).max(300)).max(64).optional(),
          risksAccepted: z.boolean().optional()
        })
        .strict()
        .nullable()
        .optional()
    })
    .optional()
})

/** Recompilation entry ids: "<host>:<owner>/<repo>[#<game slug>]". */
const recompIdSchema = z.string().min(1).max(500)
const recompTagSchema = z.string().min(1).max(200)
const recompNeedSchema = z.string().min(1).max(200)
/** VR mod ids: the list's slugs. */
const vrModIdSchema = z.string().min(1).max(300)

const metadataCloudConfigSchema = z
  .object({
    relayUrl: z.string().max(500).optional(),
    token: z.string().max(400).nullable().optional(),
    suggestEdits: z.boolean().optional()
  })
  .strict()

const convertDirectionSchema = z
  .object({
    platformId: z.string().min(1).max(50),
    pairId: z.string().min(1).max(80),
    reversed: z.boolean()
  })
  .strict()

export function createHandlers(s: AppServices): ApiHandlers {
  const win = (): BrowserWindow | undefined => s.window.get() ?? undefined
  /**
   * While the Emulation folder is being moved nothing may start writing into it (a game or emulator, a setup, a
   * conversion, a recompilation install or save sync, a ROM download): refused with a translated message.
   */
  const notWhileMoving = (): void => {
    if (s.emulationMove?.moving()) throw new Error(tMain('mainEmulationMove.busy.moving'))
  }
  /** A host-only game (`remote:` id) as its host offers it; null for any other id. Unknown host game: an error. */
  const remoteGame = async (id: string): Promise<Game | null> => {
    if (!parseRemoteGameId(id)) return null
    const game = await s.streaming.remoteGameBase(id)
    if (!game) throw new Error(`Unknown game ${id}`)
    return game
  }

  return {
    // --- library -------------------------------------------------------------
    async getLibrary() {
      return s.library.snapshot()
    },
    async getGame(id) {
      return s.library.getGameView(idSchema.parse(id)) ?? null
    },
    async updateGame(id, patch) {
      // The renderer's patch is the user's own: a favourite turned on or off is stamped for the favourites sync.
      return s.library.view(
        s.library.updateGame(idSchema.parse(id), userPatchSchema.parse(patch), { byUser: true })
      )
    },
    // The game page's Edit sheet (shared/metadata-edit.ts): the user's own metadata corrections. A paired host's game
    // (`remote:` id) has no record here: its edit goes to this PC's remote edits (main/metadata-edits/remote-edits.ts).
    async getMetadataLayers(id) {
      const gameId = idSchema.parse(id)
      const remote = await remoteGame(gameId)
      return remote ? s.library.remoteMetadataLayers(remote) : s.library.metadataLayers(gameId)
    },
    async setMetadataEdit(id, edit, clear) {
      const gameId = idSchema.parse(id)
      const parsed = parseMetadataEdit(edit)
      const fields = clear == null ? undefined : metadataEditFieldsSchema.parse(clear)
      const remote = await remoteGame(gameId)
      return remote
        ? s.library.setRemoteMetadataEdit(remote, parsed, fields)
        : s.library.setMetadataEdit(gameId, parsed, fields)
    },
    async clearMetadataEdit(id, fields) {
      const gameId = idSchema.parse(id)
      const parsed = fields == null ? undefined : metadataEditFieldsSchema.parse(fields)
      const remote = await remoteGame(gameId)
      return remote
        ? s.library.clearRemoteMetadataEdit(remote, parsed)
        : s.library.clearMetadataEdit(gameId, parsed)
    },
    // --- metadata cloud (main/metadata-cloud) -----------------------------------------------------
    async getMetadataCloudStatus() {
      return s.metadataCloud.status()
    },
    async setMetadataCloudConfig(patch) {
      return s.metadataCloud.setConfig(metadataCloudConfigSchema.parse(patch))
    },
    async checkMetadataCloudToken() {
      return s.metadataCloud.checkToken()
    },
    async syncMetadataCloud() {
      return s.metadataCloud.sync()
    },
    async listMetadataSuggestions() {
      return s.metadataCloud.suggestions()
    },
    async resolveMetadataSuggestion(number, action, headSha) {
      return s.metadataCloud.resolveSuggestion(
        z.number().int().positive().max(1e9).parse(number),
        z.enum(['approve', 'reject']).parse(action),
        z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .parse(headSha)
      )
    },
    async shareMetadataRelayUrl() {
      return s.metadataCloud.shareRelayUrl()
    },
    async removeGame(id) {
      const gameId = idSchema.parse(id)
      await s.imageCache.remove(gameId)
      s.library.removeGame(gameId)
    },
    // Only the id crosses: every path is derived from the library record in main (services/local-delete.ts).
    async getLocalDeletePlan(id) {
      return s.localDelete.plan(idSchema.parse(id))
    },
    async deleteGameLocally(id, options) {
      return s.localDelete.run(
        idSchema.parse(id),
        z.object({ updatesDlc: z.boolean().optional() }).strict().optional().parse(options)
      )
    },
    updatePs3Game(gameId) {
      return s.ps3Updates.updatePs3Game(idSchema.parse(gameId))
    },
    async getSessions(gameId) {
      return s.library.getSessions(idSchema.parse(gameId))
    },

    // --- sources / scanning ----------------------------------------------------
    async getSources() {
      return s.scan.sourceStatuses()
    },
    async scanSources(ids) {
      const parsed = ids === undefined ? undefined : z.array(z.enum(SOURCE_IDS)).parse(ids)
      // On a client, a full Scan ("Scan all now", Add games) also has every paired host rescan its library, in the
      // background: its games arrive by themselves once its scan ends ('streaming:library'), and this scan's answer
      // never waits on a host. One source's Scan, and a PC with no host (a host itself), scan only this PC.
      if (parsed === undefined)
        void s.streaming
          .scanHosts()
          .catch((err: unknown) => s.log.warn('scanning the hosts failed', err))
      // A scan finds games; it never changes the metadata of games already matched (only Refresh metadata does).
      return s.scan.run(parsed)
    },
    async generateFolders(kind) {
      const which = z.enum(['roms', 'emulation']).parse(kind)
      const picked = await dialog.showOpenDialog(win()!, {
        title:
          which === 'roms'
            ? tMain('mainDialogs.romsFolder.title')
            : tMain('mainDialogs.emulationFolder.title'),
        buttonLabel: tMain('mainDialogs.createHere'),
        properties: ['openDirectory', 'createDirectory']
      })
      const parent = picked.canceled ? undefined : picked.filePaths[0]
      if (!parent) return null
      const systemIds = s.emulation.systems().map((system) => system.id)
      // Never inside PlayOut's install or data folder (an uninstall or a new PC would lose it).
      if (which === 'emulation') s.emulationMove?.validate(generatedFolderPath('emulation', parent))
      const made = await generateFolders(which, parent, systemIds)
      // A generated Emulation folder is the one in use from now on (Convert's keys and BIOS files).
      if (which === 'emulation') s.settings.update({ library: { emulationDir: made.path } })
      return made
    },
    async planEmulationMove(request) {
      const parsed = z
        .object({
          kind: z.enum(['choose', 'generate', 'default']),
          picked: z.string().min(1).max(4096).optional()
        })
        .strict()
        .parse(request)
      if (!s.emulationMove) throw new Error('not available')
      return s.emulationMove.plan(parsed)
    },
    async startEmulationMove(to, mode) {
      if (!s.emulationMove) throw new Error('not available')
      return s.emulationMove.start(
        z.string().min(1).max(4096).parse(to),
        z.enum(['move', 'merge', 'switch']).parse(mode)
      )
    },
    async cancelEmulationMove() {
      s.emulationMove?.cancel()
    },
    async getEmulationFolderOffer() {
      return (await s.emulationMove?.offer()) ?? null
    },
    async answerEmulationFolderOffer() {
      await s.emulationMove?.answerOffer()
    },
    async addManualGame(input) {
      const parsed = z
        .object({
          exePath: pathSchema,
          title: z.string().max(300).optional(),
          args: z.string().max(2000).optional(),
          cwd: z.string().max(4096).optional()
        })
        .parse(input)
      const scanned = await s.providers.manual.addGame(parsed)
      const merge = s.library.mergeScan('manual', [scanned], { markMissing: false })
      s.library.registerPlatforms(s.providers.manual.platforms())
      const game = s.library
        .games()
        .find((g) => g.source === 'manual' && g.externalId === scanned.externalId)
      if (!game) throw new Error(tMain('mainDialogs.gameNotAdded'))
      for (const item of merge.localMedia) {
        const url = await s.imageCache.importLocal(item.gameId, item.kind, item.path)
        if (url) s.library.setMedia(item.gameId, item.kind, url)
      }
      if (s.settings.get().scrapers.autoScrape) s.metadata.enqueue([game.id])
      return s.library.view(game)
    },
    async addGamesFromFolder(folder) {
      const scanned = await s.providers.manual.scanFolder(pathSchema.parse(folder))
      if (!scanned.length) return []
      const merge = s.library.mergeScan('manual', scanned, { markMissing: false })
      s.library.registerPlatforms(s.providers.manual.platforms())
      const ids = new Set(scanned.map((g) => g.externalId))
      const games = s.library.games().filter((g) => g.source === 'manual' && ids.has(g.externalId))
      for (const item of merge.localMedia) {
        const url = await s.imageCache.importLocal(item.gameId, item.kind, item.path)
        if (url) s.library.setMedia(item.gameId, item.kind, url)
      }
      if (merge.newGameIds.length && s.settings.get().scrapers.autoScrape)
        s.metadata.enqueue(merge.newGameIds)
      return games.map((g) => s.library.view(g))
    },

    // --- store accounts / installs (ARCHITECTURE.md §4.8) -----------------------
    async getAccounts() {
      return s.accounts.getAccounts()
    },
    async signIn(source) {
      return s.accounts.signIn(storeSourceSchema.parse(source))
    },
    async signOut(source) {
      return s.accounts.signOut(storeSourceSchema.parse(source))
    },
    async importOwned(sources) {
      return s.accounts.importOwned(
        sources === undefined ? undefined : storeSourcesSchema.parse(sources)
      )
    },
    async installGame(id) {
      return s.installs.installGame(idSchema.parse(id))
    },
    async steamDlc(gameId) {
      return s.steamDlc.steamDlc(idSchema.parse(gameId))
    },
    async setSteamDlc(gameId, disabled) {
      return s.steamDlc.setSteamDlc(idSchema.parse(gameId), steamDlcIdsSchema.parse(disabled))
    },
    async openSteamDlcPage(gameId) {
      await s.steamDlc.openSteamDlcPage(idSchema.parse(gameId))
    },
    async upgradeStatus(gameId) {
      return s.upgrades.upgradeStatus(idSchema.parse(gameId))
    },
    async runUpgrade(gameId, action) {
      return s.upgrades.runUpgrade(idSchema.parse(gameId), upgradeActionSchema.parse(action))
    },
    async cancelUpgrade(gameId) {
      await s.upgrades.cancelUpgrade(idSchema.parse(gameId))
    },
    async getStorageDrives() {
      return s.storageDrives()
    },
    async cancelInstallTracking(id) {
      s.installs.cancelInstallTracking(idSchema.parse(id))
    },
    async getInstalls() {
      return s.installs.getInstalls()
    },
    async getInstallQueue() {
      return s.installs.getInstallQueue()
    },
    // Queue ids are store ids or the longer `remote:` ids of a host's ROM games.
    async removeFromInstallQueue(gameId) {
      s.installs.removeFromInstallQueue(streamIdSchema.parse(gameId))
    },
    async moveInInstallQueue(gameId, delta) {
      s.installs.moveInInstallQueue(
        streamIdSchema.parse(gameId),
        z.union([z.literal(-1), z.literal(1)]).parse(delta)
      )
    },
    // null: every game of the queue.
    async pauseInstall(gameId) {
      s.installs.pauseInstall(streamIdSchema.nullable().parse(gameId))
    },
    async resumeInstall(gameId) {
      s.installs.resumeInstall(streamIdSchema.nullable().parse(gameId))
    },

    // --- emulation -------------------------------------------------------------
    async getSystems() {
      return s.emulation.systemInfos(s.library.gameCountsByPlatform())
    },
    async getEmulators() {
      return s.emulation.emulators()
    },
    async setEmulatorPath(emulatorId, path) {
      const id = z.string().min(1).max(100).parse(emulatorId)
      const value = path === null ? null : pathSchema.parse(path)
      const overrides = { ...s.settings.get().emulators.overrides }
      if (value) overrides[id] = value
      else delete overrides[id]
      s.settings.mutate((d) => {
        d.emulators.overrides = overrides
      })
      return s.emulation.emulators()
    },
    async getEmulatorSetup() {
      return s.emulatorSetup.status()
    },
    async setupEmulators(ids) {
      notWhileMoving()
      const parsed = emulatorSetupIdsSchema.parse(ids)
      // Runs in the background ('emulator-setup:progress'); the status shows the requested emulators as installing.
      void s.emulatorSetup.setup(parsed).catch((err) => s.log.error('emulator setup failed', err))
      return s.emulatorSetup.status()
    },
    async updateEmulators() {
      notWhileMoving()
      // Resolves when the run ends, with its report (the status's lastUpdate); the progress goes out meanwhile
      // ('emulator-setup:progress', stage 'updates'). update() never rejects.
      return s.emulatorSetup.update()
    },
    async importEsde() {
      const roms = s.library.games().filter((g) => g.source === 'rom')
      const { updates, esdeHome, preferredEmulators } = await s.emulation.importEsde(roms)
      // System-wide <alternativeEmulator> labels become the preferred emulator, but never override a user's choice.
      const current = s.settings.get().emulators.preferred
      const toSet = Object.entries(preferredEmulators).filter(([sys]) => !current[sys])
      if (toSet.length)
        s.settings.mutate((d) => {
          for (const [sys, id] of toSet) d.emulators.preferred[sys] = id
        })
      let mediaCopied = 0
      for (const u of updates) {
        s.library.applyMetadata(
          u.gameId,
          {
            title: u.title,
            metadata: u.metadata,
            status: Object.keys(u.metadata).length ? 'done' : undefined
          },
          { reason: 'import' }
        )
        s.library.applyImportedState(u.gameId, {
          favorite: u.favorite,
          hidden: u.hidden,
          playCount: u.playCount,
          playtimeMinutes: u.playtimeMinutes,
          lastPlayed: u.lastPlayed,
          emulatorId: u.emulatorId
        })
        for (const [kind, path] of Object.entries(u.localMedia)) {
          if (!path) continue
          const url = await s.imageCache.importLocal(u.gameId, kind as 'cover', path)
          if (url) {
            s.library.setMedia(u.gameId, kind as 'cover', url)
            mediaCopied++
          }
        }
      }
      return {
        gamesUpdated: updates.length,
        mediaCopied,
        message: esdeHome
          ? tMain('mainDialogs.esde.imported', { folder: esdeHome })
          : tMain('mainDialogs.esde.notFound')
      }
    },

    // --- launching -------------------------------------------------------------
    async launchGame(id, options) {
      const game = s.library.requireGame(idSchema.parse(id))
      if (s.emulationMove?.moving()) {
        const error = { kind: 'failed' as const, message: tMain('mainEmulationMove.busy.moving') }
        s.events.emit('launch:error', { gameId: game.id, error })
        return { ok: false, error }
      }
      // A recompilation of it is installed (its disc image may also have gone to the Recycle Bin, or been moved into the
      // recompilation's folder by hand): Play starts the recompilation, unless an emulator was picked (Play menu).
      const pickedEmulator =
        options && typeof (options as { emulatorId?: unknown }).emulatorId === 'string'
      const inPlace = pickedEmulator ? recompInPlaceOf(game) : recompToPlay(game)
      // An owned-only record carries the store's install URI as its launch; only the Install path may open it.
      if (!game.installed && !inPlace) {
        const error = {
          kind: 'file-missing' as const,
          message: tMain('mainDialogs.launch.notInstalled')
        }
        s.events.emit('launch:error', { gameId: game.id, error })
        return { ok: false, error }
      }
      const opts = options
        ? z.object({ emulatorId: z.string().max(100).optional() }).parse(options)
        : undefined
      if (inPlace) {
        const started = await s.recomp.launchRecomp(game.id, inPlace)
        if (started.ok) return { ok: true, startedAt: new Date().toISOString() }
        const error = {
          kind: 'failed' as const,
          message:
            started.reason === 'needs-files'
              ? tMain('mainDialogs.launch.recompNeedsFiles')
              : started.reason === 'choose-exe'
                ? tMain('mainDialogs.launch.recompChooseExe')
                : started.reason === 'save-conflict'
                  ? tMain('mainDialogs.launch.recompSaveConflict')
                  : started.reason === 'not-installed'
                    ? `${started.message} ${game.romRemoved ? tMain('mainDialogs.launch.recompImageInRecycleBin') : recompOnlyKey(game) ? tMain('mainDialogs.launch.recompReinstall') : tMain('mainDialogs.launch.recompReinstallOrRestore')}`
                    : started.message
        }
        s.events.emit('launch:error', { gameId: game.id, error })
        return { ok: false, error }
      }
      const result = await s.launcher.launch(game, opts)
      if (!result.ok && result.error)
        s.events.emit('launch:error', { gameId: game.id, error: result.error })
      return result
    },
    async getRunningGame() {
      return s.launcher.running()
    },

    // --- metadata --------------------------------------------------------------
    async refreshMetadata(ids, options) {
      const force = options?.force === true
      if (ids !== undefined) {
        // The user asked: a game that failed a moment ago is tried again (automatic enqueues back off instead).
        const queued = s.metadata.enqueue(z.array(idSchema).parse(ids), {
          force,
          retryFailed: true
        })
        return { queued }
      }
      // "Refresh missing": games whose metadata never finished (not only 'none'/'failed': a game left 'pending' by an
      // interrupted run too; enqueue dedupes ids already queued or active) and matched games missing any art (cover,
      // hero, logo, icon), which run the art fill for those kinds only (missing-art.ts).
      if (!force) return { queued: queueMissing(s.library, s.metadata, s.log, 'refresh missing') }
      const queued = s.metadata.enqueue(
        s.library.games().map((g) => g.id),
        { force, retryFailed: true }
      )
      s.log.info(`refresh all: ${queued} game(s) queued`)
      return { queued }
    },
    async searchMetadata(gameId, query) {
      return s.metadata.search(idSchema.parse(gameId), z.string().max(300).parse(query))
    },
    async applyMetadata(gameId, candidate) {
      return s.library.view(
        await s.metadata.apply(
          idSchema.parse(gameId),
          candidateSchema.parse(candidate) as MetadataCandidate
        )
      )
    },
    async getAchievements(gameId) {
      const id = streamIdSchema.parse(gameId)
      // A paired host's game: its host's list (this PC has no record of it).
      if (parseRemoteGameId(id)) return s.streaming.achievementsFor(id)
      return s.achievements.get(idSchema.parse(id))
    },
    async getSteamScreenshots(gameId) {
      return s.steamScreenshots.forGame(idSchema.parse(gameId))
    },
    async setCustomMedia(gameId, kind, filePath) {
      const id = idSchema.parse(gameId)
      const k = z.enum(MEDIA_KINDS).parse(kind)
      const game = s.library.requireGame(id)
      if (filePath === null) {
        s.library.clearCustomMedia(id, k)
        s.library.setMedia(id, k, null)
        await s.imageCache.remove(id, k, { custom: true })
        s.metadata.enqueue([id], { force: true })
        return s.library.view(s.library.requireGame(id))
      }
      const file = pathSchema.parse(filePath)
      // `custom-<kind>.<ext>`: a cover-lane download in flight for this game writes `<kind>.<ext>` and cannot
      // replace or delete the user's file (ARCHITECTURE.md §4.6 "Art pipeline").
      const url = await s.imageCache.importCustom(id, k, file)
      if (!url) throw new Error(tMain('mainDialogs.imageUnreadable'))
      s.library.updateGame(id, {
        user: { customMedia: { ...(game.user.customMedia ?? {}), [k]: file } }
      })
      s.library.setMedia(id, k, url)
      return s.library.view(s.library.requireGame(id))
    },

    // --- settings --------------------------------------------------------------
    async getSettings() {
      // Report reality, not the stored flag: the Run entry may be missing or stale (portable stub moved, user
      // removed it in Task Manager). Only meaningful for a packaged win32 build (ARCHITECTURE.md 4.7).
      const settings = s.settings.get()
      if (process.platform === 'win32' && app.isPackaged) {
        try {
          const real = app.getLoginItemSettings({
            path: loginItemPath(),
            args: ['--autostart']
          }).openAtLogin
          if (real !== settings.system.launchAtLogin)
            return s.settings.update({ system: { launchAtLogin: real } })
        } catch (err) {
          s.log.warn(`getLoginItemSettings failed: ${(err as Error).message}`)
        }
      }
      return settings
    },
    async updateSettings(patch) {
      // Strict shape check before anything is persisted: wrong types, nulls, out-of-range numbers and unknown keys
      // (including `version`) are rejected instead of being deep-merged into settings.json.
      const parsed: SettingsPatch = parseSettingsPatch(patch)
      // The Emulation folder may not be put inside PlayOut's install or data folder (translated error).
      if (parsed.library?.emulationDir !== undefined)
        s.emulationMove?.validate(parsed.library.emulationDir)
      const next = s.settings.update(parsed)
      if (parsed.system?.launchAtLogin !== undefined) {
        try {
          // `path` is mandatory: the portable stub extracts to a temp folder, so process.execPath alone would
          // leave a dead Run entry; electron-builder points PORTABLE_EXECUTABLE_FILE at the real stub exe.
          app.setLoginItemSettings({
            openAtLogin: !!next.system.launchAtLogin,
            path: loginItemPath(),
            args: ['--autostart']
          })
        } catch (err) {
          s.log.warn(`setLoginItemSettings failed: ${(err as Error).message}`)
        }
      }
      return next
    },
    async refreshInstallSize(gameId) {
      const game = await s.installSizes.refresh(idSchema.parse(gameId))
      return game ? s.library.view(game) : null
    },
    async refreshLivePlayers(gameId) {
      const id = idSchema.parse(gameId)
      await s.metadata.refreshLive(id)
      return s.library.getGameView(id) ?? null
    },
    async refreshActivePlayers() {
      await s.metadata.refreshActivePlayers()
    },
    async stopHltbTimes() {
      s.metadata.stopHltbTimes()
    },
    async refreshHltbTimes() {
      await s.metadata.refreshHltbTimes()
    },
    async getRetroAchievementsStatus() {
      return s.achievements.retroStatus()
    },
    async syncRetroAchievements() {
      return s.achievements.syncRetro()
    },
    async testCredentials(service, credentials) {
      const id = z.enum(CREDENTIAL_SERVICES).parse(service)
      return testCredentials(id, CREDENTIAL_SCHEMAS[id].parse(credentials) as typeof credentials)
    },

    // --- dialogs ---------------------------------------------------------------
    async chooseFolder(title) {
      const result = await dialog.showOpenDialog(win()!, {
        title: title ?? tMain('mainDialogs.chooseFolder'),
        properties: ['openDirectory']
      })
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
    },
    async chooseFile(options) {
      const result = await dialog.showOpenDialog(win()!, {
        title: options?.title ?? tMain('mainDialogs.chooseFile'),
        filters: options?.filters,
        properties: ['openFile']
      })
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
    },

    // --- system ----------------------------------------------------------------
    async getSystemStatus() {
      return s.system.status()
    },
    async setVolume(level) {
      await s.system.setVolume(z.number().min(0).max(100).parse(level))
    },
    async setMuted(muted) {
      await s.system.setMuted(z.boolean().parse(muted))
    },
    async setBrightness(percent) {
      await s.system.setBrightness(z.number().min(0).max(100).parse(percent))
    },
    async setPowerMode(mode) {
      await s.system.setPowerMode(z.enum(POWER_MODES).parse(mode))
    },
    async powerAction(action) {
      const a = z.enum(POWER_ACTIONS).parse(action) as PowerAction
      if (a === 'exit') {
        s.exitApp()
        return
      }
      if (a === 'minimize') {
        s.window.minimize()
        return
      }
      await s.system.powerAction(a)
    },
    async openWindowsSettings(page) {
      await s.system.openWindowsSettings(z.enum(SETTINGS_PAGES).parse(page))
    },
    async getPerfSample() {
      return s.system.perf()
    },

    // --- app / window ----------------------------------------------------------
    async getAppInfo() {
      return {
        name: 'PlayOut',
        version: app.getVersion(),
        userDataPath: app.getPath('userData'),
        documentsPath: app.getPath('documents'),
        isPackaged: app.isPackaged,
        platform: process.platform
      }
    },
    getConvertStatus() {
      return s.convert.status()
    },
    checkConvert(request) {
      return s.convert.check(convertDirectionSchema.parse(request))
    },
    async chooseConvertPaths(request) {
      const parsed = convertDirectionSchema.parse(request)
      const pair = convertPair(parsed.platformId, parsed.pairId)
      const formats = pair ? directionFormats(pair, parsed.reversed) : null
      if (!formats) return []
      const { from } = formats
      const picked = await dialog.showOpenDialog(win()!, {
        title: from.folder
          ? tMain('mainDialogs.convert.chooseFolders', { format: from.label })
          : tMain('mainDialogs.convert.chooseFiles', { format: from.label }),
        properties: from.folder
          ? ['openDirectory', 'multiSelections']
          : ['openFile', 'multiSelections'],
        ...(from.folder
          ? {}
          : { filters: [{ name: from.label, extensions: from.exts.map((e) => e.slice(1)) }] })
      })
      return picked.canceled ? [] : picked.filePaths
    },
    startConvert(request) {
      const parsed = convertDirectionSchema
        .extend({ paths: z.array(pathSchema).min(1).max(5000) })
        .parse(request)
      notWhileMoving()
      return s.convert.start(parsed)
    },
    async stopConvert() {
      void s.convert.stop()
    },
    async openConvertPlace(need) {
      const which = z.enum(['switchKeys', 'wiiKey', 'ps3Unpack', 'ps3PackKey']).parse(need)
      const failure = await shell.openPath(await s.convert.placeFolder(which))
      if (failure) throw new Error(failure)
    },
    getCoopStatus() {
      return s.coop.status()
    },
    downloadCoopHandlers() {
      return s.coop.downloadHandlers()
    },
    getCoopPlan(gameId) {
      return s.coop.plan(idSchema.parse(gameId))
    },
    async playCoop(gameId) {
      const id = idSchema.parse(gameId)
      // An upgrade may be rewriting the game's files: Co-Op waits until it ends, like Play.
      if (s.upgrades.busyFor(id)) throw new Error(upgradeRunningMessage(tMain))
      return s.coop.play(id)
    },
    async stopCoop(gameId) {
      s.coop.stop(idSchema.parse(gameId))
    },
    removeCoopHandler(gameId) {
      return s.coop.removeHandler(idSchema.parse(gameId))
    },
    isCoopHandlerExtracted(gameId) {
      return s.coop.handlerExtracted(idSchema.parse(gameId))
    },
    // --- PeerParty (main/peerparty) -----------------------------------------
    peerPartyStatus(gameId) {
      return s.peerParty.status(idSchema.parse(gameId))
    },
    async playWithPeerParty(gameId) {
      const id = idSchema.parse(gameId)
      // An upgrade may be rewriting the game's files: PeerParty waits until it ends, like Play.
      if (s.upgrades.busyFor(id)) throw new Error(upgradeRunningMessage(tMain))
      return s.peerParty.play(id)
    },
    peerPartyCompatible() {
      return s.peerParty.compatible()
    },
    async peerPartySession() {
      return s.peerParty.session()
    },
    peerPartyOverlay() {
      return s.peerPartyOverlay.status()
    },
    peerPartyInvite() {
      return s.peerPartyOverlay.invite()
    },
    // --- recompilations (main/recomp) ---------------------------------------
    getGameRecomps(gameId) {
      return s.recomp.getGameRecomps(idSchema.parse(gameId))
    },
    setPreferredRecomp(gameId, recompId) {
      return s.recomp.setPreferredRecomp(idSchema.parse(gameId), recompIdSchema.parse(recompId))
    },
    installRecomp(recompId, tag) {
      notWhileMoving()
      return s.recomp.installRecomp(
        recompIdSchema.parse(recompId),
        recompTagSchema.optional().parse(tag ?? undefined)
      )
    },
    updateRecomp(recompId) {
      notWhileMoving()
      return s.recomp.updateRecomp(recompIdSchema.parse(recompId))
    },
    setRecompVersion(recompId, tag) {
      notWhileMoving()
      return s.recomp.setRecompVersion(
        recompIdSchema.parse(recompId),
        recompTagSchema.nullable().parse(tag ?? null)
      )
    },
    updateAllRecomps() {
      notWhileMoving()
      return s.recomp.updateAllRecomps()
    },
    checkRecompUpdates() {
      return s.recomp.checkRecompUpdates()
    },
    uninstallRecomp(recompId) {
      return s.recomp.uninstallRecomp(recompIdSchema.parse(recompId))
    },
    launchRecomp(gameId, recompId) {
      notWhileMoving()
      return s.recomp.launchRecomp(
        idSchema.parse(gameId),
        recompIdSchema.optional().parse(recompId ?? undefined)
      )
    },
    getRecompReleases(recompId) {
      return s.recomp.getRecompReleases(recompIdSchema.parse(recompId))
    },
    getRecompReadme(recompId) {
      return s.recomp.getRecompReadme(recompIdSchema.parse(recompId))
    },
    pickRecompGameFile(gameId, recompId, needId) {
      return s.recomp.pickRecompGameFile(
        idSchema.parse(gameId),
        recompIdSchema.parse(recompId),
        recompNeedSchema.parse(needId)
      )
    },
    setRecompGameFile(gameId, recompId, needId, path) {
      return s.recomp.setRecompGameFile(
        idSchema.parse(gameId),
        recompIdSchema.parse(recompId),
        recompNeedSchema.parse(needId),
        pathSchema.nullable().parse(path)
      )
    },
    listRecompExecutables(recompId) {
      return s.recomp.listRecompExecutables(recompIdSchema.parse(recompId))
    },
    setRecompExecutable(recompId, path) {
      // Checked again in main (recomp/executables.ts): an existing .exe file.
      return s.recomp.setRecompExecutable(
        recompIdSchema.parse(recompId),
        pathSchema.nullable().parse(path)
      )
    },
    pickRecompExecutable(recompId) {
      return s.recomp.pickRecompExecutable(recompIdSchema.parse(recompId))
    },
    getRecompImageOffers() {
      return s.recomp.getRecompImageOffers()
    },
    answerRecompImageOffer(key, answer) {
      return s.recomp.answerRecompImageOffer(
        z.string().min(1).max(4000).parse(key),
        z.enum(['delete', 'delete-folder', 'delete-both', 'keep']).parse(answer)
      )
    },
    askRecompImageDelete(gameId, recompId) {
      return s.recomp.askRecompImageDelete(idSchema.parse(gameId), recompIdSchema.parse(recompId))
    },
    getRecompHeldImages() {
      return s.recomp.getRecompHeldImages()
    },
    answerRecompHeldImage(holdId, answer) {
      return s.recomp.answerRecompHeldImage(
        z
          .string()
          .regex(/^[a-z0-9-]{6,64}$/i)
          .parse(holdId),
        z.enum(['restore', 'delete', 'retry']).parse(answer)
      )
    },
    getRecompSettings() {
      return s.recomp.getRecompSettings()
    },
    browseRecomps() {
      return s.recomp.browseRecomps()
    },
    setRecompFavorite(recompId, favorite) {
      return s.recomp.setRecompFavorite(recompIdSchema.parse(recompId), z.boolean().parse(favorite))
    },
    addRecompToLibrary(recompId) {
      return s.recomp.addRecompToLibrary(recompIdSchema.parse(recompId))
    },
    refreshRecompCatalog() {
      return s.recomp.refreshRecompCatalog()
    },
    setRecompAutoUpdate(recompId, on) {
      return s.recomp.setRecompAutoUpdate(recompIdSchema.parse(recompId), z.boolean().parse(on))
    },
    setRecompSavePaths(recompId, paths) {
      return s.recomp.setRecompSavePaths(
        recompIdSchema.parse(recompId),
        z.array(pathSchema).max(64).nullable().parse(paths)
      )
    },
    addRecompSaveFolder(recompId, path) {
      return s.recomp.addRecompSaveFolder(
        recompIdSchema.parse(recompId),
        pathSchema.optional().parse(path)
      )
    },
    getRecompSaves(recompId) {
      return s.recomp.getRecompSaves(recompIdSchema.parse(recompId))
    },
    findRecompSaveFolders(recompId) {
      return s.recomp.findRecompSaveFolders(recompIdSchema.parse(recompId))
    },
    setRecompCloud(recompId, enabled) {
      return s.recomp.setRecompCloud(recompIdSchema.parse(recompId), z.boolean().parse(enabled))
    },
    syncRecompSaves(recompId) {
      notWhileMoving()
      return s.recomp.syncRecompSaves(recompIdSchema.parse(recompId))
    },
    resolveRecompConflict(recompId, keep) {
      return s.recomp.resolveRecompConflict(
        recompIdSchema.parse(recompId),
        z.enum(['local', 'cloud']).parse(keep)
      )
    },
    openRecompFolder(recompId, which) {
      return s.recomp.openRecompFolder(
        recompIdSchema.parse(recompId),
        z.enum(['install', 'saves', 'copies']).parse(which)
      )
    },
    // --- VR mods (main/vr-mods) ------------------------------------------------
    getVrMods() {
      return s.vrMods.getVrMods()
    },
    getVrModReleases(modId) {
      return s.vrMods.getVrModReleases(vrModIdSchema.parse(modId))
    },
    getVrModReadme(modId) {
      return s.vrMods.getVrModReadme(vrModIdSchema.parse(modId))
    },
    downloadVrMod(modId, tag) {
      return s.vrMods.downloadVrMod(
        vrModIdSchema.parse(modId),
        recompTagSchema.optional().parse(tag ?? undefined)
      )
    },
    updateVrMod(modId) {
      return s.vrMods.updateVrMod(vrModIdSchema.parse(modId))
    },
    checkVrModUpdates() {
      return s.vrMods.checkVrModUpdates()
    },
    removeVrMod(modId) {
      return s.vrMods.removeVrMod(vrModIdSchema.parse(modId))
    },
    openVrModFolder(modId) {
      return s.vrMods.openVrModFolder(vrModIdSchema.nullish().parse(modId))
    },
    // --- streaming (ARCHITECTURE.md §4.13) ----------------------------------
    getStreamingStatus() {
      return s.streaming.status()
    },
    startStreamingPairing() {
      return s.streaming.startPairing()
    },
    cancelStreamingPairing() {
      return s.streaming.cancelPairing()
    },
    removeStreamingClient(clientId) {
      return s.streaming.removeClient(streamIdSchema.parse(clientId))
    },
    findStreamingHosts() {
      return s.streaming.findHosts()
    },
    firstStartHosts() {
      return s.streaming.firstStartHosts()
    },
    pairStreamingHost(address, pin) {
      return s.streaming.pairHost(addressSchema.parse(address), pinSchema.parse(pin))
    },
    removeStreamingHost(hostId) {
      return s.streaming.removeHost(streamIdSchema.parse(hostId))
    },
    setStreamingHostAddress(hostId, address) {
      return s.streaming.setHostAddress(
        streamIdSchema.parse(hostId),
        address === null ? null : addressSchema.parse(address)
      )
    },
    getRemoteLibrary() {
      return s.streaming.remoteLibrary()
    },
    refreshRemoteLibrary() {
      return s.streaming.refreshRemoteLibrary()
    },
    streamGame(gameId, hostId) {
      return s.streaming.streamGame(
        streamIdSchema.parse(gameId),
        streamIdSchema.optional().parse(hostId)
      )
    },
    stopStream() {
      return s.streaming.stopStream()
    },
    setRemoteFavorite(gameId, favorite) {
      return s.streaming.setRemoteFavorite(
        streamIdSchema.parse(gameId),
        z.boolean().parse(favorite)
      )
    },
    downloadRemoteRom(gameId) {
      notWhileMoving()
      return s.streaming.downloadRemoteRom(streamIdSchema.parse(gameId))
    },
    cancelRemoteRomDownload(gameId) {
      return s.streaming.cancelRemoteRomDownload(streamIdSchema.parse(gameId))
    },
    async getUpdateStatus() {
      return s.updates.status()
    },
    async checkForUpdates() {
      return s.updates.check()
    },
    async downloadUpdate() {
      return s.updates.download()
    },
    async installUpdate() {
      if (s.launcher.running()) throw new Error(tMain('mainDialogs.update.closeGame'))
      return s.updates.install()
    },
    async setFullscreen(fullscreen) {
      s.window.setFullscreen(z.boolean().parse(fullscreen))
    },
    async isFullscreen() {
      return s.window.isFullscreen()
    },
    async openExternal(url) {
      const u = z.string().url().parse(url)
      if (
        !/^(https?|steam|com\.epicgames\.launcher|goggalaxy|origin2|link2ea|battlenet|uplay|ms-settings|ms-windows-store):/i.test(
          u
        )
      ) {
        throw new Error(tMain('mainDialogs.refusedUrl'))
      }
      await shell.openExternal(u)
    },
    async openPath(path) {
      const error = await shell.openPath(pathSchema.parse(path))
      if (error) throw new Error(error)
    },
    async showItemInFolder(path) {
      shell.showItemInFolder(pathSchema.parse(path))
    },
    async openFolders(paths, options) {
      const list = z.array(pathSchema).max(10).parse(paths)
      // Filters > Recompilations: the Recompilations folder (where every recompilation is installed) comes first.
      if (
        z.object({ recompilations: z.boolean().optional() }).optional().parse(options)
          ?.recompilations
      )
        list.unshift(await s.recomp.installRoot())
      const opened: string[] = []
      const missing: string[] = []
      for (const path of list) {
        // Only folders that exist (a system with no folder in the ROMs folder yet, a library drive unplugged).
        const isDir = await fs
          .stat(path)
          .then((st) => st.isDirectory())
          .catch(() => false)
        if (!isDir || (await shell.openPath(path))) missing.push(path)
        else opened.push(path)
      }
      return { opened, missing }
    },
    async showTouchKeyboard() {
      await s.showTouchKeyboard()
    },

    // --- home button and overlay --------------------------------------------------
    async getHomeButtonStatus() {
      return s.overlay.homeStatus()
    },
    async startComboCapture() {
      s.overlay.startCapture()
    },
    async stopComboCapture() {
      s.overlay.stopCapture()
    },
    async openOverlay() {
      await s.overlay.open()
    },
    async closeOverlay() {
      await s.overlay.close()
    },
    async getOverlayState() {
      return s.overlay.overlayState()
    },
    async showPlayOut() {
      await s.overlay.showPlayOut()
    },
    async quitRunningGame() {
      return s.overlay.quitRunningGame()
    },
    async getPerformanceStatus() {
      return s.overlay.performance.refresh()
    },
    async applyPowerProfile(profile, forGame, options) {
      const p = z.enum(['none', ...POWER_CHOICES] as [string, ...string[]]).parse(profile) as
        PowerChoice | 'none'
      const game =
        forGame === undefined ? undefined : forGame === null ? null : idSchema.parse(forGame)
      const opts = z
        .object({
          targetFps: z.number().int().min(DYNAMIC_FPS.min).max(DYNAMIC_FPS.max).optional()
        })
        .strict()
        .optional()
        .parse(options ?? undefined)
      return s.overlay.applyPowerProfile(p, game, opts)
    },
    async installPowerHelper() {
      return s.overlay.performance.installHelper()
    },
    async removePowerHelper() {
      return s.overlay.removePowerHelper()
    },
    async getMemoryStatus() {
      return s.overlay.memory.status()
    },
    async getControllerWakeStatus() {
      return s.controllerWake.status()
    },
    // Takes no arguments: what is trimmed is decided in main (performance/memory/exclusions.ts), never by the caller.
    async freeMemoryNow() {
      return s.overlay.memory.freeNow()
    },
    async getDisplayStatus() {
      return s.overlay.display()
    },
    async setDisplayMode(mode) {
      const m = z
        .object({
          width: z.number().int().min(320).max(16384),
          height: z.number().int().min(200).max(16384),
          hz: z.number().int().min(2).max(1000)
        })
        .strict()
        .parse(mode)
      return s.overlay.setDisplayMode(m)
    },
    async getOverlayExtras() {
      return s.overlay.extras.status()
    },
    async getLiveStats() {
      return s.overlay.extras.liveStats()
    },
    async setFrameLimit(fps) {
      return s.overlay.extras.setFrameLimit(z.number().int().min(0).max(FRAME_LIMIT_MAX).parse(fps))
    },
    async setFrameLimitSync(enabled) {
      return s.overlay.extras.setSync(z.boolean().parse(enabled))
    },
    async setPerfOverlayLevel(level) {
      const l = z
        .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
        .parse(level) as PerfOverlayLevel
      return s.overlay.extras.setPerfOverlay(l)
    },
    async setAutoHdr(enabled) {
      return s.overlay.extras.setAutoHdr(z.boolean().parse(enabled))
    },
    async setCpuBoost(enabled) {
      return s.overlay.extras.setCpuBoost(z.boolean().parse(enabled))
    },
    async getIntelGraphics() {
      return s.overlay.intel.status()
    },
    async setEnduranceGaming(value) {
      return s.overlay.intel.set('enduranceGaming', z.string().min(1).max(64).parse(value))
    },
    async getMediaSession() {
      return s.overlay.mediaSession()
    },
    async mediaControl(action) {
      return s.overlay.mediaControl(
        z.enum(['play', 'pause', 'toggle', 'next', 'previous']).parse(action)
      )
    },
    async getMusicLibrary() {
      return s.overlay.musicLibrary()
    },
    async chooseMusicFolder() {
      const owner = s.overlay.overlayState().open ? (s.overlay.overlayWindow() ?? win()) : win()
      const options = {
        title: tMain('mainDialogs.music.chooseFolder'),
        properties: ['openDirectory' as const]
      }
      const picked = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0]
    },
    async getSteamFriends(options) {
      const opts = z
        .object({ refresh: z.boolean().optional() })
        .strict()
        .optional()
        .parse(options ?? undefined)
      return s.friends.list(opts)
    },
    // A SteamID64 only: the URI is built in main (steam://friends/message/<id>), never taken from the renderer.
    async messageSteamFriend(steamId) {
      return s.friends.message(z.string().regex(STEAM_ID64).parse(steamId))
    }
  }
}

export type { Game }
