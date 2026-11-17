/**
 * A DOI index over the open libraries, so a reference list can say which of
 * the cited works the user already has.
 *
 * Zotero has no DOI index of its own -- `Zotero.Items.getAll` and a map is the
 * available route -- so the result is memoised per library and dropped when
 * items change. A few hundred items cost a few milliseconds; the alternative,
 * one search per reference, costs a query per row on every repaint.
 */

import { debugLog } from '../utils/log'

/** libraryID -> normalized DOI -> item id */
const byLibrary = new Map<number, Map<string, number>>()
let notifierID: string | false = false
/** Bumped on every clear, so a scan can tell it was overtaken by an edit. */
let generation = 0

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

async function build(libraryID: number): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  const items = await Zotero.Items.getAll(libraryID, true)
  for (const item of items) {
    if (!item.isRegularItem()) continue
    let doi = ''
    try {
      doi = item.getField('DOI') || ''
    } catch {
      // Item types without a DOI field throw rather than returning empty.
      continue
    }
    if (!doi) continue
    const key = normalizeDoi(doi)
    // First writer wins: with duplicates, the earlier item is as good a target
    // as any, and overwriting would make the result depend on iteration order.
    if (!index.has(key)) index.set(key, item.id)
  }
  debugLog(`Citation debug - DOI index for library ${libraryID}: ${index.size} entries`)
  return index
}

export async function getDoiIndex(libraryID: number): Promise<Map<string, number>> {
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
export function clearDoiIndex(): void {
  generation++
  byLibrary.clear()
}

export function registerLibraryIndexNotifier(): void {
  if (notifierID !== false) return
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string) => {
        // Any add, remove or edit can change which DOIs exist.
        if (event === 'add' || event === 'delete' || event === 'trash' || event === 'modify') clearDoiIndex()
      },
    },
    ['item'],
  )
}

export function unregisterLibraryIndexNotifier(): void {
  if (notifierID === false) return
  Zotero.Notifier.unregisterObserver(notifierID)
  notifierID = false
  clearDoiIndex()
}
