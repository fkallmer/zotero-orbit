/**
 * Which identifiers make a library item and a cited work the same paper.
 *
 * Pure: the item side takes field strings, not a Zotero item, so `node --test`
 * covers every rule here without a stub.
 *
 * Matching used to be by DOI alone. A reference Semantic Scholar returns
 * without one was never recognised, even with the paper on the shelf, and
 * preprints are where that happens most. arXiv ids and PubMed ids close most
 * of that gap without the false positives a title match would bring, so long
 * as each is read only where it is unambiguous:
 *
 * - **DOI** from the DOI field, or from a `DOI:` line in Extra, which is where
 *   Zotero puts it for item types that have no DOI field.
 * - **arXiv** from `archiveID` (Zotero writes `arXiv:2101.00001` there), from
 *   an arxiv.org URL, from an `arXiv:` line in Extra (with or without the
 *   category the arXiv translator appends), and from the DOI arXiv
 *   mints itself, `10.48550/arXiv.<id>`. Never from a bare number found
 *   somewhere in a text field: a call number or Orbit's own `Citations:` line
 *   would then become an identifier.
 * - **PubMed** from a `PMID:` line in Extra, digits only.
 *
 * Keys are namespaced (`doi:`, `arxiv:`, `pmid:`) so the three share one map
 * and cannot collide.
 *
 * Where no identifier is shared, `matchInLibrary` falls back to a title match
 * guarded against exactly those false positives, and says it is only probable.
 * See "The title route" below.
 */

import { asArxivId, extractArxivIdFromUrl, stripArxivVersion } from '../utils/identifiers.ts'

import type { MatchableWork, MatchResult } from './collectionTypes.ts'

/** The identifiers a cited work may arrive with. Any of them may be missing. */
export interface WorkIds {
  doi?: string | null
  arxiv?: string | null
  pmid?: string | null
}

/** The fields of a library item that can carry an identifier. */
export interface ItemFields {
  doi?: string
  extra?: string
  archiveID?: string
  url?: string
}

/**
 * DOIs are case-insensitive and travel with assorted prefixes. Both sides of
 * a comparison go through this, so `https://doi.org/10.1/X` and `10.1/x` meet.
 */
export function normalizeDoi(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()
}

/** The DOI arXiv registers for each of its papers carries the arXiv id. */
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i

function arxivKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const id = asArxivId(raw)
  // Versionless and lower-cased: a library holding v1 and a reference to v3
  // are the same paper, and old-style ids are case-insensitive.
  return id ? `arxiv:${stripArxivVersion(id).toLowerCase()}` : null
}

function doiKeys(raw: string | null | undefined): string[] {
  if (!raw) return []
  const doi = normalizeDoi(raw)
  if (doi === '') return []
  const keys = [`doi:${doi}`]
  const arxiv = arxivKey(ARXIV_DOI.exec(doi)?.[1])
  if (arxiv) keys.push(arxiv)
  return keys
}

function pmidKey(raw: string | null | undefined): string | null {
  const id = raw?.trim()
  return id && /^\d+$/.test(id) ? `pmid:${id}` : null
}

/**
 * The value of a `Label: value` line in Extra, one label per line.
 *
 * `suffix` is an optional tail allowed after the value and dropped: Zotero's
 * arXiv translator writes `arXiv:1810.04805 [cs.CL]`, the category in
 * brackets. Anything else after the value rejects the line.
 */
function extraLine(extra: string, label: string, suffix = ''): string | null {
  const tail = suffix ? `(?:[ \\t]+${suffix})?` : ''
  const match = new RegExp(`^${label}:[ \\t]*(\\S+)${tail}[ \\t]*$`, 'im').exec(extra)
  return match ? match[1] : null
}

/** The bracketed category list after an arXiv id: `[cs.CL]`, `[astro-ph.CO]`. */
const ARXIV_CATEGORY = String.raw`\[[^\]\n]*\]`

