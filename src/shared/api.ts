// PlayOut — the typed API the renderer calls. Implemented twice:
//   * src/preload/index.ts exposes it as window.playout over IPC (every method -> ipcRenderer.invoke('playout:<method>', ...args))
//   * src/renderer/src/api/mock.ts implements it in-memory so the UI runs in a plain browser.
// Main-process handlers live in src/main/ipc/*.ts and are registered by name (see src/main/ipc/register.ts).

import type {
  MetadataCloudConfigPatch,
  MetadataCloudStatus,
  MetadataSuggestion
} from './metadata-cloud'
import type { MetadataEdit, MetadataEditField, MetadataLayers } from './metadata-edit'
import type {
  AccountStatus,
  AchievementsInfo,
  AppInfo,
  CredentialCheck,
  CredentialService,
  EmulatorSetupStatus,
  SteamDlcInfo,
  SteamDlcResult,
  EmulatorStatus,
  Game,
  GameUserPatch,
  ImportOwnedResult,
  ImportResult,
  InstallProgress,
  InstallQueueEntry,
  InstallResult,
  LaunchResult,
  LibrarySnapshot,
  LocalDeletePlan,
  LocalDeleteOptions,
  Ps3UpdateResult,
  LocalDeleteResult,
  MetadataCandidate,
  PerfSample,
  PlayOutEventName,
  PlayOutEvents,
  PlaySession,
  PowerAction,
  PowerMode,
  RetroAchievementsStatus,
  ScanResult,
  ServiceCredentials,
  Settings,
  SettingsPatch,
  SourceId,
  SourceStatus,
  SteamScreenshot,
  StoreSourceId,
  SystemInfo,
  SystemStatus,
  UpdateStatus,
  WindowsSettingsPage,
  CoopPlan,
  DiscoveredHost,
  PairedHost,
  RemoteLibrary,
  StreamingStatus,
  CoopStatus
} from './types'
import type { ConvertMissing, ConvertNeed, ConvertRequest, ConvertStatus } from './convert'
import type {
  GameFileState,
  GameRecomps,
  RecompBrowseView,
  RecompCatalogStatus,
  RecompCloudState,
  RecompExecutables,
  RecompDeleteChoice,
  RecompHeldAnswer,
  RecompHeldImage,
  RecompImageOffer,
  RecompLaunchResult,
  RecompRelease,
  RecompSaves,
  RecompSettingsView
} from './recomp'
import type { VrModRelease, VrModsView } from './vr-mods'

export interface PlayOutApi {
  // --- library -------------------------------------------------------------
  getLibrary(): Promise<LibrarySnapshot>
  getGame(id: string): Promise<Game | null>
  updateGame(id: string, patch: GameUserPatch): Promise<Game>
  /** A game's metadata layers (scraped, cloud, the user's own edit) for the Edit sheet (shared/metadata-edit.ts). */
  getMetadataLayers(id: string): Promise<MetadataLayers>
  /**
   * Save the user's own corrections: each field given replaces that field of the game's edit; the fields of `clear`
   * lose theirs (one save). Returns the game as shown.
   */
  setMetadataEdit(id: string, edit: MetadataEdit, clear?: MetadataEditField[]): Promise<Game>
  /** Remove the user's edit of `fields` (all when absent): they fall back to the cloud, else the scrapers. */
  clearMetadataEdit(id: string, fields?: MetadataEditField[]): Promise<Game>
  // --- metadata cloud (shared/metadata-cloud.ts; Settings › Metadata › Cloud metadata) ---------------------
  /** Sync state, owner token state (never the token) and queued suggestions. Changes arrive as 'metadata-cloud:status'. */
  getMetadataCloudStatus(): Promise<MetadataCloudStatus>
  /** Change the relay URL, the owner token ('' / null removes it; a new one is checked at once) or suggesting. */
  setMetadataCloudConfig(patch: MetadataCloudConfigPatch): Promise<MetadataCloudStatus>
  /** Ask GitHub again whether the saved token may write to the metadata repository. */
  checkMetadataCloudToken(): Promise<MetadataCloudStatus>
  /** Download all.json now. */
  syncMetadataCloud(): Promise<MetadataCloudStatus>
  /** Owner: the open suggestions (pull requests labelled 'suggestion') with each field's old -> new value. */
  listMetadataSuggestions(): Promise<MetadataSuggestion[]>
  /**
   * Owner: approve (merge) or reject (close) a suggestion. `headSha`: the suggestion's headSha as listed; approving
   * is refused when the pull request moved on since.
   */
  resolveMetadataSuggestion(
    number: number,
    action: 'approve' | 'reject',
    headSha: string
  ): Promise<void>
  /** Owner: write this PC's relay URL to the repository, so every PlayOut suggests through it. */
  shareMetadataRelayUrl(): Promise<void>
  removeGame(id: string): Promise<void>
  /** What "Delete from this PC" would do to an installed game of this PC (for the confirm text); changes nothing. */
  getLocalDeletePlan(id: string): Promise<LocalDeletePlan>
  /** Delete the game from this PC only: ROM files or a manual game's folder to the Recycle Bin, or the store's uninstall. */
  deleteGameLocally(id: string, options?: LocalDeleteOptions): Promise<LocalDeleteResult>
  /** Check Sony's update list for a PS3 game and install what it is missing through RPCS3 (the game menu). */
  updatePs3Game(gameId: string): Promise<Ps3UpdateResult>
  getSessions(gameId: string): Promise<PlaySession[]>

