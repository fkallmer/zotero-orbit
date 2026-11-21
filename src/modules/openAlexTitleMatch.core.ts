/**
 * Finding an item's OpenAlex work by title, for items with no identifier.
 *
 * Books, reports and older papers often reach Zotero without a DOI, and then
 * every identifier-based source walks past them. OpenAlex can still hold the
 * work; this finds it by title and keeps the find guarded:
 *
 * - the work is the work, not a review or erratum of it (`canBeTheWork`);
 * - the normalized titles are exactly equal, and long enough to mean
 *   something (`titleKey`: three words, twenty characters);
 * - at least one author agrees on surname and first initial;
 * - for books and book chapters, no year rule. OpenAlex often holds only
 *   another edition of a textbook (the 14th edition on the shelf, the 1st in
 *   OpenAlex). Such a match is taken, and flagged as another edition, so the
 *   caller can say so.
 * - for everything else, the years agree within one when both are known. A
 *   paper has no editions; a same-titled work by the same author in another
 *   year is a reprint or a summary with its own count. Measured on a library,
 *   that was the one wrong pick in 55, and this rule removes it.
 *
 * When several works pass, they are taken to be editions of one book, and the
 * one closest in year wins, then the most cited.
 *
 * Pure: no Zotero, no network, so `node --test` covers it.
 */

import { creatorAuthor, parseAuthor, shareAuthor, titleKey } from './libraryMatch.core.ts'

import type { MatchAuthor } from './libraryMatch.core.ts'

const API_ROOT = 'https://api.openalex.org'

/** Enough candidates to reach past same-titled works by other authors. */
export const TITLE_SEARCH_PER_PAGE = 25

/** What a candidate needs for matching, and to be a count and a graph node. */
export const TITLE_SEARCH_SELECT = 'id,doi,display_name,publication_year,cited_by_count,authorships,type'

/**
 * OpenAlex work types that are about a work rather than the work itself.
 *
 * A review of a book carries the book's title and lists its authors, and
 * OpenAlex may credit it with the book's citations: "Principles of Corporate
 * Finance" matched a one-page 1981 review in the Journal of Finance with 3794
 * citations. None of these may stand in for an item.
 */
const NOT_THE_WORK = new Set([
  'book-review',
  'editorial',
  'erratum',
  'letter',
  'paratext',
  'peer-review',
  'reference-entry',
  'retraction',
  'supplementary-materials',
])

/** Whether a work of this OpenAlex type can be the item itself. */
export function canBeTheWork(type: string | null | undefined): boolean {
  return !NOT_THE_WORK.has((type ?? '').toLowerCase())
}

/**
 * The search request. Punctuation goes, since OpenAlex reads `,` and `|` in a
 * filter value as syntax. Returns null for a title too short or generic to
 * search for safely.
 */
export function buildTitleSearchUrl(title: string, mailto = ''): string | null {
  if (titleKey(title) === null) return null
  // Accents stay: OpenAlex matches "für" but not "fur".
  const words = title
    .replace(/<[^>]*>/g, ' ')
    .replace(/[,|:;!?()[\]{}"'\u201c\u201d\u201e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const contact = mailto.trim() === '' ? '' : `&mailto=${encodeURIComponent(mailto.trim())}`
  return (
    `${API_ROOT}/works?filter=${encodeURIComponent(`title.search:${words}`)}` +
    `&select=${encodeURIComponent(TITLE_SEARCH_SELECT)}&per-page=${TITLE_SEARCH_PER_PAGE}${contact}`
  )
}

/** An item as the title search sees it. */
export interface TitleQuery {
  title: string
  year: number | null
  /** Zotero creators as last name and first name. */
  creators: readonly { lastName: string; firstName: string }[]
  /** Whether another edition may stand in: true for books and book chapters. */
  allowOtherEditions: boolean
}

/** Zotero item types whose works come in editions. */
export function itemTypeHasEditions(itemType: string): boolean {
  return itemType === 'book' || itemType === 'bookSection'
}

/** One OpenAlex search result, reduced to what matching and the caller need. */
export interface TitleCandidateWork {
  /** Bare OpenAlex id, e.g. `W1565680857`. */
  id: string
  doi: string | null
  title: string
  year: number | null
  citedByCount: number | null
  authors: string[]
  /** OpenAlex work type (`book`, `article`, `book-review`, …), if given. */
  type: string | null
}

export interface TitleMatch {
  work: TitleCandidateWork
  /** False when the years are more than one apart: another edition, probably. */
  sameEdition: boolean
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function asYear(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/** Read the search response. Malformed entries are skipped, not fatal. */
export function normalizeTitleSearch(json: unknown): TitleCandidateWork[] {
  const results = (json as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return []
  const works: TitleCandidateWork[] = []
  for (const raw of results) {
    const entry = raw as Record<string, unknown> | null
    const id = asString(entry?.id)?.replace(/^https?:\/\/openalex\.org\//i, '')
    const title = asString(entry?.display_name)
    if (!id || !/^W\d+$/.test(id) || !title) continue
    const authorships = Array.isArray(entry?.authorships) ? entry.authorships : []
    const authors = authorships
      .map((a) => asString((a as { author?: { display_name?: unknown } } | null)?.author?.display_name))
      .filter((name): name is string => name !== null)
    const count = entry?.cited_by_count
    works.push({
      id,
      doi: asString(entry?.doi)?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') ?? null,
      title,
      year: asYear(entry?.publication_year),
      citedByCount: typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null,
      authors,
      type: asString(entry?.type),
    })
  }
  return works
}

/**
 * The work this item is, or null.
 *
 * Null whenever the rules above leave nothing: no usable title, no author with
 * an initial on the item's side, or no candidate with the same title and a
 * shared author.
 */
export function pickTitleMatch(query: TitleQuery, candidates: readonly TitleCandidateWork[]): TitleMatch | null {
  const key = titleKey(query.title)
  if (key === null) return null
  const ours = query.creators
    .map((creator) => creatorAuthor(creator.lastName, creator.firstName))
    .filter((author): author is MatchAuthor => author !== null && author.initial !== null)
  if (ours.length === 0) return null

  const survivors = candidates.filter((work) => {
    if (!canBeTheWork(work.type)) return false
    if (titleKey(work.title) !== key) return false
    const theirs = work.authors.map(parseAuthor).filter((author): author is MatchAuthor => author !== null)
    if (!shareAuthor(ours, theirs)) return false
    if (query.allowOtherEditions || query.year === null || work.year === null) return true
    return Math.abs(work.year - query.year) <= 1
  })
  if (survivors.length === 0) return null

  const distance = (work: TitleCandidateWork): number =>
    query.year === null || work.year === null ? Number.POSITIVE_INFINITY : Math.abs(work.year - query.year)
  const best = [...survivors].sort(
    (a, b) => distance(a) - distance(b) || (b.citedByCount ?? -1) - (a.citedByCount ?? -1) || a.id.localeCompare(b.id),
  )[0]
  return { work: best, sameEdition: distance(best) <= 1 }
}