/** Every key under which this item should be found. */
export function itemKeys(fields: ItemFields): string[] {
  const keys = new Set<string>()
  const add = (key: string | null): void => {
    if (key) keys.add(key)
  }
  const extra = fields.extra ?? ''

  for (const key of doiKeys(fields.doi)) add(key)
  for (const key of doiKeys(extraLine(extra, 'DOI'))) add(key)

  const archive = /^arxiv:\s*(.+)$/i.exec(fields.archiveID?.trim() ?? '')
  add(arxivKey(archive?.[1]))
  add(arxivKey(fields.url ? extractArxivIdFromUrl(fields.url) : null))
  add(arxivKey(extraLine(extra, 'arXiv', ARXIV_CATEGORY)))

  add(pmidKey(extraLine(extra, 'PMID')))
  return [...keys]
}

/** The keys to look a cited work up under, most specific first. */
export function workKeys(ids: WorkIds): string[] {
  const keys = new Set<string>(doiKeys(ids.doi))
  const arxiv = arxivKey(ids.arxiv)
  if (arxiv) keys.add(arxiv)
  const pmid = pmidKey(ids.pmid)
  if (pmid) keys.add(pmid)
  return [...keys]
}

/**
 * The library item a cited work is, or `null`.
 *
 * DOI first, then arXiv, then PubMed. When two of a work's identifiers point
 * at different items -- a preprint and its published version, both on the
 * shelf -- the DOI wins, because it names the exact version that was cited.
 */
export function findInLibrary(index: ReadonlyMap<string, number>, ids: WorkIds): number | null {
  for (const key of workKeys(ids)) {
    const itemID = index.get(key)
    if (itemID !== undefined) return itemID
  }
  return null
}

// ---------------------------------------------------------------------------
// The title route
//
// A reference that arrives with no identifier the library shares -- an old
// paper, a book chapter, a work Semantic Scholar resolved without a DOI -- can
// still be on the shelf. Matching it by title alone would mark every
// "Introduction" and every reprint under a reused title, so the rule is
// guarded on all sides, after the one the Cita plugin uses:
//
// - the normalized titles are exactly equal, and long enough to mean
//   something (at least three words and twenty characters);
// - both years are known and differ by at most one (online-first versus
//   issue year);
// - at least one author agrees on surname *and* first initial, both sides
//   having an initial -- a surname alone is too common to count;
// - no identifier namespace present on both sides disagrees: two different
//   DOIs are two different works, however alike their titles;
// - exactly one library item survives. Two survivors are left unmarked rather
//   than guessed between.
//
// What comes out is `probable`, never `exact`: the pane draws it differently.
// ---------------------------------------------------------------------------

/** Inline markup Zotero and Semantic Scholar both leave in titles: `<i>E. coli</i>`. */
const INLINE_TAG = /<\/?(?:i|b|em|strong|sub|sup|sc|span)(?:\s[^>]*)?>/gi

/** Lower-case, unaccented, every run of anything but letters and digits a single space. */
function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * A title reduced to what two spellings of the same title share: no accents,
 * no case, no punctuation, no inline markup, single spaces.
 */
export function normalizeTitle(title: string): string {
  return foldText(title.replace(INLINE_TAG, ''))
}

const MIN_TITLE_WORDS = 3
const MIN_TITLE_LENGTH = 20

/**
 * The normalized title, or `null` when it is too short or generic to identify
 * a work on its own ("Introduction", "Editorial", "Book reviews").
 */
export function titleKey(title: string | null | undefined): string | null {
  if (!title) return null
  const key = normalizeTitle(title)
  if (key.length < MIN_TITLE_LENGTH || key.split(' ').length < MIN_TITLE_WORDS) return null
  return key
}

/** An author as the title route compares them: folded surname, first initial if known. */
export interface MatchAuthor {
  surname: string
  initial: string | null
}

/**
 * Words that belong to the surname when they precede it: "Jan van der Berg"
 * is filed under "van der Berg".
 */
const PARTICLES = new Set([
  'al',
  'bin',
  'da',
  'das',
  'de',
  'degli',
  'del',
  'della',
  'den',
  'der',
  'di',
  'do',
  'dos',
  'du',
  'el',
  'la',
  'le',
  'st',
  'ten',
  'ter',
  'van',
  'von',
  'zu',
])

/** Generational suffixes, which follow the surname and are not part of it. */
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv'])

function initialOf(given: string): string | null {
  const folded = foldText(given)
  return folded === '' ? null : [...folded][0]
}

