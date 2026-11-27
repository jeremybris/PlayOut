import { RA_NONE } from '@shared/ra-consoles'
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  difficultyLabel,
  isToolsDifficulty,
  tagDifficulty
} from '@shared/difficulty'
import { effectiveEmulatorCommand, findEmulatorCommand } from '@shared/emulators'
import type { MetadataEditField, MetadataLayers } from '@shared/metadata-edit'
import type { Game, GameUserPatch, SystemInfo } from '@shared/types'
import { Image as ImageIcon, ImagePlus, RotateCcw } from 'lucide-react'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { SelectField, type SelectOption } from '../../components/SelectField'
import { Spinner } from '../../components/Spinner'
import { TextField } from '../../components/TextField'
import { Toggle } from '../../components/Toggle'
import { useT, type Translate } from '../../i18n'
import { setFocus } from '../../input/focus'
import { cx } from '../../lib/cx'
import { toggleGenreTag, type GenreTagRow } from '../../lib/genreTagPicker'
import { installSizeText, parseSizeInput } from '../../lib/installSize'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import {
  FIELD_FORM_KEYS,
  fallbackForm,
  fieldChanged,
  fieldMatches,
  fieldOrigin,
  formSave,
  layersAfterSave,
  shownForm,
  type MetadataForm
} from '../../lib/metadataForm'
import { formatBytes } from '../../state/installs'
import { useLibraryStore } from '../../state/library'
import { useSettingsStore } from '../../state/settings'
import { useStreamingStore } from '../../state/streaming'
import { useUiStore } from '../../state/ui'
import { GenresTagsField, GenresTagsSearch } from './GenresTagsField'

const log = createLog('game-edit')

const SHEET_FOCUS_KEY = 'gedit'
const fk = (name: string): string => `${SHEET_FOCUS_KEY}:${name}`

type CustomMediaKind = 'cover' | 'hero' | 'logo'

/** An artwork row's text: whole sentences per kind, as each language says "the cover" its own way. */
interface MediaRowText {
  kind: CustomMediaKind
  label: string
  hint: string
  chooseTitle: string
  chooseAria: string
  resetAria: string
  updated: string
  resetDone: string
  setFailed: string
  resetFailed: string
}

function mediaRows(t: Translate): MediaRowText[] {
  return [
    {
      kind: 'cover',
      label: t('gameDetail.edit.artwork.cover.label'),
      hint: t('gameDetail.edit.artwork.cover.hint'),
      chooseTitle: t('gameDetail.edit.artwork.cover.chooseTitle'),
      chooseAria: t('gameDetail.edit.artwork.cover.chooseAria'),
      resetAria: t('gameDetail.edit.artwork.cover.resetAria'),
      updated: t('gameDetail.edit.artwork.cover.updated'),
      resetDone: t('gameDetail.edit.artwork.cover.resetDone'),
      setFailed: t('gameDetail.edit.artwork.cover.setFailed'),
      resetFailed: t('gameDetail.edit.artwork.cover.resetFailed')
    },
    {
      kind: 'hero',
      label: t('gameDetail.edit.artwork.hero.label'),
      hint: t('gameDetail.edit.artwork.hero.hint'),
      chooseTitle: t('gameDetail.edit.artwork.hero.chooseTitle'),
      chooseAria: t('gameDetail.edit.artwork.hero.chooseAria'),
      resetAria: t('gameDetail.edit.artwork.hero.resetAria'),
      updated: t('gameDetail.edit.artwork.hero.updated'),
      resetDone: t('gameDetail.edit.artwork.hero.resetDone'),
      setFailed: t('gameDetail.edit.artwork.hero.setFailed'),
      resetFailed: t('gameDetail.edit.artwork.hero.resetFailed')
    },
    {
      kind: 'logo',
      label: t('gameDetail.edit.artwork.logo.label'),
      hint: t('gameDetail.edit.artwork.logo.hint'),
      chooseTitle: t('gameDetail.edit.artwork.logo.chooseTitle'),
      chooseAria: t('gameDetail.edit.artwork.logo.chooseAria'),
      resetAria: t('gameDetail.edit.artwork.logo.resetAria'),
      updated: t('gameDetail.edit.artwork.logo.updated'),
      resetDone: t('gameDetail.edit.artwork.logo.resetDone'),
      setFailed: t('gameDetail.edit.artwork.logo.setFailed'),
      resetFailed: t('gameDetail.edit.artwork.logo.resetFailed')
    }
  ]
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp']

const SOURCE_NAMES: Record<string, string> = {
  steamgriddb: 'SteamGridDB',
  igdb: 'IGDB',
  screenscraper: 'ScreenScraper',
  thegamesdb: 'TheGamesDB',
  steam: 'Steam',
  hltb: 'HowLongToBeat',
  gog: 'GOG',
  esde: 'ES-DE'
}

/** The local players the dropdown offers (the values; their text comes at render time, in the current language). */
const PLAYER_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8]