  // --- sources / scanning ----------------------------------------------------
  getSources(): Promise<SourceStatus[]>
  /** Scan the given sources (all enabled ones when omitted). Progress arrives through 'scan:progress' events. */
  scanSources(ids?: SourceId[]): Promise<ScanResult>
  /**
   * Settings › Library: asks where, then creates an empty "roms" folder (one folder per ES-DE system) or "Emulation"
   * folder (bios, hdpacks, roms, saves, storage, texturepacks, tools and their subfolders, EmuDeck's layout) there.
   * Nothing that exists is changed. null: the picker was cancelled. Settings are left to the caller.
   */
  generateFolders(
    kind: 'roms' | 'emulation'
  ): Promise<{ path: string; created: number; existing: number } | null>
  /**
   * Settings › Library › Emulation Folder: where a pick would put the Emulation folder, what moving it there takes
   * (size, drive, free space) and whether it may go there (never inside PlayOut's install or data folder).
   */
  planEmulationMove(
    request: import('./emulation-move').EmulationMoveRequest
  ): Promise<import('./emulation-move').EmulationMovePlan>
  /**
   * Move the Emulation folder to `to` (a plan's), or switch to it without moving ('switch'); progress on
   * 'emulation-move:progress'. Rejects with a translated message (Cancel too); the old folder and setting then stand.
   */
  startEmulationMove(
    to: string,
    mode: import('./emulation-move').EmulationMoveMode
  ): Promise<import('./emulation-move').EmulationMoveResult>
  cancelEmulationMove(): Promise<void>
  /** The Emulation folder is inside PlayOut's install folder and the user was not asked yet: move it to Documents? */
  getEmulationFolderOffer(): Promise<import('./emulation-move').EmulationFolderOffer | null>
  /** The question was answered: not asked again. */
  answerEmulationFolderOffer(): Promise<void>
  addManualGame(input: {
    exePath: string
    title?: string
    args?: string
    cwd?: string
  }): Promise<Game>
  /** Scan a folder for executables that look like games and add them; returns the added games. */
  addGamesFromFolder(folder: string): Promise<Game[]>

  // --- store accounts / installs (ARCHITECTURE.md §4.8) -----------------------
  /** One status per store, in STORE_SOURCES order. Changes arrive through 'accounts:changed'. */
  getAccounts(): Promise<AccountStatus[]>
  /**
   * Open the store's own sign-in page in a separate window; resolves when that window closes. A sign-in that was
   * cancelled resolves with `signedIn` unchanged. A successful sign-in starts an import of the owned library.
   */
  signIn(source: StoreSourceId): Promise<AccountStatus>
  /** Forget the account: tokens deleted, the sign-in window's storage cleared. Owned-only games lose `owned`. */
  signOut(source: StoreSourceId): Promise<AccountStatus>
  /** Import the owned libraries of the given signed-in sources (every signed-in supported source when omitted). */
  importOwned(sources?: StoreSourceId[]): Promise<ImportOwnedResult>
  /**
   * Hand an owned, not installed game to its store client's install flow and start tracking the install; while
   * another game downloads it is added to the install queue instead (`queued` set) and handed over in its turn.
   */
  installGame(id: string): Promise<InstallResult>
  /** A Steam game's DLC with Steam's current choice for each (main steam-dlc/). Rejects for a game that is not Steam's. */
  steamDlc(gameId: string): Promise<SteamDlcInfo>
  /**
   * Turn a Steam game's DLC on or off: `disabled` lists every DLC to turn off (the rest are on). Installed game:
   * applied now (Steam closed and opened again). Not installed: saved and applied once its install finishes.
   */
  setSteamDlc(gameId: string, disabled: number[]): Promise<SteamDlcResult>
  /** Open the game's page in Steam (its Manage DLC lives there): `steam://nav/games/details/<appid>`. */
  openSteamDlcPage(gameId: string): Promise<void>
  /**
   * The game page's Upgrade menu (PC games, main upgrades/): what each upgrade can do for the installed game now (its
   * DLSS / FSR / XeSS files, DLSS 5, shader precompiling, OptiScaler, compression) and its ban-risk signals.
   */
  upgradeStatus(gameId: string): Promise<import('./upgrades').UpgradeStatus>
  /** Run an Upgrade menu action; progress comes as 'upgrades:progress', and the new status is returned. */
  runUpgrade(
    gameId: string,
    action: import('./upgrades').UpgradeAction
  ): Promise<import('./upgrades').UpgradeStatus>
  /** Stop the game's running upgrade (shader precompiling, compression), if any. */
  cancelUpgrade(gameId: string): Promise<void>
  /** The PC's fixed drives with their size and free space (Settings › Storage). Empty when Windows cannot say. */
  getStorageDrives(): Promise<import('./types').StorageDrive[]>
  /** Stop tracking an install (the client keeps downloading; the next scan still picks the game up). */
  cancelInstallTracking(id: string): Promise<void>
  /** Every install currently tracked, so a reloaded renderer can restore its progress bars. */
  getInstalls(): Promise<InstallProgress[]>
  /** The install queue: the game downloading now first, then the ones waiting. Changes arrive as 'installs:queue'. */
  getInstallQueue(): Promise<InstallQueueEntry[]>
  /**
   * Take a game out of the queue. A waiting one is just removed. The active one: a ROM download from another PC is
   * cancelled; a store install stops being tracked (the store may keep downloading) and the next game starts.
   */
  removeFromInstallQueue(gameId: string): Promise<void>
  /** Move a waiting game one place earlier (-1) or later (1); the active download keeps its place. */
  moveInInstallQueue(gameId: string, delta: -1 | 1): Promise<void>
  /**
   * Pause one game of the install queue (InstallQueueEntry.paused), or every game when gameId is null. The next game
   * not paused starts; an active store install stays active (PlayOut cannot pause a store's download: its downloads page
   * opens so the user pauses it there).
   */
  pauseInstall(gameId: string | null): Promise<void>
  /** Resume one paused game (or every one when gameId is null); it downloads in its turn. */
  resumeInstall(gameId: string | null): Promise<void>

