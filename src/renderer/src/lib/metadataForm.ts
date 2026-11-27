import { isDifficultyId } from '@shared/difficulty'
import {
  METADATA_EDIT_FIELDS,
  type ControllerSupport,
  type MetadataEdit,
  type MetadataEditField,
  type MetadataLayers,
  type MetadataOrigin,
  type ReviewSource,
  type VrSupport
} from '@shared/metadata-edit'
import { t } from '../i18n'

/**
 * The Edit sheet's form (screens/GameDetail/GameEditSheet.tsx): every editable metadata field as the text its
 * controls hold, and the edit a Save sends. Pure, so the round trip is tested without the UI.
 */
export interface MetadataForm {
  title: string
  description: string
  shortDescription: string
  releaseDate: string
  /** Comma-separated. */
  developers: string
  publishers: string
  genres: string
  tags: string
  /** '' = not known, '0' = none, '1'..: the count. */
  localPlayers: string
  controller: ControllerSupport
  vr: VrSupport
  hltbMain: string
  hltbExtra: string
  hltbCompletionist: string
  hltbSolo: string
  /** '' = no score. */
  score: string
  scoreSource: ReviewSource
  /** '' = Default (no pick: Medium), else a DIFFICULTY_IDS id. */
  difficulty: NonNullable<MetadataEdit['difficulty']>
}

/** The form keys each field is made of. */
export const FIELD_FORM_KEYS: Record<MetadataEditField, readonly (keyof MetadataForm)[]> = {
  title: ['title'],
  description: ['description'],
  shortDescription: ['shortDescription'],
  releaseDate: ['releaseDate'],
  developers: ['developers'],
  publishers: ['publishers'],
  genres: ['genres'],
  tags: ['tags'],
  localPlayers: ['localPlayers'],
  controls: ['controller', 'vr'],
  hltb: ['hltbMain', 'hltbExtra', 'hltbCompletionist', 'hltbSolo'],
  reviewScore: ['score', 'scoreSource'],
  difficulty: ['difficulty']
}

export const EMPTY_FORM: MetadataForm = {
  title: '',
  description: '',
  shortDescription: '',
  releaseDate: '',
  developers: '',
  publishers: '',
  genres: '',
  tags: '',
  localPlayers: '',
  controller: 'none',
  vr: 'none',
  hltbMain: '',
  hltbExtra: '',
  hltbCompletionist: '',
  hltbSolo: '',
  score: '',
  scoreSource: 'steam',
  difficulty: ''
}

/** A list as a list field's text ("Action, RPG"). */
export const joinList = (list: readonly string[] | undefined): string => (list ?? []).join(', ')
const num = (n: number | undefined): string =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? String(Math.round(n * 10) / 10) : ''

/** The form values of one field from an edit (fields the edit lacks keep `base`'s values). */
export function formFromEdit(edit: MetadataEdit, base: MetadataForm = EMPTY_FORM): MetadataForm {
  const f: MetadataForm = { ...base }
  if (edit.title !== undefined) f.title = edit.title
  if (edit.description !== undefined) f.description = edit.description
  if (edit.shortDescription !== undefined) f.shortDescription = edit.shortDescription
  if (edit.releaseDate !== undefined) f.releaseDate = edit.releaseDate
  if (edit.developers !== undefined) f.developers = joinList(edit.developers)
  if (edit.publishers !== undefined) f.publishers = joinList(edit.publishers)
  if (edit.genres !== undefined) f.genres = joinList(edit.genres)
  if (edit.tags !== undefined) f.tags = joinList(edit.tags)
  if (edit.localPlayers !== undefined) f.localPlayers = String(edit.localPlayers)
  if (edit.controls !== undefined) {
    f.controller = edit.controls.controller
    f.vr = edit.controls.vr
  }
  if (edit.hltb !== undefined) {
    f.hltbMain = num(edit.hltb.main)
    f.hltbExtra = num(edit.hltb.extra)
    f.hltbCompletionist = num(edit.hltb.completionist)
    f.hltbSolo = num(edit.hltb.solo)
  }
  if (edit.reviewScore !== undefined) {
    f.score = typeof edit.reviewScore.score === 'number' ? String(edit.reviewScore.score) : ''
    if (edit.reviewScore.source) f.scoreSource = edit.reviewScore.source
  }
  if (edit.difficulty !== undefined) f.difficulty = edit.difficulty
  return f
}

/** Layer by layer: what the game shows now (scraped, then the cloud's, then the user's own edit). */
export function shownForm(layers: MetadataLayers): MetadataForm {
  return formFromEdit(layers.local, fallbackForm(layers))
}

/** What a field falls back to without the user's own edit: the cloud's value, else the scraped one. */
export function fallbackForm(layers: MetadataLayers): MetadataForm {
  return formFromEdit(layers.cloud ?? {}, formFromEdit(layers.scraped))
}

/** Where each field's shown value comes from. */
export function fieldOrigin(layers: MetadataLayers, field: MetadataEditField): MetadataOrigin {
  if (layers.local[field] !== undefined) return 'local'
  if (layers.cloud?.[field] !== undefined) return 'cloud'
  return 'scraped'
}

/** A list field's text as its items: trimmed, empty ones and repeats (any case) left out. */
export const splitList = (text: string): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[,;\n]/)) {
    const item = part.trim()
    if (!item || seen.has(item.toLowerCase())) continue
    seen.add(item.toLowerCase())
    out.push(item)
  }
  return out
}