function playerOptionsOf(t: Translate): SelectOption[] {
  return [
    { value: '0', label: t('gameDetail.edit.fields.localPlayers.none') },
    ...PLAYER_COUNTS.map((n) => ({
      value: String(n),
      label: t('gameDetail.players.upTo', { count: n })
    }))
  ]
}
/** The Controls choices (CONTROLS_CHOICES, in its order): what each saves is controlsForChoice's. */
function controlsOptions(t: Translate): SelectOption<MetadataForm['controls']>[] {
  return [
    { value: 'vr', label: t('gameDetail.edit.fields.controls.vr') },
    { value: 'touch', label: t('gameDetail.edit.fields.controls.touch') },
    { value: 'full', label: t('gameDetail.edit.fields.controls.full') },
    { value: 'partial', label: t('gameDetail.edit.fields.controls.partial') },
    { value: 'keyboard', label: t('gameDetail.edit.fields.controls.keyboard') },
    { value: 'both', label: t('gameDetail.edit.fields.controls.both') },
    { value: 'all', label: t('gameDetail.edit.fields.controls.all') }
  ]
}
function scoreSourceOptions(t: Translate): SelectOption<MetadataForm['scoreSource']>[] {
  return [
    { value: 'steam', label: t('gameDetail.edit.fields.rating.steam') },
    { value: 'igdb', label: t('gameDetail.edit.fields.rating.igdb') }
  ]
}

/** The first control of each field: where focus goes when its Reset button goes away. */
const FIELD_FOCUS: Record<MetadataEditField, string> = {
  title: 'title',
  description: 'description',
  shortDescription: 'shortDescription',
  releaseDate: 'releaseDate',
  developers: 'developers',
  publishers: 'publishers',
  // One field for both (GenresTagsField).
  genres: 'genresTags',
  tags: 'genresTags',
  localPlayers: 'localPlayers',
  controls: 'controls',
  hltb: 'hltb:main',
  reviewScore: 'score',
  difficulty: 'difficulty'
}

/**
 * The Genres & Tags field: the game's genres and its tags (Steam's, strongest first) in one dropdown of the Filters ›
 * Genre choices. Still two edit fields, so the cloud keeps them apart.
 */
const GENRES_TAGS: readonly MetadataEditField[] = ['genres', 'tags']

/** Where a field's value comes from. A paired host's game: its "scraped" values are what its host has for it. */
function originTexts(t: Translate, remote: boolean): Record<'local' | 'cloud' | 'scraped', string> {
  return {
    local: t('gameDetail.edit.origin.local'),
    cloud: t('gameDetail.edit.origin.cloud'),
    scraped: remote ? t('gameDetail.edit.origin.host') : t('gameDetail.edit.origin.scraped')
  }
}

export interface GameEditSheetProps {
  game: Game
  onClose: () => void
}

/**
 * The game page's Edit sheet (the pen button): every metadata field the page shows (title, description, release
 * date, developers, publishers, genres and tags (one Genres & Tags dropdown: GenresTagsField), local players, controls, How Long to Beat, rating), each saying where
 * its value comes from (scraped, the PlayOut cloud, your edit) with a Reset back to the cloud's / scraped value; the
 * game's own settings (emulator, launch arguments, install size, hidden); and the custom artwork pickers (local
 * only, applied at once). Save sends the changes (api.setMetadataEdit / updateGame); Cancel or B drops them.
 * A paired host's game (game.remote) shows the metadata fields only: its values come from the host, the edit stays on
 * this PC (main/metadata-edits/remote-edits.ts) and goes with the game if it is downloaded; the settings and artwork
 * are this PC's record's, which a host's game does not have yet.
 * Portaled to <body> so the panel's transform cannot contain it.
 */