  // --- emulation -------------------------------------------------------------
  getSystems(): Promise<SystemInfo[]>
  getEmulators(): Promise<EmulatorStatus[]>
  setEmulatorPath(emulatorId: string, path: string | null): Promise<EmulatorStatus[]>
  /** The emulators PlayOut installs: where, which are installed, and the setup's progress. */
  getEmulatorSetup(): Promise<EmulatorSetupStatus>
  /** Download and set up these emulators (all missing ones when omitted), in the background. */
  setupEmulators(ids?: string[]): Promise<EmulatorSetupStatus>
  /**
   * Update every emulator PlayOut installed to its newest nightly build (stable where none is published). Resolves
   * when the run has ended, with its report as the status's lastUpdate (the progress goes out meanwhile).
   */
  updateEmulators(): Promise<EmulatorSetupStatus>
  /** Import metadata and media from an existing ES-DE installation (gamelists + downloaded_media). */
  importEsde(): Promise<ImportResult>

  // --- launching -------------------------------------------------------------
  launchGame(id: string, options?: { emulatorId?: string }): Promise<LaunchResult>
  /** The game currently tracked as running, if any. */
  getRunningGame(): Promise<{ gameId: string; startedAt: string } | null>

  // --- metadata --------------------------------------------------------------
  /** Queue metadata + artwork fetching for the given games (all games without metadata when omitted). */
  /**
   * Scrape games again: `ids`, else every game whose metadata never finished plus (without `force`, "Refresh
   * missing") every matched game missing art, whose missing art only is looked for. Resolves to how many were queued.
   */
  refreshMetadata(ids?: string[], options?: { force?: boolean }): Promise<{ queued: number }>
  searchMetadata(gameId: string, query: string): Promise<MetadataCandidate[]>
  applyMetadata(gameId: string, candidate: MetadataCandidate): Promise<Game>
  /** Steam games: the Steam Web API (signed-in account or Settings key). ROMs: RetroAchievements. */
  getAchievements(gameId: string): Promise<AchievementsInfo | null>
  /**
   * A Steam game's store-page screenshots (fetched from Steam the first time and then kept with the game for a month);
   * null for a game that is not a Steam game, or when Steam cannot be reached and none were saved.
   */
  getSteamScreenshots(gameId: string): Promise<SteamScreenshot[] | null>
  /**
   * The game panel opened: measure an installed game that has no size yet, or fetch the store's storage requirement
   * for one that is not installed. Resolves with the game afterwards.
   */
  refreshInstallSize(gameId: string): Promise<Game | null>
  /**
   * A Steam game's panel is open: read the players online now (Steam's Web API, again after ten minutes) and the
   * all-time peak (SteamCharts, again after a day). Resolves with the game afterwards (null for other games).
   */
  refreshLivePlayers(gameId: string): Promise<Game | null>
  /**
   * The Library shows the Active Players sort: read the latest player count of every Steam game from SteamCharts (one
   * game at a time, skipping counts younger than six hours). Resolves when the run is through; the games arrive as
   * 'library:changed' batches meanwhile.
   */
  refreshActivePlayers(): Promise<void>
  /**
   * The Library shows the H.L.T.B. sort: look up the HowLongToBeat times of the games that have none (never looked up,
   * or HLTB had no match for over a month), one game at a time at HLTB's pace, stopping while HLTB is paused. One run
   * at a time; resolves when it is through. Progress arrives as 'hltb:progress', the games as 'library:changed' batches.
   */
  refreshHltbTimes(): Promise<void>
  /** The Library no longer shows the H.L.T.B. sort (another sort, a tab's settings, another screen): refreshHltbTimes's run stops after the lookup in progress. */
  stopHltbTimes(): Promise<void>
  /** Copy a user-chosen image into the media cache and set it as the game's cover/hero/logo/icon. */
  setCustomMedia(
    gameId: string,
    kind: 'cover' | 'hero' | 'logo' | 'icon',
    filePath: string | null
  ): Promise<Game>

  // --- settings --------------------------------------------------------------
  getSettings(): Promise<Settings>
  updateSettings(patch: SettingsPatch): Promise<Settings>
  /**
   * Ask a metadata service whether these credentials work (Settings › Metadata tests what the user typed). Never
   * rejects for a network or service problem: those come back as `unchecked`.
   */
  testCredentials<S extends CredentialService>(
    service: S,
    credentials: ServiceCredentials<S>
  ): Promise<CredentialCheck>
  /** The RetroAchievements account (Settings › Emulators). Changes arrive through 'retroachievements:status'. */
  getRetroAchievementsStatus(): Promise<RetroAchievementsStatus>
  /** Check the account again and refresh every ROM's achievement counts. */
  syncRetroAchievements(): Promise<RetroAchievementsStatus>

  // --- dialogs ---------------------------------------------------------------
  chooseFolder(title?: string): Promise<string | null>
  chooseFile(options?: {
    title?: string
    filters?: { name: string; extensions: string[] }[]
  }): Promise<string | null>

  // --- system ----------------------------------------------------------------
  getSystemStatus(): Promise<SystemStatus>
  setVolume(level: number): Promise<void>
  setMuted(muted: boolean): Promise<void>
  setBrightness(percent: number): Promise<void>
  setPowerMode(mode: PowerMode): Promise<void>
  powerAction(action: PowerAction): Promise<void>
  openWindowsSettings(page: WindowsSettingsPage): Promise<void>
  getPerfSample(): Promise<PerfSample>

