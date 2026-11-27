import type {
  RecompDeleteChoice,
  RecompHeldImage,
  RecompImageOffer,
  RecompOriginalImage,
  RecompUnpackedFolder
} from '@shared/recomp'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { createLog } from '../lib/log'

const log = createLog('recomp-image')

/**
 * "Delete the original disc image?" (main/recomp/image-offer.ts): the questions main has waiting ('recomp:image-offers'
 * and getRecompImageOffers), asked one at a time by App (RecompImageDialog). A question closed with B / Escape ("Not
 * now") or answered is not asked again this session; an unanswered one comes back at PlayOut's next start.
 */
export const useRecompImageStore = create<{
  offers: RecompImageOffer[]
  /** Keys not to ask again this session (answered, or closed with Not now). */
  dismissed: string[]
  /** The Delete dropdown's choice to open a question with (the Recompilation page's own dropdown picked it). */
  choices: Record<string, RecompDeleteChoice>
  /**
   * The Recompilation page's choice for a recompilation's question while its ask is under way: main sends the question
   * (and App may open it) before the ask's reply names its key.
   */
  asking: Record<string, RecompDeleteChoice>
}>()(() => ({ offers: [], dismissed: [], choices: {}, asking: {} }))

api.on('recomp:image-offers', ({ offers }) => useRecompImageStore.setState({ offers }))

/** Read the waiting questions (PlayOut's start). */
export function loadRecompImageOffers(): Promise<void> {
  return api
    .getRecompImageOffers()
    .then((offers) => useRecompImageStore.setState({ offers }))
    .catch((err) => log.warn('getRecompImageOffers failed', err))
}

/** Do not ask `key` again this session. */
export function dismissRecompImageOffer(key: string): void {
  useRecompImageStore.setState((s) =>
    s.dismissed.includes(key) ? s : { dismissed: [...s.dismissed, key] }
  )
}

/**
 * Ask `key` again (the Recompilation page's "Delete…" brought it back), opening with `choice` picked in its Delete
 * dropdown when given.
 */
export function undismissRecompImageOffer(key: string, choice?: RecompDeleteChoice): void {
  useRecompImageStore.setState((s) => ({
    dismissed: s.dismissed.includes(key) ? s.dismissed.filter((k) => k !== key) : s.dismissed,
    choices: choice ? { ...s.choices, [key]: choice } : s.choices
  }))
}

/**
 * The Recompilation page asks about recompilation `recompId` with `choice` picked: set before the ask so a question
 * that opens before its reply opens with that choice; `null` clears it (the ask finished or failed).
 */
export function setRecompImageAsking(recompId: string, choice: RecompDeleteChoice | null): void {
  useRecompImageStore.setState((s) => {
    const asking = { ...s.asking }
    if (choice) asking[recompId] = choice
    else delete asking[recompId]
    return { asking }
  })
}

/** The choice question `offer` opens with when the Recompilation page picked one (the ask under way first). */
export function wantedDeleteChoice(
  s: { choices: Record<string, RecompDeleteChoice>; asking: Record<string, RecompDeleteChoice> },
  offer: Pick<RecompImageOffer, 'key' | 'recompId'>
): RecompDeleteChoice | undefined {
  return s.asking[offer.recompId] ?? s.choices[offer.key]
}

/**
 * What Delete sends: the choice the player sees when the question still offers it; null when it no longer does (the
 * question changed while open: nothing is sent and the choice starts over).
 */
export function deleteToSend(
  options: readonly RecompDeleteOption[],
  choice: RecompDeleteChoice
): RecompDeleteChoice | null {
  return options.some((o) => o.value === choice) ? choice : null
}

/** The question to ask next: the oldest one not dismissed this session. */
export function nextRecompImageOffer(
  offers: readonly RecompImageOffer[],
  dismissed: readonly string[]
): RecompImageOffer | null {
  return (
    [...offers]
      .filter((o) => !dismissed.includes(o.key))
      .sort((a, b) => a.at.localeCompare(b.at))[0] ?? null
  )
}

/** One entry of the Delete dropdown. */
export interface RecompDeleteOption {
  value: RecompDeleteChoice
  label: string
}

