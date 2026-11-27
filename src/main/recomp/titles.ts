// Game-name normalization shared by the recompilation catalog (grouping several recompilations of one game) and
// the library matcher (a ROM / store game to its recompilations). Deliberately strict: only spelling noise is
// removed (case, punctuation, accents, ™®©, "&", a leading or trailing "The", No-Intro / Redump tags in brackets),
// never words, so two different games never collapse into one. A bracketed year or demo note is part of the name:
// "Prey (2006)" is not Prey (2017), "Sonic the Hedgehog (2013)" not the Genesis game, an E3 demo not the retail game.

/** Bracketed parts: "(USA)", "(Rev 1)", "[!]", "(Disc 1)", "(2006)". */
const BRACKETS = /\s*[([{][^)\]}]*[)\]}]/g

/** Bracketed text that tells one game from another and is kept: a release year, a demo. */
const KEPT_BRACKET = /^(?:19|20)\d\d$|\bdemo\b/i

function bracketText(part: string): string {
  const inner = part.trim().slice(1, -1).trim()
  return KEPT_BRACKET.test(inner) ? ` ${inner} ` : ' '
}

/**
 * The comparable form of a game name: lowercase ASCII letters and digits only. "Legend of Zelda, The - Majora's
 * Mask (USA)" and "The Legend of Zelda: Majora's Mask" both give "legendofzeldamajorasmask"; "Prey (2006)" gives
 * "prey2006".
 */
export function normalizeGameTitle(title: string): string {
  let t = title
    // Before NFKD, which would spell "™" out as "TM".
    .replace(/[™®©]/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(BRACKETS, bracketText)
    .replace(/&/g, ' and ')
    .toLowerCase()
    .trim()
  // "Legend of Zelda, The - Majora's Mask" / "Legend of Zelda, The": the article moved to the end of the first part.
  t = t.replace(/,\s*the(?=\s*(?:[-:–—]|$))/, '')
  t = t.replace(/^the\s+/, '')
  return t.replace(/[^a-z0-9]+/g, '')
}

/** The name without any bracketed part (TOSEC's "Doom (1993)(id Software)" -> "Doom"), or null when it has none. */
export function withoutBrackets(title: string): string | null {
  const t = title.replace(BRACKETS, ' ').replace(/\s+/g, ' ').trim()
  return t && t !== title.trim() ? t : null
}

/**
 * The name without a trailing "Version" (No-Intro's "Pokemon - Emerald Version (USA, Europe)" -> "Pokemon - Emerald",
 * the catalogs' "Pokémon Platinum Version" -> "Pokémon Platinum"), or null when it has none. Bracketed tags after it
 * go too.
 */
export function withoutVersionWord(title: string): string | null {
  const base = title.replace(/(?:\s*[([{][^)\]}]*[)\]}])+\s*$/, '')
  const m = /^(.*\S)\s+version$/i.exec(base.trim())
  return m && normalizeGameTitle(m[1]!) ? m[1]! : null
}

/** The key one game's recompilations are grouped under: "<systemId>:<normalized name>". */
export function titleKeyOf(systemId: string, game: string): string {
  return `${systemId}:${normalizeGameTitle(game)}`
}