  // --- app / window ----------------------------------------------------------
  getAppInfo(): Promise<AppInfo>
  setFullscreen(fullscreen: boolean): Promise<void>
  isFullscreen(): Promise<boolean>
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  showItemInFolder(path: string): Promise<void>
  /**
   * Open each folder in File Explorer (the Library's folder button; at most 10): the ones that exist are opened, the
   * rest are returned as missing. `recompilations`: the Recompilations folder too (Filters > Recompilations).
   */
  openFolders(
    paths: string[],
    options?: { recompilations?: boolean }
  ): Promise<{ opened: string[]; missing: string[] }>
  /** Show the Windows touch keyboard (no-op where unavailable). */
  showTouchKeyboard(): Promise<void>

  // --- app updates (ARCHITECTURE.md §4.9) --------------------------------------
  /** Where the update stands, so a reopened Settings tab can restore its progress bar. */
  getUpdateStatus(): Promise<UpdateStatus>
  /** Look for a newer GitHub release. Every step also arrives through 'update:status'. */
  checkForUpdates(): Promise<UpdateStatus>
  /** Download the release a check found; resolves when the download ended. */
  downloadUpdate(): Promise<UpdateStatus>
  /** Close PlayOut, run the downloaded installer and reopen. Rejects while a game is running. */
  installUpdate(): Promise<UpdateStatus>

  // --- Co-Op (Nucleus Co-op split-screen, ARCHITECTURE.md §4.12) ----------------
  /** How many handlers are downloaded and games matched, and whether the tools and helper are there. */
  getCoopStatus(): Promise<CoopStatus>
  /** Download every Co-Op handler (zipped; progress on 'coop:progress'), then match them to the library. */
  downloadCoopHandlers(): Promise<CoopStatus>
  /** What Co-Op would do for a game now: exe, players, devices, layout, or why it cannot start. */
  getCoopPlan(gameId: string): Promise<CoopPlan>
  /** Start a Co-Op session (progress on 'coop:session'); rejects when it cannot start. */
  playCoop(gameId: string): Promise<void>
  /** End the game's Co-Op session (every instance closes, files are restored). */
  stopCoop(gameId: string): Promise<void>
  /** Delete the game's extracted handler (the zipped package stays: it is extracted again when played). */
  removeCoopHandler(gameId: string): Promise<void>
  /** Whether the game's handler is extracted (Remove Co-Op handler is offered then). */
  isCoopHandlerExtracted(gameId: string): Promise<boolean>

  // --- PeerParty (LAN play, main/peerparty) ---------------------------------------
  /** Whether the game page offers PeerParty; may answer `checking` first, then 'peerparty:status'. */
  peerPartyStatus(gameId: string): Promise<import('./peerparty').PeerPartyStatus>
  /** Start the game through PeerParty (downloads or updates PeerParty first; progress on 'peerparty:progress'). */
  playWithPeerParty(gameId: string): Promise<LaunchResult>
  /**
   * Filters > L.A.N. Party: the games PeerParty is offered for. Folders never scanned are then checked in the
   * background, one at a time ('peerparty:status' for each, 'peerparty:compatible' when all are done).
   */
  peerPartyCompatible(): Promise<import('./peerparty').PeerPartyCompatible>
  /** The game running through PeerParty now, or null. */
  peerPartySession(): Promise<import('./peerparty').PeerPartySession | null>
  /**
   * The overlay's PeerParty tab (shown instead of Friends while the game under the overlay runs through PeerParty):
   * whether LAN play is on and how many players of the game PeerParty sees on the network. Read only while the tab is
   * open.
   */
  peerPartyOverlay(): Promise<import('./peerparty').PeerPartyOverlayStatus>
  /** The PeerParty tab's "Invite everyone on the LAN": asks the PeerParty game to invite every player on the network. */
  peerPartyInvite(): Promise<import('./peerparty').PeerPartyInviteResult>

  // --- Convert (Settings › Convert: Game Format Converter, downloaded on first use) -----
  /** The converter (downloaded or not) and the current or last run. */
  getConvertStatus(): Promise<ConvertStatus>
  /** What a conversion direction needs that this PC lacks (keys, emulators), each with where it goes. */
  checkConvert(request: Omit<ConvertRequest, 'paths'>): Promise<ConvertMissing[]>
  /** Pick the files (or folders) to convert: the direction's format only, several at once. */
  chooseConvertPaths(request: Omit<ConvertRequest, 'paths'>): Promise<string[]>
  /** Start converting (progress on 'convert:progress'); rejects while one runs or when something blocks it. */
  startConvert(request: ConvertRequest): Promise<ConvertStatus>
  stopConvert(): Promise<void>
  /** Open the folder a missing key goes in (made when it is not there yet). */
  openConvertPlace(need: ConvertNeed): Promise<void>