/**
 * A creator as Zotero holds it: last name and first name in separate fields.
 * A single-field creator (an institution, or a name Zotero could not split)
 * has no first name, and so no initial.
 */
export function creatorAuthor(lastName: string, firstName: string): MatchAuthor | null {
  const surname = foldText(lastName)
  if (surname === '') return null
  return { surname, initial: initialOf(firstName) }
}

/**
 * A display name as a reference source delivers it.
 *
 * "Family, Given" splits at the comma. Otherwise the last word is the surname,
 * together with any particles before it ("Ludwig van Beethoven" -> "van
 * beethoven") and without a trailing "Jr."; what precedes is the given name,
 * whose first letter is the initial ("J. R. R. Tolkien" -> j). A single word
 * is a surname with no initial.
 */
export function parseAuthor(name: string): MatchAuthor | null {
  const comma = name.indexOf(',')
  if (comma >= 0) return creatorAuthor(name.slice(0, comma), name.slice(comma + 1))

  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => foldText(word) !== '')
  while (words.length > 1 && SUFFIXES.has(foldText(words[words.length - 1]))) words.pop()
  if (words.length === 0) return null

  let start = words.length - 1
  // The first word always stays the given name, so "De Silva" alone parses
  // as given name and surname rather than as a surname with no one behind it.
  while (start > 1 && PARTICLES.has(foldText(words[start - 1]))) start--
  return creatorAuthor(words.slice(start).join(' '), words.slice(0, start).join(' '))
}

/** A library item as the title route sees it. */
export interface TitleCandidate {
  itemID: number
  year: number | null
  authors: { surname: string; initial: string | null }[]
  /** The item's identifier keys, from `itemKeys`, to veto a match on conflict. */
  keys: string[]
}

/** Everything `matchInLibrary` needs about one library, built in one scan. */
export interface LibraryMatcher {
  /** Namespaced identifier key -> item id, as `findInLibrary` reads it. */
  ids: ReadonlyMap<string, number>
  /** `titleKey` -> every item carrying that title. */
  titles: ReadonlyMap<string, TitleCandidate[]>
}

function namespaceOf(key: string): string {
  return key.slice(0, key.indexOf(':'))
}

/** True when some namespace has keys on both sides and none of them agree. */
function idsConflict(ours: readonly string[], theirs: readonly string[]): boolean {
  const held = new Set(theirs)
  for (const space of new Set(ours.map(namespaceOf))) {
    if (!theirs.some((key) => namespaceOf(key) === space)) continue
    if (!ours.some((key) => namespaceOf(key) === space && held.has(key))) return true
  }
  return false
}

function shareAuthor(ours: readonly MatchAuthor[], theirs: readonly MatchAuthor[]): boolean {
  return ours.some((a) => a.initial !== null && theirs.some((b) => b.initial === a.initial && b.surname === a.surname))
}

/**
 * The library item a cited work is, and how sure that is, or `null`.
 *
 * Identifiers first, in `findInLibrary`'s order, as `exact`. Then the guarded
 * title rule described above, as `probable`.
 */
export function matchInLibrary(matcher: LibraryMatcher, work: MatchableWork): MatchResult | null {
  const keys = workKeys(work)
  for (const key of keys) {
    const itemID = matcher.ids.get(key)
    if (itemID !== undefined) {
      return { itemID, confidence: 'exact', via: namespaceOf(key) as 'doi' | 'arxiv' | 'pmid' }
    }
  }

  const title = titleKey(work.title)
  const year = work.year ?? null
  if (title === null || year === null) return null
  const candidates = matcher.titles.get(title)
  if (!candidates) return null
  const authors = (work.authors ?? []).map(parseAuthor).filter((author): author is MatchAuthor => author !== null)
  if (authors.length === 0) return null

  const survivors = new Set<number>()
  for (const candidate of candidates) {
    if (candidate.year === null || Math.abs(candidate.year - year) > 1) continue
    if (!shareAuthor(authors, candidate.authors)) continue
    if (idsConflict(keys, candidate.keys)) continue
    survivors.add(candidate.itemID)
  }
  if (survivors.size !== 1) return null
  return { itemID: [...survivors][0], confidence: 'probable', via: 'title' }
}