export function GameEditSheet({ game, onClose }: GameEditSheetProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [layers, setLayers] = useState<MetadataLayers | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .getMetadataLayers(game.id)
      .then((result) => {
        if (!cancelled) setLayers(result)
      })
      .catch((err) => {
        log.error('getMetadataLayers failed', err)
        if (!cancelled) setFailed(true)
        toast(t('gameDetail.edit.readFailed'), 'error')
      })
    return () => {
      cancelled = true
    }
  }, [game.id, toast, t])

  // The layers come back from main at once: the sheet opens with them (one Modal, so its focus starts on Title).
  if (failed)
    return createPortal(
      <Modal
        size="sheet"
        focusKey={SHEET_FOCUS_KEY}
        title={displayTitle(game)}
        subtitle={t('gameDetail.edit.subtitle')}
        onClose={onClose}
        aria-label={t('gameDetail.edit.label', { title: displayTitle(game) })}
        className="gsheet gedit"
      >
        <div className="gedit__loading">{t('gameDetail.edit.readFailedMessage')}</div>
      </Modal>,
      document.body
    )
  if (!layers) return <></>
  return <EditForm game={game} layers={layers} onClose={onClose} />
}

function EditForm({
  game,
  layers: openedLayers,
  onClose
}: {
  game: Game
  layers: MetadataLayers
  onClose: () => void
}): ReactElement {
  // The layers the form compares with: updated once a Save's metadata part went through, so a retry after a later
  // step failed does not send the same edit (and cloud suggestion) again.
  const [layers, setLayers] = useState(openedLayers)
  const remote = !!game.remote
  const applyLocalGame = useLibraryStore((s) => s.applyGame)
  const applyRemoteGame = useStreamingStore((s) => s.applyRemoteGame)
  // A host's game lives in the remote library, never in this PC's library store.
  const applyGame = remote ? applyRemoteGame : applyLocalGame
  const t = useT()
  const originText = originTexts(t, remote)
  const toast = useUiStore((s) => s.toast)
  const preferredEmulators = useSettingsStore((s) => s.settings?.emulators.preferred)

  const [form, setForm] = useState<MetadataForm>(() => shownForm(layers))
  const [resets, setResets] = useState<ReadonlySet<MetadataEditField>>(() => new Set())
  const [emulatorId, setEmulatorId] = useState(game.user.emulatorId ?? '')
  const [args, setArgs] = useState(game.user.extraArgs ?? '')
  // The field shows the saved size rounded ("46 GB"); left as shown, it keeps the exact bytes the user entered.
  const [seededSize] = useState(() =>
    game.user.installSize ? formatBytes(game.user.installSize) : ''
  )
  const [size, setSize] = useState(seededSize)
  const [hidden, setHidden] = useState(game.hidden)
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [busyMedia, setBusyMedia] = useState<CustomMediaKind | null>(null)
  const [saving, setSaving] = useState(false)

  const systemId = game.launch.kind === 'emulator' ? game.launch.systemId : null
  useEffect(() => {
    if (!systemId) return undefined
    let cancelled = false
    api
      .getSystems()
      .then((systems) => {
        if (!cancelled) setSystem(systems.find((s) => s.id === systemId) ?? null)
      })
      .catch((err) => {
        log.error('getSystems failed', err)
        if (!cancelled) toast(t('gameDetail.toasts.emulatorListFailed'), 'error')
      })
    return () => {
      cancelled = true
    }
  }, [systemId, toast, t])

  const set =
    <K extends keyof MetadataForm>(key: K) =>
    (value: MetadataForm[K]): void =>
      setForm((f) => ({ ...f, [key]: value }))

  /** Reset: the fields go back to the cloud's / scraped values (Genres & Tags resets both of its fields). */
  const reset = (fields: readonly MetadataEditField[]): void => {
    const fallback = fallbackForm(layers)
    setForm((f) => {
      const next = { ...f }
      for (const field of fields)
        for (const key of FIELD_FORM_KEYS[field])
          (next as Record<string, unknown>)[key] = fallback[key]
      return next
    })
    const own = fields.filter((field) => layers.local[field] !== undefined)
    if (own.length)
      setResets((r) => {
        const next = new Set(r)
        for (const field of own) next.add(field)
        return next
      })
    // The Reset button goes away with the change: keep focus in the field's row, not the top of the sheet.
    setFocus(fk(FIELD_FOCUS[fields[0]!]))
  }

  /**
   * The line above a field: its name, where its value comes from, and Reset. A field made of several (Genres & Tags:
   * genres and tags) shows the strongest origin among them (your edit, else the cloud's, else scraped) and resets
   * them all.
   */
  const head = (
    fieldOrFields: MetadataEditField | readonly MetadataEditField[],
    label: string,
    resetLabel: string
  ): ReactNode => {
    const fields: readonly MetadataEditField[] =
      typeof fieldOrFields === 'string' ? [fieldOrFields] : fieldOrFields
    const fallback = fallbackForm(layers)
    const changed = fields.some((field) => fieldChanged(form, layers, field))
    const origins = fields.map((field) => fieldOrigin(layers, field))
    const origin = origins.includes('local')
      ? 'local'
      : origins.includes('cloud')
        ? 'cloud'
        : 'scraped'
    // Reset pressed on the user's own edit: Save removes it (the field shows the cloud's / scraped value again).
    const resetPending =
      fields.some((field) => resets.has(field) && fieldOrigin(layers, field) === 'local') &&
      fields.every((field) => fieldMatches(form, fallback, field))
    const state = resetPending || changed ? 'changed' : origin
    const text = resetPending
      ? fields.some((field) => layers.cloud?.[field] !== undefined)
        ? t('gameDetail.edit.origin.backToCloud')
        : remote
          ? t('gameDetail.edit.origin.backToHost')
          : t('gameDetail.edit.origin.backToScraped')
      : changed
        ? t('gameDetail.edit.origin.changed')
        : origin === 'scraped' && fields.every((field) => layers.scraped[field] === undefined)
          ? t('gameDetail.edit.origin.notSet')
          : originText[origin]
    const canReset = !resetPending && (changed || origin === 'local')
    return (
      <div className="gedit__head">
        <span className="gedit__label">{label}</span>
        <span className={cx('gedit__origin', `gedit__origin--${state}`)}>{text}</span>
        {canReset ? (
          <Button
            focusKey={fk(`${fields.length === 1 ? fields[0] : FIELD_FOCUS[fields[0]!]}:reset`)}
            variant="ghost"
            icon={<RotateCcw />}
            className="gedit__reset"
            onPress={() => reset(fields)}
            aria-label={resetLabel}
          >
            {t('gameDetail.edit.reset')}
          </Button>
        ) : null}
      </div>
    )
  }

  const textField = (
    field: MetadataEditField,
    key: keyof MetadataForm,
    label: string,
    resetLabel: string,
    placeholder: string,
    options: { multiline?: boolean; rows?: number } = {}
  ): ReactElement => (
    <div className="gedit__field" key={field}>
      {head(field, label, resetLabel)}
      <TextField
        focusKey={fk(field)}
        aria-label={label}
        oskTitle={label}
        value={String(form[key])}
        onChange={set(key) as (value: string) => void}
        placeholder={placeholder}
        clearable={!options.multiline}
        multiline={options.multiline}
        rows={options.rows}
      />
    </div>
  )

  const chooseMedia = (row: MediaRowText): void => {
    const { kind } = row
    setBusyMedia(kind)
    api
      .chooseFile({
        title: row.chooseTitle,
        filters: [{ name: t('gameDetail.edit.imagesFilter'), extensions: IMAGE_EXTENSIONS }]
      })
      .then(async (file) => {
        if (!file) return
        const updated = await api.setCustomMedia(game.id, kind, file)
        applyGame(updated)
        toast(row.updated, 'success')
      })
      .catch((err) => {
        log.error(`setCustomMedia ${kind} failed`, err)
        toast(row.setFailed, 'error')
      })
      .finally(() => setBusyMedia(null))
  }
  const resetMedia = (row: MediaRowText): void => {
    const { kind } = row
    setBusyMedia(kind)
    api
      .setCustomMedia(game.id, kind, null)
      .then((updated) => {
        applyGame(updated)
        toast(row.resetDone)
      })
      .catch((err) => {
        log.error(`setCustomMedia ${kind} reset failed`, err)
        toast(row.resetFailed, 'error')
      })
      .finally(() => setBusyMedia(null))
  }

  const save = (): void => {
    if (saving) return
    let plan: ReturnType<typeof formSave>
    try {
      plan = formSave(form, layers, resets)
    } catch (err) {
      toast(err instanceof Error ? err.message : t('gameDetail.edit.checkFields'), 'error')
      return
    }
    const user: NonNullable<GameUserPatch['user']> = {}
    if ((game.user.emulatorId ?? '') !== emulatorId) user.emulatorId = emulatorId || null
    const nextArgs = args.trim()
    if ((game.user.extraArgs ?? '') !== nextArgs) user.extraArgs = nextArgs || null
    if (size.trim() !== seededSize) {
      const nextSize = parseSizeInput(size)
      if (Number.isNaN(nextSize)) {
        toast(t('gameDetail.edit.sizeFormat'), 'error')
        return
      }
      if ((game.user.installSize ?? undefined) !== nextSize) user.installSize = nextSize ?? null
    }
    const patch: GameUserPatch = {}
    // A host's game has no settings here (the sheet does not show them).
    if (!remote && Object.keys(user).length) patch.user = user
    if (!remote && hidden !== game.hidden) patch.hidden = hidden
    const metadataChanged = Object.keys(plan.edit).length > 0 || plan.clear.length > 0
    if (!metadataChanged && !Object.keys(patch).length) {
      onClose()
      return
    }
    setSaving(true)
    void (async () => {
      try {
        if (metadataChanged) {
          const updated = await api.setMetadataEdit(game.id, plan.edit, plan.clear)
          // Saved: from now on the form compares with the new layers, so a retry sends only what is left.
          applyGame(updated)
          const next = layersAfterSave(layers, plan)
          setLayers(next)
          setResets(new Set())
          setForm(shownForm(next))
        }
        if (Object.keys(patch).length) applyGame(await api.updateGame(game.id, patch))
        toast(t('gameDetail.edit.saved'), 'success')
        onClose()
      } catch (err) {
        log.error('saving the game edit failed', err)
        toast(t('gameDetail.edit.saveFailed'), 'error')
        setSaving(false)
      }
    })()
  }

  // "Default": what a launch runs without the game's own choice (the scan's choice, the preferred one, the first).
  const defaultEmulator = system
    ? effectiveEmulatorCommand(
        system,
        { ...game, user: { ...game.user, emulatorId: undefined } },
        preferredEmulators
      )
    : undefined
  const emulatorOptions = system
    ? [
        {
          value: '',
          label: defaultEmulator
            ? t('gameDetail.edit.settings.defaultEmulator', { emulator: defaultEmulator.label })
            : t('gameDetail.edit.settings.default')
        },
        ...system.emulators.map((e) => ({ value: e.id, label: e.label }))
      ]
    : []
  const showArgs = game.launch.kind === 'exec' || game.launch.kind === 'emulator'
  // Default ('') is no pick, so the game takes its Steam tag's level (Visual Novel, Casual, Free to Play, Relaxing,
  // Souls-like, Difficult), else Medium. Saved as the user's edit it also hides a cloud pick (an empty value hides the
  // cloud's, as for any field), which is how a game the cloud calls Hard goes back to its default here. A Utilities
  // game's default is the N/A (Tools) label, which is not a level to pick: picking a level puts the game on it.
  const byTag = tagDifficulty(game)
  const difficultyOptions: SelectOption<MetadataForm['difficulty']>[] = [
    {
      value: '',
      label: byTag
        ? t('gameDetail.edit.fields.difficulty.defaultFromTag', {
            level: isToolsDifficulty(byTag.level)
              ? t('gameDetail.edit.fields.difficulty.tools')
              : difficultyLabel(byTag.level),
            tag: byTag.tag
          })
        : t('gameDetail.edit.fields.difficulty.default', {
            level: difficultyLabel(DEFAULT_DIFFICULTY)
          })
    },
    ...DIFFICULTIES.map((d) => ({ value: d.id, label: d.label }))
  ]
  // A console game always shows the controller badge (lib/controls.ts): its controls are not editable.
  const showControls = game.source !== 'rom' && game.launch.kind !== 'emulator'
  const basePlayerOptions = playerOptionsOf(t)
  const playerOptions =
    form.localPlayers === '' || basePlayerOptions.some((o) => o.value === form.localPlayers)
      ? form.localPlayers === ''
        ? [
            { value: '', label: t('gameDetail.edit.fields.localPlayers.notKnown') },
            ...basePlayerOptions
          ]
        : basePlayerOptions
      : [
          ...basePlayerOptions,
          {
            value: form.localPlayers,
            label: t('gameDetail.players.upTo', { count: Number(form.localPlayers) })
          }
        ]
  // A source that found nothing (RetroAchievements: the game has none) is no source of this game's details.
  const sources = Object.entries(game.metadata.sources ?? {})
    .filter(([, value]) => value !== RA_NONE)
    .map(([id]) => SOURCE_NAMES[id] ?? id)
  const scraped = layers.scraped
  // What the game shows and what Reset goes back to: the Genres & Tags dropdown keeps their genres and tags listed
  // once unticked, and ticking one again puts back the very strings (lib/genreTagPicker.ts).
  const tagBases = [shownForm(layers), fallbackForm(layers)]
  // A row ticked or unticked in the dropdown, or a name picked in the search box under it (it adds that row).
  const toggleTag = (row: GenreTagRow): void =>
    setForm((f) => ({ ...f, ...toggleGenreTag(f, row, tagBases) }))

  return createPortal(
    <Modal
      size="sheet"
      focusKey={SHEET_FOCUS_KEY}
      preferredChildFocusKey={fk('title')}
      title={displayTitle(game)}
      subtitle={t('gameDetail.edit.subtitle')}
      onClose={onClose}
      aria-label={t('gameDetail.edit.label', { title: displayTitle(game) })}
      className="gsheet gedit"
      footer={
        <>
          <Button focusKey={fk('cancel')} onPress={onClose} disabled={saving}>
            {t('gameDetail.edit.cancel')}
          </Button>
          <Button
            focusKey={fk('save')}
            variant="primary"
            icon={saving ? <Spinner size="sm" /> : undefined}
            onPress={save}
            disabled={saving}
          >
            {t('gameDetail.edit.save')}
          </Button>
        </>
      }
    >
      <div className="gsheet__section">
        <div className="gsheet__title">{t('gameDetail.edit.sections.info')}</div>
        {textField(
          'title',
          'title',
          t('gameDetail.edit.fields.title.label'),
          t('gameDetail.edit.fields.title.reset'),
          scraped.title ?? game.title
        )}
        {textField(
          'description',
          'description',
          t('gameDetail.edit.fields.description.label'),
          t('gameDetail.edit.fields.description.reset'),
          t('gameDetail.edit.fields.description.placeholder'),
          {
            multiline: true,
            rows: 6
          }
        )}
        {textField(
          'shortDescription',
          'shortDescription',
          t('gameDetail.edit.fields.shortDescription.label'),
          t('gameDetail.edit.fields.shortDescription.reset'),
          t('gameDetail.edit.fields.shortDescription.placeholder'),
          {
            multiline: true,
            rows: 2
          }
        )}
        {textField(
          'releaseDate',
          'releaseDate',
          t('gameDetail.edit.fields.releaseDate.label'),
          t('gameDetail.edit.fields.releaseDate.reset'),
          t('gameDetail.edit.fields.releaseDate.placeholder')
        )}
        {textField(
          'developers',
          'developers',
          t('gameDetail.edit.fields.developers.label'),
          t('gameDetail.edit.fields.developers.reset'),
          t('gameDetail.edit.fields.developers.placeholder')
        )}
        {textField(
          'publishers',
          'publishers',
          t('gameDetail.edit.fields.publishers.label'),
          t('gameDetail.edit.fields.publishers.reset'),
          t('gameDetail.edit.fields.publishers.placeholder')
        )}
        <div className="gedit__field">
          {head(
            GENRES_TAGS,
            t('gameDetail.edit.fields.genresTags.label'),
            t('gameDetail.edit.fields.genresTags.reset')
          )}
          <GenresTagsField
            focusKey={fk('genresTags')}
            form={form}
            bases={tagBases}
            onToggle={toggleTag}
          />
          <GenresTagsSearch
            focusKey={fk('genresTags:search')}
            form={form}
            bases={tagBases}
            onAdd={toggleTag}
          />
        </div>
      </div>

      <div className="gsheet__section">
        <div className="gsheet__title">{t('gameDetail.edit.sections.players')}</div>
        <div className="gedit__field">
          {head(
            'localPlayers',
            t('gameDetail.edit.fields.localPlayers.label'),
            t('gameDetail.edit.fields.localPlayers.reset')
          )}
          <SelectField
            focusKey={fk('localPlayers')}
            label={t('gameDetail.edit.fields.localPlayers.select')}
            value={form.localPlayers}
            options={playerOptions}
            onChange={set('localPlayers')}
          />
        </div>
        {showControls ? (
          <div className="gedit__field">
            {head(
              'controls',
              t('gameDetail.edit.fields.controls.label'),
              t('gameDetail.edit.fields.controls.reset')
            )}
            <SelectField
              focusKey={fk('controls')}
              label={t('gameDetail.edit.fields.controls.label')}
              value={form.controls}
              options={controlsOptions(t)}
              onChange={set('controls')}
            />
          </div>
        ) : null}
      </div>

      <div className="gsheet__section">
        <div className="gsheet__title">{t('gameDetail.edit.sections.time')}</div>
        <div className="gedit__field">
          {head(
            'hltb',
            t('gameDetail.edit.fields.hltb.label'),
            t('gameDetail.edit.fields.hltb.reset')
          )}
          <div className="gedit__grid">
            <TextField
              focusKey={fk('hltb:main')}
              label={t('gameDetail.edit.fields.hltb.main')}
              value={form.hltbMain}
              onChange={set('hltbMain')}
              placeholder="—"
            />
            <TextField
              focusKey={fk('hltb:extra')}
              label={t('gameDetail.edit.fields.hltb.extra')}
              value={form.hltbExtra}
              onChange={set('hltbExtra')}
              placeholder="—"
            />
            <TextField
              focusKey={fk('hltb:completionist')}
              label={t('gameDetail.edit.fields.hltb.completionist')}
              value={form.hltbCompletionist}
              onChange={set('hltbCompletionist')}
              placeholder="—"
            />
            <TextField
              focusKey={fk('hltb:solo')}
              label={t('gameDetail.edit.fields.hltb.solo')}
              value={form.hltbSolo}
              onChange={set('hltbSolo')}
              placeholder="—"
            />
          </div>
        </div>
        <div className="gedit__field">
          {head(
            'reviewScore',
            t('gameDetail.edit.fields.rating.label'),
            t('gameDetail.edit.fields.rating.reset')
          )}
          <TextField
            focusKey={fk('score')}
            aria-label={t('gameDetail.edit.fields.rating.aria')}
            value={form.score}
            onChange={set('score')}
            placeholder="0-100"
            clearable
          />
          <SelectField
            focusKey={fk('scoreSource')}
            label={t('gameDetail.edit.fields.rating.shownAs')}
            value={form.scoreSource}
            options={scoreSourceOptions(t)}
            onChange={set('scoreSource')}
          />
        </div>
        <div className="gedit__field">
          {head(
            'difficulty',
            t('gameDetail.edit.fields.difficulty.label'),
            t('gameDetail.edit.fields.difficulty.reset')
          )}
          <SelectField
            focusKey={fk('difficulty')}
            label={t('gameDetail.edit.fields.difficulty.select')}
            value={form.difficulty}
            options={difficultyOptions}
            onChange={set('difficulty')}
          />
        </div>
        {remote ? (
          <p className="gsheet__note">
            {t('gameDetail.edit.notes.remote', {
              host: game.remote?.hostName ?? t('gameDetail.edit.notes.remoteHost')
            })}
          </p>
        ) : (
          <p className="gsheet__note">{t('gameDetail.edit.notes.local')}</p>
        )}
      </div>

      {remote ? null : (
        <>
          <div className="gsheet__section">
            <div className="gsheet__title">{t('gameDetail.edit.sections.settings')}</div>
            {system ? (
              <SelectField
                focusKey={fk('emulator')}
                label={t('gameDetail.edit.settings.emulator')}
                description={system.name}
                value={
                  (findEmulatorCommand(system, emulatorId || undefined)?.id ?? emulatorId) || ''
                }
                options={emulatorOptions}
                onChange={setEmulatorId}
              />
            ) : null}
            {showArgs ? (
              <TextField
                focusKey={fk('args')}
                label={t('gameDetail.edit.settings.args')}
                value={args}
                onChange={setArgs}
                placeholder={t('gameDetail.edit.settings.argsPlaceholder')}
                clearable
                className="gsheet__field"
              />
            ) : null}
            <TextField
              focusKey={fk('size')}
              label={t('gameDetail.edit.settings.size')}
              value={size}
              onChange={setSize}
              placeholder={
                installSizeText({
                  ...game,
                  user: { ...game.user, installSize: undefined }
                })?.value.replace(/^—$/, '') || t('gameDetail.edit.settings.sizePlaceholder')
              }
              clearable
              className="gsheet__field"
            />
            <Toggle
              focusKey={fk('hidden')}
              label={t('gameDetail.edit.settings.hide')}
              description={t('gameDetail.edit.settings.hideDescription')}
              checked={hidden}
              onChange={setHidden}
            />
          </div>

          <div className="gsheet__section">
            <div className="gsheet__title">{t('gameDetail.edit.sections.artwork')}</div>
            {mediaRows(t).map((row) => {
              const { kind, label, hint } = row
              const custom = !!game.user.customMedia?.[kind]
              const url = game.media[kind]
              return (
                <div key={kind} className={cx('gsheet__media', `gsheet__media--${kind}`)}>
                  <span className="gsheet__media-thumb" aria-hidden="true">
                    {url ? <img src={url} alt="" draggable={false} /> : <ImageIcon />}
                  </span>
                  <div className="gsheet__media-text">
                    <span className="gsheet__media-label">{label}</span>
                    <span className="gsheet__media-desc">
                      {custom
                        ? t('gameDetail.edit.artwork.custom')
                        : url
                          ? t('gameDetail.edit.artwork.fromScrapers')
                          : t('gameDetail.edit.artwork.none')}{' '}
                      · {hint}
                    </span>
                  </div>
                  <div className="gsheet__media-actions">
                    <Button
                      focusKey={fk(`${kind}:choose`)}
                      icon={busyMedia === kind ? <Spinner size="sm" /> : <ImagePlus />}
                      disabled={busyMedia !== null}
                      onPress={() => chooseMedia(row)}
                      aria-label={row.chooseAria}
                    >
                      {t('gameDetail.edit.artwork.choose')}
                    </Button>
                    <Button
                      focusKey={fk(`${kind}:reset`)}
                      variant="ghost"
                      icon={<RotateCcw />}
                      disabled={!custom || busyMedia !== null}
                      onPress={() => resetMedia(row)}
                      aria-label={row.resetAria}
                    >
                      {t('gameDetail.edit.reset')}
                    </Button>
                  </div>
                </div>
              )
            })}
            <p className="gsheet__note">
              {t('gameDetail.edit.artwork.note')}{' '}
              {sources.length > 0
                ? t('gameDetail.edit.artwork.sources', { sources: sources.join(', ') })
                : t('gameDetail.edit.artwork.noSources')}
            </p>
          </div>
        </>
      )}
    </Modal>,
    document.body
  )
}