  // --- Recompilations (main/recomp; the UP button, the Recompilation page, Settings › Recompilations) ----
  /** The game's recompilations (null = none): versions, what is installed, updates, game files. */
  getGameRecomps(gameId: string): Promise<GameRecomps | null>
  /** Use `recompId` for the game from now on (the UP button launches it). */
  setPreferredRecomp(gameId: string, recompId: string): Promise<void>
  /** Download and install a recompilation (progress on 'recomp:progress'); `tag` = a specific release. */
  installRecomp(recompId: string, tag?: string): Promise<void>
  /** Update one installed recompilation to its newest release. */
  updateRecomp(recompId: string): Promise<void>
  /**
   * Switch an installed recompilation to another release of the same project (`tag`) through the install pipeline
   * (saves, game files and the chosen program are kept as an update keeps them). A release older than the newest
   * pins it there (pinnedTag: automatic updates and Update all skip it); the newest clears the pin. `tag` null =
   * Back to latest: install the newest release and clear the pin.
   */
  setRecompVersion(recompId: string, tag: string | null): Promise<void>
  /** Update every installed recompilation that has an update (one after another). */
  updateAllRecomps(): Promise<void>
  /** Check every installed recompilation for updates now. */
  checkRecompUpdates(): Promise<Record<string, string>>
  uninstallRecomp(recompId: string): Promise<void>
  /** Start the game's recompilation (preferred unless `recompId`); may ask for game files or a save choice first. */
  launchRecomp(gameId: string, recompId?: string): Promise<RecompLaunchResult>
  /** The project's releases (newest first) for the Updates list. */
  getRecompReleases(recompId: string): Promise<RecompRelease[]>
  /** The project's README (Markdown), '' when it has none or GitHub cannot be reached. */
  getRecompReadme(recompId: string): Promise<string>
  /** Pick a file/folder for a game-file need (null path clears it); returns the entry's game-file state. */
  pickRecompGameFile(gameId: string, recompId: string, needId: string): Promise<GameFileState[]>
  setRecompGameFile(
    gameId: string,
    recompId: string,
    needId: string,
    path: string | null
  ): Promise<GameFileState[]>
  /** The program the recompilation starts and the programs in its folder it could start instead. */
  listRecompExecutables(recompId: string): Promise<RecompExecutables>
  /**
   * Start `path` from now on (a `path` from listRecompExecutables: relative to the install folder, or a full path);
   * null = Automatic (PlayOut's own pick). It must be an existing .exe file.
   */
  setRecompExecutable(recompId: string, path: string | null): Promise<RecompExecutables>
  /** Choose the program in a file picker (.exe; it may be outside the install folder). Unchanged when cancelled. */
  pickRecompExecutable(recompId: string): Promise<RecompExecutables>
  /** Settings › Recompilations. */
  getRecompSettings(): Promise<RecompSettingsView>
  /** Every recompilation in the catalogs, by game (Settings › Recompilations › Browse). */
  browseRecomps(): Promise<RecompBrowseView>
  /** Favourite (or not) one recompilation in the browser; its own library card follows. */
  setRecompFavorite(recompId: string, favorite: boolean): Promise<void>
  /** Add one recompilation to the library as its own card (not installed); the card's game id. */
  addRecompToLibrary(recompId: string): Promise<string>
  /** Fetch both catalogs again and re-match the library. */
  refreshRecompCatalog(): Promise<RecompCatalogStatus>
  setRecompAutoUpdate(recompId: string, on: boolean): Promise<void>
  /** Use these save folders (templates or real paths); null = detect them again. */
  setRecompSavePaths(recompId: string, paths: string[] | null): Promise<string[]>
  /**
   * Add a save folder: `path` (a suggestion from findRecompSaveFolders), else one picked in a folder picker. Returns
   * the save folders in use. Folders too broad to copy (AppData, Documents, the install folder...) are refused.
   */
  addRecompSaveFolder(recompId: string, path?: string): Promise<string[]>
  /** The save folders, suggestions and where the copies live (the Recompilation page's Saves section). */
  getRecompSaves(recompId: string): Promise<RecompSaves>
  /**
   * Look for the save folders in the usual places (Documents, Saved Games, AppData, the install folder): one found
   * while none is known is used; otherwise what is found is offered as suggestions.
   */
  findRecompSaveFolders(recompId: string): Promise<RecompSaves>
  /** Copy this recompilation's saves to and from the Emulation folder (on by default). */
  setRecompCloud(recompId: string, enabled: boolean): Promise<void>
  /** Bring this recompilation's saves and their copy in the Emulation folder in step now. */
  syncRecompSaves(recompId: string): Promise<RecompCloudState>
  /** Both sides changed: keep this PC's saves ('local') or the Emulation folder's copy ('cloud'); the other is backed up. */
  resolveRecompConflict(recompId: string, keep: 'local' | 'cloud'): Promise<RecompCloudState>
  /** Open the install folder, the first save folder, or the folder holding the copies in the Emulation folder. */
  openRecompFolder(recompId: string, which: 'install' | 'saves' | 'copies'): Promise<void>
  /**
   * The "Delete the original disc image?" questions waiting for an answer (also sent on 'recomp:image-offers'): asked
   * when the player identified a recompilation's program, or after PlayOut's own pick started the game twice.
   */
  getRecompImageOffers(): Promise<RecompImageOffer[]>
  /**
   * Answer one: 'delete' moves the image (its whole file set) to the Recycle Bin and keeps the card, which then starts
   * the recompilation; 'delete-folder' moves the unpacked game folder the question offers there, 'delete-both' both;
   * 'keep' is remembered for everything it asked about (never asked again), and so is the item a delete left out.
   * `ok` false: nothing more was deleted (`message` says why). Re-checked when answering.
   */
  answerRecompImageOffer(
    key: string,
    answer: RecompDeleteChoice | 'keep'
  ): Promise<{ ok: boolean; message: string }>
  /**
   * Ask about the game's disc image and/or the game folder PlayOut unpacked for its setup program again (the
   * Recompilation page), even after Keep it; rejects when neither may go.
   */
  askRecompImageDelete(gameId: string, recompId: string): Promise<RecompImageOffer>
  /**
   * Disc images (and unpacked game folders) a Delete answer moved aside while the recompilation is started to check
   * it runs without them (also sent on 'recomp:held-images'); see RecompHeldImage.
   */
  getRecompHeldImages(): Promise<RecompHeldImage[]>
  /**
   * Answer a held image's question: 'restore' puts every file back at its exact path (never over something there now)
   * and makes the card an ordinary ROM card again (the image is then kept for that recompilation); 'delete' moves them
   * to the Recycle Bin; 'retry' starts the test again. `ok` false: `message` says what stayed.
   */
  answerRecompHeldImage(
    holdId: string,
    answer: RecompHeldAnswer
  ): Promise<{ ok: boolean; message: string }>

