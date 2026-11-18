/**
 * An identifier and title index over the open libraries, so a reference list
 * can say which of the cited works the user already has.
 *
 * Zotero has no such index of its own -- `Zotero.Items.getAll` and a map is
 * the available route -- so the result is memoised per library and dropped
 * when items change. A few hundred items cost a few milliseconds; the
 * alternative, one search per reference, costs a query per row on every
 * repaint. Which identifiers count, where they are read from, and when a
 * title is enough, is decided in libraryMatch.core.
 */

import { debugLog } from '../utils/log'

import { creatorAuthor, itemKeys, titleKey } from './libraryMatch.core'

import type { LibraryMatcher, MatchAuthor, TitleCandidate } from './libraryMatch.core'

export { findInLibrary, matchInLibrary, normalizeDoi } from './libraryMatch.core'
export type { LibraryMatcher, TitleCandidate } from './libraryMatch.core'

/** One scan's worth: both maps, so the graph and the pane share a scan. */
interface LibraryScan {
  /** Namespaced identifier (`doi:`, `arxiv:`, `pmid:`) -> item id. */
  ids: Map<string, number>
  /** Normalized title -> the items carrying it. */
  titles: Map<string, TitleCandidate[]>
}

const byLibrary = new Map<number, LibraryScan>()
let notifierID: string | false = false
/** Bumped on every clear, so a scan can tell it was overtaken by an edit. */
let generation = 0

/** A field's value, or empty when the item's type does not have that field. */
function field(item: Zotero.Item, name: string): string {
  try {
    return item.getField(name) || ''
  } catch {
    // Item types without the field throw rather than returning empty. Read
    // each field on its own, so a type without a DOI field still has its
    // arXiv id and PMID indexed.
    return ''
  }
}

/** The year of Zotero's free-text date, or `null` when it has none. */
function yearOf(date: string): number | null {
  if (date === '') return null
  // Typed as a string, and not always one; parse it either way.
  const year = Number(Zotero.Date.strToDate(date).year)
  return Number.isInteger(year) && year > 0 ? year : null
}

function authorsOf(item: Zotero.Item): MatchAuthor[] {
  const authors: MatchAuthor[] = []
  for (const creator of item.getCreators()) {
    // A review carries the reviewed book's author, and is often titled after
    // the book: counting that author would mark the review as the book.
    if (Zotero.CreatorTypes.getName(creator.creatorTypeID) === 'reviewedAuthor') continue
    // fieldMode 1 is a single-field name, an institution most often: no initial.
    const author = creatorAuthor(creator.lastName ?? '', creator.fieldMode === 1 ? '' : (creator.firstName ?? ''))
    if (author) authors.push(author)
  }
  return authors
}

async function build(libraryID: number): Promise<LibraryScan> {
  const ids = new Map<string, number>()
  const titles = new Map<string, TitleCandidate[]>()
  const items = await Zotero.Items.getAll(libraryID, true)
  for (const item of items) {
    if (!item.isRegularItem()) continue
    const keys = itemKeys({
      doi: field(item, 'DOI'),
      extra: field(item, 'extra'),
      archiveID: field(item, 'archiveID'),
      url: field(item, 'url'),
    })
    for (const key of keys) {
      // First writer wins: with duplicates, the earlier item is as good a
      // target as any, and overwriting would make the result depend on
      // iteration order.
      if (!ids.has(key)) ids.set(key, item.id)
    }

    // Every item under its title, duplicates included: the title route
    // refuses to choose between two, so it has to see both.
    const title = titleKey(field(item, 'title'))
    if (title === null) continue
    const candidate: TitleCandidate = {
      itemID: item.id,
      year: yearOf(field(item, 'date')),
      authors: authorsOf(item),
      keys,
    }
    const same = titles.get(title)
    if (same) same.push(candidate)
    else titles.set(title, [candidate])
  }
  debugLog(`Citation debug - Library index for library ${libraryID}: ${ids.size} keys, ${titles.size} titles`)
  return { ids, titles }
}

async function getScan(libraryID: number): Promise<LibraryScan> {
  const cached = byLibrary.get(libraryID)
  if (cached) return cached
  const startedAt = generation
  const scan = await build(libraryID)
  // An item changed while the scan ran, so the scan may predate it. Hand the
  // result to this caller, which asked before the change, but do not keep it:
  // the next call scans again. Rescanning here instead would loop for as long
  // as an import keeps adding items.
  if (generation === startedAt) byLibrary.set(libraryID, scan)
  return scan
}

/** The identifier map alone, for `findInLibrary`. */
export async function getLibraryIndex(libraryID: number): Promise<Map<string, number>> {
  return (await getScan(libraryID)).ids
}

/** Identifiers and titles, for `matchInLibrary`. The same scan and cache as `getLibraryIndex`. */
export async function getLibraryMatcher(libraryID: number): Promise<LibraryMatcher> {
  return getScan(libraryID)
}

/** Invalidate everything. Cheaper than working out which library changed. */
export function clearLibraryIndex(): void {
  generation++
  byLibrary.clear()
}

export function registerLibraryIndexNotifier(): void {
  if (notifierID !== false) return
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string) => {
        // Any add, remove or edit can change which identifiers and titles exist.
        if (event === 'add' || event === 'delete' || event === 'trash' || event === 'modify') clearLibraryIndex()
      },
    },
    ['item'],
  )
}

export function unregisterLibraryIndexNotifier(): void {
  if (notifierID === false) return
  Zotero.Notifier.unregisterObserver(notifierID)
  notifierID = false
  clearLibraryIndex()
}
