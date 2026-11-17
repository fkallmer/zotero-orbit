/**
 * An identifier index over the open libraries, so a reference list can say
 * which of the cited works the user already has.
 *
 * Zotero has no such index of its own -- `Zotero.Items.getAll` and a map is
 * the available route -- so the result is memoised per library and dropped
 * when items change. A few hundred items cost a few milliseconds; the
 * alternative, one search per reference, costs a query per row on every
 * repaint. Which identifiers count, and where they are read from, is decided
 * in libraryMatch.core.
 */

import { debugLog } from '../utils/log'

import { itemKeys } from './libraryMatch.core'

export { findInLibrary, normalizeDoi } from './libraryMatch.core'

/** libraryID -> namespaced identifier (`doi:`, `arxiv:`, `pmid:`) -> item id */
const byLibrary = new Map<number, Map<string, number>>()
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

async function build(libraryID: number): Promise<Map<string, number>> {
  const index = new Map<string, number>()
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
      if (!index.has(key)) index.set(key, item.id)
    }
  }
  debugLog(`Citation debug - Library index for library ${libraryID}: ${index.size} keys`)
  return index
}

export async function getLibraryIndex(libraryID: number): Promise<Map<string, number>> {
  const cached = byLibrary.get(libraryID)
  if (cached) return cached
  const startedAt = generation
  const index = await build(libraryID)
  // An item changed while the scan ran, so the scan may predate it. Hand the
  // result to this caller, which asked before the change, but do not keep it:
  // the next call scans again. Rescanning here instead would loop for as long
  // as an import keeps adding items.
  if (generation === startedAt) byLibrary.set(libraryID, index)
  return index
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
        // Any add, remove or edit can change which DOIs exist.
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