  // --- VR mods (main/vr-mods; Settings › VR and its browser) -------------------------------------
  /** The VR mod list, what is downloaded and the updates found. */
  getVrMods(): Promise<VrModsView>
  /** A GitHub mod's releases (newest first); rejects when GitHub cannot be reached and nothing is cached. */
  getVrModReleases(modId: string): Promise<VrModRelease[]>
  /** A GitHub mod's README (Markdown), '' when it has none or GitHub cannot be reached. */
  getVrModReadme(modId: string): Promise<string>
  /**
   * Download a GitHub mod's release into its folder in the VR Mods folder (progress on 'vr-mods:progress'); `tag` = a
   * specific release. Archives are unpacked; any other file is kept as it is. Nothing is ever run.
   */
  downloadVrMod(modId: string, tag?: string): Promise<void>
  /** Download the newest release of a downloaded mod over it. */
  updateVrMod(modId: string): Promise<void>
  /** Check every downloaded mod for a newer release now: the newer tag by id. */
  checkVrModUpdates(): Promise<Record<string, string>>
  /** Delete a downloaded mod's folder. */
  removeVrMod(modId: string): Promise<void>
  /** Open a downloaded mod's folder, or the VR Mods folder (no id). */
  openVrModFolder(modId?: string | null): Promise<void>

  // --- streaming (ARCHITECTURE.md §4.13) ---------------------------------------
  /** Both sides of Streaming: this PC as host (Sunshine, port forwarding, PIN, clients) and as client (hosts). */
  getStreamingStatus(): Promise<StreamingStatus>
  /** Host: show a new 4-digit PIN a client can pair with (valid a few minutes). Rejects while locked out. */
  startStreamingPairing(): Promise<StreamingStatus>
  /** Host: stop accepting the shown PIN. */
  cancelStreamingPairing(): Promise<StreamingStatus>
  /** Host: forget a paired client (it can no longer see or stream this PC's games). */
  removeStreamingClient(clientId: string): Promise<StreamingStatus>
  /** Client: look for PlayOut hosts on the local network (a few seconds). */
  findStreamingHosts(): Promise<DiscoveredHost[]>
  /** PlayOut's first start on this PC: the PlayOut hosts found on the network, to offer pairing with one ([] else). */
  firstStartHosts(): Promise<DiscoveredHost[]>
  /** Client: pair with the host at `address` (IP or name, optional :port) using the PIN it shows. */
  pairStreamingHost(address: string, pin: string): Promise<PairedHost>
  /** Client: forget a paired host (also unpairs on the host when it can be reached). */
  removeStreamingHost(hostId: string): Promise<StreamingStatus>
  /** A paired host's internet address or name (null forgets it); its games are fetched again from there. */
  setStreamingHostAddress(hostId: string, address: string | null): Promise<StreamingStatus>
  /** Client: the paired hosts' games (host-only games and this PC's games a host also has). */
  getRemoteLibrary(): Promise<RemoteLibrary>
  /** Client: ask every paired host for its games again. */
  refreshRemoteLibrary(): Promise<RemoteLibrary>
  /**
   * Client: stream a game from a host (progress on 'streaming:session'). `gameId` is a `remote:` id, or this PC's
   * game id with `hostId` (a game both PCs have). Resolves once Moonlight started; rejects when it cannot start.
   */
  streamGame(gameId: string, hostId?: string): Promise<void>
  /** Client: end the running stream (the game closes on the host). */
  stopStream(): Promise<void>
  /**
   * Client: make a host-only game (`remote:` id) a favourite or not, on its host(s) (the favourites sync,
   * Settings › Streaming). The remote library ('streaming:library') shows the change. Rejects while the sync is off
   * here or when no host of the game takes it (unreachable, or an older PlayOut).
   */
  setRemoteFavorite(gameId: string, favorite: boolean): Promise<void>
  /**
   * Client: download a host-only ROM game into this PC's ROM folder (progress on 'streaming:download'). While another
   * game downloads it waits in the install queue ('installs:queue') and starts in its turn.
   */
  downloadRemoteRom(gameId: string): Promise<void>
  cancelRemoteRomDownload(gameId: string): Promise<void>

  // --- home button and overlay (docs/home-overlay.md) -------------------------
  /** The home button: the controller reader, the pads, the Steam and Game Bar overrides, clashes. */
  getHomeButtonStatus(): Promise<import('./overlay').HomeButtonStatus>
  /**
   * Record a new combo: the buttons held arrive on 'home:capture' until every button is released (done). While it
   * records, the home button does not open the overlay. Resolves at once.
   */
  startComboCapture(): Promise<void>
  stopComboCapture(): Promise<void>
  /** Open the overlay (as the home button would); close it. */
  openOverlay(): Promise<void>
  closeOverlay(): Promise<void>
  getOverlayState(): Promise<import('./overlay').OverlayState>
  /** Bring PlayOut's own window back (closing the overlay). */
  showPlayOut(): Promise<void>
  /** End the running game (closing the overlay). */
  quitRunningGame(): Promise<boolean>