/**
 * The Delete dropdown's entries for what may go: the disc image (first: the default), the unpacked game folder, or
 * both. One entry when only one of them may go (no dropdown is shown then).
 */
export function recompDeleteOptions(what: {
  fileName: string | null
  folder?: RecompUnpackedFolder | null
}): RecompDeleteOption[] {
  const out: RecompDeleteOption[] = []
  if (what.fileName) out.push({ value: 'delete', label: t('state.recompImage.delete.image') })
  if (what.folder) out.push({ value: 'delete-folder', label: t('state.recompImage.delete.folder') })
  if (what.fileName && what.folder)
    out.push({ value: 'delete-both', label: t('state.recompImage.delete.both') })
  return out
}

/** The choice a question opens with: the one asked for when it is offered, else the first entry. */
export function initialDeleteChoice(
  options: readonly RecompDeleteOption[],
  wanted?: RecompDeleteChoice
): RecompDeleteChoice {
  return options.find((o) => o.value === wanted)?.value ?? options[0]?.value ?? 'delete'
}

/** The size in words, or nothing ("(7 GB)"). */
const sized = (size: string | null): string => (size ? ` (${size})` : '')

/**
 * The dialog's text: "<Recomp> is ready. Delete the original <file> (<size>)? …", and the unpacked game folder when
 * it is offered too (or alone). `size` / `folderSize`: the image's and the folder's sizes in words.
 */
export function recompImageMessage(
  offer: RecompImageOffer,
  size: string | null,
  folderSize: string | null = null
): string {
  const folder = offer.folder
  const recomp = offer.recompName
  const game = offer.gameTitle
  if (!offer.fileName)
    return t('state.recompImage.folderOnly', {
      recomp,
      game,
      folder: folder?.path ?? t('state.recompImage.unpackedFolder'),
      size: sized(folderSize)
    })
  const extra = offer.files.length - 1
  const what =
    extra > 0
      ? t('state.recompImage.fileAndMore', { file: offer.fileName, count: extra })
      : offer.fileName
  const image = t('state.recompImage.ready', { recomp, what, size: sized(size), game })
  return folder
    ? t('state.recompImage.readyWithFolder', {
        image,
        folder: folder.path,
        size: sized(folderSize)
      })
    : image
}

/**
 * The text beside "Delete…" (the Recompilation page's section and Settings › Recompilations' card): what `recompName`
 * no longer needs, the disc image and/or the unpacked game folder (`folderSize`: its size in words), and whether the
 * player chose to keep it before.
 */
export function originalImageLines(
  recompName: string,
  image: RecompOriginalImage,
  folderSize: string | null
): string[] {
  const lines: string[] = []
  // "You chose to keep it before." is a sentence of its own, added after the line's.
  const kept = (text: string, wasKept: boolean | undefined): string =>
    wasKept ? `${text} ${t('state.recompImage.keptBefore')}` : text
  if (image.fileName)
    lines.push(
      kept(
        t('state.recompImage.imageLine', { recomp: recompName, file: image.fileName }),
        image.kept
      )
    )
  const folder = image.folder
  if (folder)
    lines.push(
      kept(
        t('state.recompImage.folderLine', {
          recomp: recompName,
          folder: folder.path,
          size: sized(folderSize)
        }),
        folder.kept
      )
    )
  return lines
}

// --- The test run after Delete (main/recomp/service.ts, services/held-files.ts) -------------------------------------

/**
 * Disc images a Delete answer moved aside while the recompilation is started to check it runs without them
 * ('recomp:held-images' and getRecompHeldImages). The ones with a verdict are asked one at a time by App
 * (RecompHeldDialog), before any "Delete the original disc image?" question. Not now (B / Escape) skips a verdict for
 * this session; it is asked again at PlayOut's next start (main keeps the files aside until it is answered).
 */
export const useRecompHeldStore = create<{
  items: RecompHeldImage[]
  /** heldAskKey values not to ask again this session. */
  dismissed: string[]
}>()(() => ({ items: [], dismissed: [] }))

/** The test's outcome main sends with the list (a passed test), shown by App as a toast. */
type HeldNote = { ok: boolean; message: string }
const noteListeners = new Set<(note: HeldNote) => void>()