/** A number typed in a field: undefined when empty, NaN when it is not a number. */
export function parseNumber(text: string): number | undefined {
  const t = text.trim().replace(',', '.')
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN
}

/** One field's value as an edit; throws an Error with a message for the user when it is not valid. */
export function fieldEdit(form: MetadataForm, field: MetadataEditField): MetadataEdit {
  switch (field) {
    case 'title': {
      // An empty title is never an edit: formSave turns it into "remove my title edit".
      const title = form.title.trim()
      if (!title) throw new Error(t('lib.metadataForm.enterTitle'))
      return { title }
    }
    case 'description':
      return { description: form.description.trim() }
    case 'shortDescription':
      return { shortDescription: form.shortDescription.trim() }
    case 'releaseDate': {
      const date = form.releaseDate.trim()
      // Same rule as RELEASE_DATE_RE in src/main/metadata-edits/schema.ts (month 01-12, day 01-31).
      if (date && !/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(date))
        throw new Error(t('lib.metadataForm.releaseDate'))
      return { releaseDate: date }
    }
    case 'developers':
    case 'publishers':
    case 'genres':
    case 'tags':
      return { [field]: splitList(form[field]) }
    case 'localPlayers': {
      const n = parseNumber(form.localPlayers)
      return { localPlayers: n === undefined || Number.isNaN(n) ? 0 : Math.round(n) }
    }
    case 'controls':
      return { controls: { controller: form.controller, vr: form.vr } }
    case 'hltb': {
      const hltb: NonNullable<MetadataEdit['hltb']> = {}
      const pairs = [
        ['main', form.hltbMain],
        ['extra', form.hltbExtra],
        ['completionist', form.hltbCompletionist],
        ['solo', form.hltbSolo]
      ] as const
      for (const [key, text] of pairs) {
        const n = parseNumber(text)
        if (Number.isNaN(n))
          throw new Error('Enter How Long to Beat times in hours, like 12 or 7.5')
        if (n !== undefined && n > 0) hltb[key] = n
      }
      return { hltb }
    }
    case 'reviewScore': {
      const n = parseNumber(form.score)
      if (Number.isNaN(n) || (n !== undefined && n > 100))
        throw new Error('Enter the rating as a number from 0 to 100')
      return {
        reviewScore: {
          ...(n !== undefined ? { score: Math.round(n) } : {}),
          source: form.scoreSource
        }
      }
    }
    case 'difficulty': {
      // Same choices as the `difficulty` enum in src/main/metadata-edits/schema.ts.
      const level = form.difficulty
      if (level !== '' && !isDifficultyId(level)) throw new Error('Pick a difficulty')
      return { difficulty: level }
    }
  }
}

/** Whether two forms hold the same value for a field. */
export function fieldMatches(a: MetadataForm, b: MetadataForm, field: MetadataEditField): boolean {
  const norm = (k: keyof MetadataForm, v: unknown): string =>
    LIST_KEYS.has(k) ? splitList(String(v)).join('\n') : String(v).trim()
  return FIELD_FORM_KEYS[field].every((k) => norm(k, a[k]) === norm(k, b[k]))
}
const LIST_KEYS = new Set<keyof MetadataForm>(['developers', 'publishers', 'genres', 'tags'])
const sameField = fieldMatches

/** Whether the field's form value differs from what the game shows. */
export function fieldChanged(
  form: MetadataForm,
  layers: MetadataLayers,
  field: MetadataEditField
): boolean {
  return !sameField(form, shownForm(layers), field)
}

/**
 * What a Save sends: `edit` = the fields changed from what the game shows; `clear` = the fields reset to their
 * fallback (the cloud's, else the scraped value), whose own edit goes. A reset field the user then changed again
 * is saved as an edit. Throws an Error for a field that is not valid.
 */
export function formSave(
  form: MetadataForm,
  layers: MetadataLayers,
  resets: ReadonlySet<MetadataEditField>
): { edit: MetadataEdit; clear: MetadataEditField[] } {
  const shown = shownForm(layers)
  const fallback = fallbackForm(layers)
  const edit: MetadataEdit = {}
  const clear: MetadataEditField[] = []
  for (const field of METADATA_EDIT_FIELDS) {
    // Emptying the title removes the user's own title (the cloud's / scraped one shows again); with no own title
    // there is nothing to remove, and an empty title is never saved or sent to the cloud.
    if (field === 'title' && !form.title.trim()) {
      if (layers.local.title !== undefined) clear.push('title')
      continue
    }
    if (
      resets.has(field) &&
      layers.local[field] !== undefined &&
      sameField(form, fallback, field)
    ) {
      clear.push(field)
      continue
    }
    if (sameField(form, shown, field)) continue
    Object.assign(edit, fieldEdit(form, field))
  }
  return { edit, clear }
}

/**
 * The layers after a Save of `plan` went through (the local edit without the cleared fields, with the edited ones), so
 * a later Save of the same form (a retry after a later step failed) sends nothing again.
 */
export function layersAfterSave(
  layers: MetadataLayers,
  plan: { edit: MetadataEdit; clear: readonly MetadataEditField[] }
): MetadataLayers {
  const local: MetadataEdit = { ...layers.local }
  for (const field of plan.clear) delete local[field]
  Object.assign(local, plan.edit)
  return { ...layers, local }
}