  // --- performance (the overlay's Power section) ------------------------------
  getPerformanceStatus(): Promise<import('./overlay').PerformanceStatus>
  /**
   * Switch to a profile now ('none': back to how Windows was before PlayOut changed it; 'dynamic': Dynamic TDP, with
   * the power helper). `forGame`: also keep it as that game's own profile (null clears the game's profile).
   * `options.targetFps`: Dynamic TDP's frame rate (kept as the game's own with `forGame`).
   */
  applyPowerProfile(
    profile: import('./overlay').PowerChoice | 'none',
    forGame?: string | null,
    options?: { targetFps?: number }
  ): Promise<import('./overlay').PerformanceStatus>
  /** Install the elevated power helper for watts (one Windows administrator prompt). */
  installPowerHelper(): Promise<import('./overlay').PerformanceStatus>
  removePowerHelper(): Promise<import('./overlay').PerformanceStatus>
  /** "Free up memory while PlayOut is running" (shared/memory.ts): the setting, the helper's part, the last pass. */
  getMemoryStatus(): Promise<import('./memory').MemoryStatus>
  /** Wake with the Xbox button (Settings › System): the Xbox devices that can wake the PC, read now. */
  getControllerWakeStatus(): Promise<import('./controller-wake').ControllerWakeStatus>
  /**
   * Run a memory cleanup pass now, with every exclusion of an automatic one (also with the setting off). Resolves
   * with the status once the pass has ended (`last.error` says when it did nothing); rejects while PlayOut is not
   * ready for one.
   */
  freeMemoryNow(): Promise<import('./memory').MemoryStatus>

  // --- display -------------------------------------------------------------------
  /** The overlay's monitor: its current mode and the modes it supports. */
  getDisplayStatus(): Promise<import('./overlay').DisplayStatus | null>
  setDisplayMode(
    mode: import('./overlay').DisplayMode
  ): Promise<import('./overlay').DisplayStatus | null>

  // --- overlay extras (shared/overlay-extras.ts) ---------------------------------
  /** The extra tiles' state: frame limit, sync, performance overlay, Auto HDR, CPU boost, RTSS. */
  getOverlayExtras(): Promise<import('./overlay-extras').OverlayExtrasStatus>
  /** The header chips' live fps and watts (the overlay polls it about once a second while open). */
  getLiveStats(): Promise<import('./overlay-extras').LiveStats>
  /**
   * Limit the running game's frame rate (0 = unlimited: RTSS's per-game profile is put back as it was) and remember
   * it for that game. Rejects when the limit cannot be applied (status.frameLimit.reason says why).
   */
  setFrameLimit(fps: number): Promise<import('./overlay-extras').OverlayExtrasStatus>
  /** The frame limit follows the display's refresh rate (settings.performance.syncFpsToRefresh). */
  setFrameLimitSync(enabled: boolean): Promise<import('./overlay-extras').OverlayExtrasStatus>
  /** The performance overlay's level (settings.performance.perfOverlay); 0 turns it off. */
  setPerfOverlayLevel(
    level: import('./overlay-extras').PerfOverlayLevel
  ): Promise<import('./overlay-extras').OverlayExtrasStatus>
  /** Windows' global Auto HDR switch (games started afterwards). */
  setAutoHdr(enabled: boolean): Promise<import('./overlay-extras').OverlayExtrasStatus>
  /** CPU boost of the profile in effect (Custom's own setting, or a preset's override). */
  setCpuBoost(enabled: boolean): Promise<import('./overlay-extras').OverlayExtrasStatus>
  /** The Intel graphics driver settings the overlay offers (Endurance Gaming); empty features when absent. */
  getIntelGraphics(): Promise<import('./overlay-extras').IntelGraphicsStatus>
  /**
   * Endurance Gaming (global, every game): one of status.enduranceGaming.options[].key ('off', 'auto:balanced', ...).
   * Answers with the value read back from the driver; rejects a key the driver does not list.
   */
  setEnduranceGaming(value: string): Promise<import('./overlay-extras').IntelGraphicsStatus>

  // --- media and music ----------------------------------------------------------------
  /** What Windows is playing now (any app), or null. */
  getMediaSession(): Promise<import('./overlay').MediaSession | null>
  mediaControl(
    action: import('./overlay').MediaAction
  ): Promise<import('./overlay').MediaSession | null>
  /** The music folder's tracks (`playout-music://track/<path>` plays one). */
  getMusicLibrary(): Promise<import('./overlay').MusicLibrary>
  /** Pick the music folder (a folder dialog); null when cancelled. */
  chooseMusicFolder(): Promise<string | null>

  // --- friends (shared/friends.ts) ----------------------------------------------------
  /**
   * The overlay's Friends tab: the user's Steam friends and what they play (Steam Web API key + SteamID64 of
   * Settings › Metadata). An answer under 30 s old is served again unless `refresh`. Never rejects: `error` says why
   * the list could not be read.
   */
  getSteamFriends(options?: { refresh?: boolean }): Promise<import('./friends').SteamFriendsStatus>
  /** Close the overlay and open Steam's chat with that friend (steam://friends/message/<SteamID64>). */
  messageSteamFriend(steamId: string): Promise<void>

  // --- events ----------------------------------------------------------------
  /** Subscribe to a main-process event; returns an unsubscribe function. */
  on<E extends PlayOutEventName>(
    event: E,
    listener: (payload: PlayOutEvents[E]) => void
  ): () => void
}