api.on('recomp:held-images', ({ items, note }) => {
  useRecompHeldStore.setState({ items })
  if (note) for (const fn of noteListeners) fn(note)
})

/** Show a test's outcome (App: a toast); returns the unsubscribe. */
export function onRecompHeldNote(fn: (note: HeldNote) => void): () => void {
  noteListeners.add(fn)
  return () => {
    noteListeners.delete(fn)
  }
}

/** Read the held images (PlayOut's start: a test PlayOut did not finish is asked about again). */
export function loadRecompHeldImages(): Promise<void> {
  return api
    .getRecompHeldImages()
    .then((items) => useRecompHeldStore.setState({ items }))
    .catch((err) => log.warn('getRecompHeldImages failed', err))
}

/** One verdict of one hold: a new verdict (after Test again) asks again even after Not now. */
export function heldAskKey(item: Pick<RecompHeldImage, 'holdId' | 'decidedAt'>): string {
  return `${item.holdId}@${item.decidedAt ?? ''}`
}

/** Do not ask this verdict again this session. */
export function dismissRecompHeld(item: Pick<RecompHeldImage, 'holdId' | 'decidedAt'>): void {
  const key = heldAskKey(item)
  useRecompHeldStore.setState((s) =>
    s.dismissed.includes(key) ? s : { dismissed: [...s.dismissed, key] }
  )
}

/** The held image to ask about next: the oldest with a verdict (not testing) not dismissed this session. */
export function nextRecompHeld(
  items: readonly RecompHeldImage[],
  dismissed: readonly string[]
): RecompHeldImage | null {
  return (
    [...items]
      .filter((i) => i.state !== 'testing' && !dismissed.includes(heldAskKey(i)))
      .sort((a, b) => a.at.localeCompare(b.at))[0] ?? null
  )
}

/** What was moved aside, in words ("Game.iso", "C:\…\game", or both). */
export function heldWhat(item: Pick<RecompHeldImage, 'fileName' | 'folder'>): string {
  const file = item.fileName || ''
  const folder = item.folder || ''
  if (file && folder) return t('state.recompHeld.both', { file, folder })
  return file || folder || t('state.recompHeld.files')
}

/** The held dialog's title and text, by verdict. */
export function recompHeldMessage(item: RecompHeldImage): { title: string; message: string } {
  const what = heldWhat(item)
  // A disc image puts its game card back when restored (`game`); a game folder alone does not.
  const image = !!item.fileName
  const recomp = item.recompName
  const game = item.gameTitle
  // The reason without its closing period (it is put in a sentence).
  const bare = (text: string): string => text.replace(/[.\s]+$/, '')
  // Main's reason comes first, as a sentence of its own.
  const reason = item.reason ? `${bare(item.reason)}. ` : ''
  switch (item.state) {
    case 'crashed':
      return {
        title: image
          ? t('state.recompHeld.crashed.titleImage')
          : t('state.recompHeld.crashed.titleFolder'),
        message:
          reason +
          (image
            ? t('state.recompHeld.crashed.messageImage', { recomp, what, game })
            : t('state.recompHeld.crashed.messageFolder', { recomp, what }))
      }
    case 'passed':
      return {
        title: t('state.recompHeld.passed.title'),
        message:
          reason +
          (image
            ? t('state.recompHeld.passed.messageImage', { what, game })
            : t('state.recompHeld.passed.messageFolder', { what }))
      }
    case 'interrupted':
      return {
        title: image
          ? t('state.recompHeld.interrupted.titleImage')
          : t('state.recompHeld.interrupted.titleFolder'),
        message: t('state.recompHeld.interrupted.message', {
          what,
          recomp,
          reason: bare(item.reason ?? t('state.recompHeld.interrupted.closed'))
        })
      }
    default:
      return {
        title: image
          ? t('state.recompHeld.notStarted.titleImage')
          : t('state.recompHeld.notStarted.titleFolder'),
        message: t('state.recompHeld.notStarted.message', {
          recomp,
          what,
          reason: bare(item.reason ?? t('state.recompHeld.notStarted.notStarted'))
        })
      }
  }
}
