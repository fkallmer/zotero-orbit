/**
 * Adding a work to the library by its DOI, the way "Add Item by Identifier"
 * does it.
 *
 * The gaps list offers this for works the user's items lean on but the
 * library does not hold. Two things decide the route: a work the library
 * already has is only filed into the collection, never imported a second
 * time; anything else goes through Zotero's own search translators, so the
 * metadata, the attachment behaviour and the "downloadAssociatedFiles"
 * preference are exactly what the toolbar's magic wand would produce.
 *
 * The translate call sequence is the one Zotero_Lookup.addItemsFromIdentifier
 * uses (chrome/content/zotero/lookup.js): new Zotero.Translate.Search(),
 * setIdentifier, getTranslators, setTranslator, translate({ libraryID,
 * collections, saveAttachments }).
 */

import { getString } from '../utils/locale'
import { debugLog } from '../utils/log'

import { findInLibrary, getLibraryIndex, normalizeDoi } from './libraryIndex'

import type { Gap } from './collectionTypes'

export interface ImportTarget {
  libraryID: number
  collectionID: number | null
}

export type ImportOutcome =
  | { status: 'imported'; itemID: number }
  | { status: 'exists'; itemID: number; addedToCollection: boolean }
  | { status: 'failed'; reason: 'read-only' | 'no-translator' | 'no-result' | 'error'; message?: string }

/**
 * Minimal shape of the parts of Zotero.Translate.Search this module uses.
 * zotero-types does not describe the translation architecture at all.
 */
interface TranslateSearch {
  setIdentifier: (identifier: { DOI: string }) => void
  getTranslators: () => Promise<unknown[]>
  setTranslator: (translators: unknown[]) => void
  translate: (options: {
    libraryID: number
    collections: number[] | false
    saveAttachments: boolean
  }) => Promise<Zotero.Item[]>
}

interface TranslateNamespace {
  Search: new () => TranslateSearch
}

/**
 * What a search translator rejects with when every candidate came back empty.
 * Zotero.Translate.Search.prototype.ERROR_NO_RESULTS in zotero/translate.
 */
const ERROR_NO_RESULTS = 'No items returned from any translator'

/** Whether `target` names an editable library and, if given, a collection in it. */
export function canImportInto(target: ImportTarget): boolean {
  if (!Zotero.Libraries.exists(target.libraryID)) return false
  const library = Zotero.Libraries.get(target.libraryID)
  if (!library || !library.editable) return false
  if (target.collectionID === null) return true
  const collection = Zotero.Collections.get(target.collectionID)
  return !!collection && collection.libraryID === target.libraryID
}

/** Ask before writing to the library. True only on an explicit yes. */
export function confirmImport(win: Window, work: Pick<Gap, 'title' | 'doi' | 'year'>, targetName: string): boolean {
  const text = getString('import-confirm-body', {
    args: {
      title: work.title,
      year: work.year === null ? getString('import-confirm-no-year') : String(work.year),
      doi: work.doi ?? '',
      target: targetName,
    },
  })
  // Gecko types the parent as mozIDOMWindowProxy; a chrome Window is one.
  return Services.prompt.confirm(win as unknown as mozIDOMWindowProxy, getString('import-confirm-title'), text)
}

/**
 * Imports run one at a time. Two clicks in quick succession on the same DOI
 * would otherwise both miss the library index and both import, and the
 * translators are not built for a burst of parallel searches either.
 */
let queue: Promise<unknown> = Promise.resolve()

export function importByDoi(doi: string, target: ImportTarget): Promise<ImportOutcome> {
  const run = queue.then(() => importNow(doi, target))
  // The chain continues whatever this import does.
  queue = run.catch(() => undefined)
  return run
}

async function importNow(rawDoi: string, target: ImportTarget): Promise<ImportOutcome> {
  if (!canImportInto(target)) return { status: 'failed', reason: 'read-only' }
  // OpenAlex hands DOIs over as https://doi.org/ URLs; the DOI translators want the bare DOI.
  const doi = normalizeDoi(rawDoi)
  const { libraryID, collectionID } = target
  try {
    const existing = findInLibrary(await getLibraryIndex(libraryID), { doi })
    if (existing !== null) return await fileExisting(existing, collectionID)

    const Translate = (Zotero as unknown as { Translate: TranslateNamespace }).Translate
    const translate = new Translate.Search()
    translate.setIdentifier({ DOI: doi })
    const translators = await translate.getTranslators()
    if (!translators.length) return { status: 'failed', reason: 'no-translator' }
    translate.setTranslator(translators)
    let items: Zotero.Item[]
    try {
      items = await translate.translate({
        libraryID,
        collections: collectionID === null ? false : [collectionID],
        saveAttachments: !!Zotero.Prefs.get('downloadAssociatedFiles'),
      })
    } catch (error) {
      // The search translators reject, rather than resolve empty, when none
      // of them found the DOI.
      if (messageOf(error).includes(ERROR_NO_RESULTS)) return { status: 'failed', reason: 'no-result' }
      throw error
    }
    const item = items.find((candidate) => candidate.isRegularItem()) ?? items[0]
    if (!item) return { status: 'failed', reason: 'no-result' }
    debugLog(`Citation debug - Imported ${doi} as item ${item.id}`)
    return { status: 'imported', itemID: item.id }
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(messageOf(error)))
    return { status: 'failed', reason: 'error', message: messageOf(error) }
  }
}

async function fileExisting(itemID: number, collectionID: number | null): Promise<ImportOutcome> {
  if (collectionID === null) return { status: 'exists', itemID, addedToCollection: false }
  const item = await Zotero.Items.getAsync(itemID)
  if (!item) throw new Error(`Item ${itemID} is in the library index but could not be loaded`)
  if (item.inCollection(collectionID)) return { status: 'exists', itemID, addedToCollection: false }
  item.addToCollection(collectionID)
  await item.saveTx()
  return { status: 'exists', itemID, addedToCollection: true }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