/** Names of every invokable method (everything except `on`). Used by preload and the IPC registry. */
export const API_METHODS = [
  'getLibrary',
  'getGame',
  'updateGame',
  'getMetadataLayers',
  'setMetadataEdit',
  'clearMetadataEdit',
  'getMetadataCloudStatus',
  'setMetadataCloudConfig',
  'checkMetadataCloudToken',
  'syncMetadataCloud',
  'listMetadataSuggestions',
  'resolveMetadataSuggestion',
  'shareMetadataRelayUrl',
  'removeGame',
  'getLocalDeletePlan',
  'deleteGameLocally',
  'updatePs3Game',
  'getSessions',
  'getSources',
  'scanSources',
  'generateFolders',
  'planEmulationMove',
  'startEmulationMove',
  'cancelEmulationMove',
  'getEmulationFolderOffer',
  'answerEmulationFolderOffer',
  'addManualGame',
  'addGamesFromFolder',
  'getAccounts',
  'signIn',
  'signOut',
  'importOwned',
  'installGame',
  'steamDlc',
  'setSteamDlc',
  'openSteamDlcPage',
  'upgradeStatus',
  'runUpgrade',
  'cancelUpgrade',
  'getStorageDrives',
  'cancelInstallTracking',
  'getInstalls',
  'getInstallQueue',
  'removeFromInstallQueue',
  'moveInInstallQueue',
  'pauseInstall',
  'resumeInstall',
  'getSystems',
  'getEmulators',
  'setEmulatorPath',
  'getEmulatorSetup',
  'setupEmulators',
  'updateEmulators',
  'importEsde',
  'launchGame',
  'getRunningGame',
  'refreshMetadata',
  'searchMetadata',
  'applyMetadata',
  'getAchievements',
  'getSteamScreenshots',
  'refreshInstallSize',
  'refreshLivePlayers',
  'refreshActivePlayers',
  'refreshHltbTimes',
  'stopHltbTimes',
  'setCustomMedia',
  'getSettings',
  'updateSettings',
  'testCredentials',
  'getRetroAchievementsStatus',
  'syncRetroAchievements',
  'chooseFolder',
  'chooseFile',
  'getSystemStatus',
  'setVolume',
  'setMuted',
  'setBrightness',
  'setPowerMode',
  'powerAction',
  'openWindowsSettings',
  'getPerfSample',
  'getAppInfo',
  'setFullscreen',
  'isFullscreen',
  'openExternal',
  'openPath',
  'showItemInFolder',
  'openFolders',
  'showTouchKeyboard',
  'getUpdateStatus',
  'getCoopStatus',
  'downloadCoopHandlers',
  'getCoopPlan',
  'playCoop',
  'stopCoop',
  'removeCoopHandler',
  'isCoopHandlerExtracted',
  'peerPartyStatus',
  'playWithPeerParty',
  'peerPartyCompatible',
  'peerPartySession',
  'peerPartyOverlay',
  'peerPartyInvite',
  'getConvertStatus',
  'checkConvert',
  'chooseConvertPaths',
  'startConvert',
  'stopConvert',
  'openConvertPlace',
  'getGameRecomps',
  'setPreferredRecomp',
  'installRecomp',
  'updateRecomp',
  'setRecompVersion',
  'updateAllRecomps',
  'checkRecompUpdates',
  'uninstallRecomp',
  'launchRecomp',
  'getRecompReleases',
  'getRecompReadme',
  'pickRecompGameFile',
  'setRecompGameFile',
  'listRecompExecutables',
  'setRecompExecutable',
  'pickRecompExecutable',
  'getRecompSettings',
  'browseRecomps',
  'setRecompFavorite',
  'addRecompToLibrary',
  'refreshRecompCatalog',
  'setRecompAutoUpdate',
  'setRecompSavePaths',
  'addRecompSaveFolder',
  'getRecompSaves',
  'findRecompSaveFolders',
  'setRecompCloud',
  'syncRecompSaves',
  'resolveRecompConflict',
  'openRecompFolder',
  'getRecompImageOffers',
  'answerRecompImageOffer',
  'askRecompImageDelete',
  'getRecompHeldImages',
  'answerRecompHeldImage',
  'getVrMods',
  'getVrModReleases',
  'getVrModReadme',
  'downloadVrMod',
  'updateVrMod',
  'checkVrModUpdates',
  'removeVrMod',
  'openVrModFolder',
  'getStreamingStatus',
  'startStreamingPairing',
  'cancelStreamingPairing',
  'removeStreamingClient',
  'findStreamingHosts',
  'firstStartHosts',
  'pairStreamingHost',
  'removeStreamingHost',
  'setStreamingHostAddress',
  'getRemoteLibrary',
  'refreshRemoteLibrary',
  'streamGame',
  'stopStream',
  'setRemoteFavorite',
  'downloadRemoteRom',
  'cancelRemoteRomDownload',
  'checkForUpdates',
  'downloadUpdate',
  'installUpdate',
  'getHomeButtonStatus',
  'startComboCapture',
  'stopComboCapture',
  'openOverlay',
  'closeOverlay',
  'getOverlayState',
  'showPlayOut',
  'quitRunningGame',
  'getPerformanceStatus',
  'applyPowerProfile',
  'installPowerHelper',
  'removePowerHelper',
  'getMemoryStatus',
  'getControllerWakeStatus',
  'freeMemoryNow',
  'getDisplayStatus',
  'setDisplayMode',
  'getOverlayExtras',
  'getLiveStats',
  'setFrameLimit',
  'setFrameLimitSync',
  'setPerfOverlayLevel',
  'setAutoHdr',
  'setCpuBoost',
  'getIntelGraphics',
  'setEnduranceGaming',
  'getMediaSession',
  'mediaControl',
  'getMusicLibrary',
  'chooseMusicFolder',
  'getSteamFriends',
  'messageSteamFriend'
] as const satisfies readonly (keyof PlayOutApi)[]

export type ApiMethod = (typeof API_METHODS)[number]

/**
 * Compile-time completeness check: every PlayOutApi member except `on` must be listed in API_METHODS. A method left
 * out would compile everywhere else and be undefined on `window.playout` (preload builds the bridge from the array),
 * so a missing name fails the typecheck here, with that name in the error.
 */
type AssertNever<T extends never> = T
export type MissingApiMethod = AssertNever<Exclude<keyof PlayOutApi, ApiMethod | 'on'>>

export const IPC_PREFIX = 'playout:'
export const IPC_EVENT_CHANNEL = 'playout:event'

export function ipcChannel(method: ApiMethod): string {
  return IPC_PREFIX + method
}
