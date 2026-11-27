import { z } from 'zod'
import { DIFFICULTY_IDS } from '../../shared/difficulty'
import {
  METADATA_EDIT_FIELDS,
  normalizeControls,
  type MetadataEdit
} from '../../shared/metadata-edit'
import { tMain } from '../i18n'

const list = z.array(z.string().trim().max(200)).max(50)
const hours = z.number().min(0).max(100000).optional()

/**
 * A release date: 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD' with a month 01-12 and a day 01-31, or '' (no date). The rule
 * is written three times, in code that cannot share it, and has to stay the same in all of them: here,
 * RELEASE_DATE_RE in metadata-relay/src/validate.ts (a date this accepted and the relay refused could never be
 * suggested) and the `releaseDate` pattern in metadata-repo/schema.json (the repository's own check).
 * metadata-cloud/repo-template.test.ts runs the three against the same dates.
 */
export const RELEASE_DATE_RE =
  /^(?:[0-9]{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12][0-9]|3[01]))?)?)?$/

/**
 * What the user reads when a date gets past the Edit sheet's own, looser check (renderer/src/lib/metadataForm.ts
 * only looks at the digits) and is refused here: the form's wording, plus what is wrong with a month 13.
 */
export const releaseDateMessage = (): string => tMain('mainApp.edits.releaseDate')

/**
 * A MetadataEdit (shared/metadata-edit.ts) as it may cross IPC or come from the cloud. Unknown keys are dropped.
 */
export const metadataEditSchema = z.object({
  title: z.string().trim().max(300).optional(),
  description: z.string().max(20000).optional(),
  shortDescription: z.string().max(2000).optional(),
  releaseDate: z.string().trim().regex(RELEASE_DATE_RE, releaseDateMessage()).optional(),
  developers: list.optional(),
  publishers: list.optional(),
  genres: list.optional(),
  tags: list.optional(),
  localPlayers: z.number().int().min(0).max(64).optional(),
  // Not strict, like the whole object: unknown keys are dropped, never refused. An older PlayOut (whose controls had
  // only controller and vr) reads a cloud entry with touch / keyboard / lightgun the same way, as controller and vr;
  // one without lightgun (0.9.97 and earlier) drops just that.
  controls: z
    .object({
      controller: z.enum(['full', 'partial', 'none']),
      vr: z.enum(['only', 'supported', 'none']),
      touch: z.boolean().optional(),
      keyboard: z.boolean().optional(),
      lightgun: z.boolean().optional()
    })
    .optional(),
  hltb: z.object({ main: hours, extra: hours, completionist: hours, solo: hours }).optional(),
  reviewScore: z
    .object({
      score: z.number().min(0).max(100).optional(),
      source: z.enum(['steam', 'igdb']).optional()
    })
    .optional(),
  // A level, or '' for Default (no pick: Medium).
  difficulty: z.enum(['', ...DIFFICULTY_IDS]).optional()
})

export const metadataEditFieldsSchema = z.array(z.enum(METADATA_EDIT_FIELDS)).max(50)

/** Drop the keys whose value is undefined (zod keeps them as `undefined` on optional fields). */
function compact(edit: MetadataEdit): MetadataEdit {
  const out: MetadataEdit = {}
  for (const field of METADATA_EDIT_FIELDS)
    if (edit[field] !== undefined) (out as Record<string, unknown>)[field] = edit[field]
  // touch / keyboard / lightgun only when true (a false one says the same as none).
  if (out.controls) out.controls = normalizeControls(out.controls)
  if (out.hltb) {
    const h = { ...out.hltb }
    for (const k of Object.keys(h) as (keyof typeof h)[]) if (h[k] === undefined) delete h[k]
    out.hltb = h
  }
  if (out.reviewScore) {
    const r = { ...out.reviewScore }
    if (r.score === undefined) delete r.score
    if (r.source === undefined) delete r.source
    out.reviewScore = r
  }
  return out
}

/**
 * Validate an edit (IPC); throws an Error on a bad one. Its message is shown to the user as it is (the Edit sheet's
 * save), so it is a sentence, not zod's JSON list of issues.
 */
export function parseMetadataEdit(raw: unknown): MetadataEdit {
  const parsed = metadataEditSchema.safeParse(raw)
  if (parsed.success) return compact(parsed.data as MetadataEdit)
  const issue = parsed.error.issues[0]
  const field = issue?.path.join('.') ?? ''
  if (field === 'releaseDate' && typeof (raw as { releaseDate?: unknown }).releaseDate === 'string')
    throw new Error(releaseDateMessage())
  throw new Error(
    field
      ? tMain('mainApp.edits.cannotSaveField', {
          field,
          why: issue?.message ?? tMain('mainApp.edits.notValid')
        })
      : tMain('mainApp.edits.cannotSave', {
          why: issue?.message ?? tMain('mainApp.edits.notValid')
        })
  )
}

/** Validate an edit from an untrusted file (the cloud's all.json): null for a bad one. */
export function safeParseMetadataEdit(raw: unknown): MetadataEdit | null {
  const parsed = metadataEditSchema.safeParse(raw)
  return parsed.success ? compact(parsed.data as MetadataEdit) : null
}
