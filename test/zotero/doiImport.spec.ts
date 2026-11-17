/**
 * Importing by DOI against a real Zotero library, for the part that does not
 * touch the network: a DOI the library already holds is filed into the
 * collection, not imported a second time.
 *
 * The real translation (Zotero.Translate.Search against the DOI translators)
 * is not exercised here; it would make CI depend on Crossref and DataCite.
 *
 * Bundled by the scaffold into the Zotero test window, like startup.spec.ts.
 */

import { canImportInto, importByDoi } from '../../src/modules/doiImport'
import { clearLibraryIndex } from '../../src/modules/libraryIndex'

declare const Zotero: any
declare function describe(title: string, fn: (this: { timeout: (ms: number) => void }) => void): void
declare function it(title: string, fn: () => void | Promise<void>): void
declare function after(fn: () => void | Promise<void>): void

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

describe('Orbit DOI import', function () {
  this.timeout(30000)
  const libraryID: number = Zotero.Libraries.userLibraryID
  const items: number[] = []
  const collections: number[] = []

  after(async () => {
    for (const id of items) await Zotero.Items.get(id)?.eraseTx({ skipNotifier: true })
    for (const id of collections) await Zotero.Collections.get(id)?.eraseTx({ skipNotifier: true })
    clearLibraryIndex()
  })

  it('files an item the library already holds into the collection', async () => {
    const collection = new Zotero.Collection()
    collection.libraryID = libraryID
    collection.name = 'Orbit import probe'
    await collection.saveTx({ skipNotifier: true })
    collections.push(collection.id)

    const doi = '10.9999/orbit-import-probe'
    const item = new Zotero.Item('journalArticle')
    item.libraryID = libraryID
    item.setField('title', 'Orbit import probe')
    item.setField('DOI', doi)
    // skipNotifier: with fetchOnAdd on, a notified add would send the probe
    // to the citation sources mid-test.
    await item.saveTx({ skipNotifier: true })
    items.push(item.id)
    clearLibraryIndex()

    const target = { libraryID, collectionID: collection.id }
    ok(canImportInto(target), 'the user library and the probe collection should be importable')

    // Upper case and a resolver prefix: the lookup has to normalise both.
    const first = await importByDoi(`https://doi.org/${doi.toUpperCase()}`, target)
    ok(first.status === 'exists', `expected exists, got ${JSON.stringify(first)}`)
    ok(first.itemID === item.id, `expected item ${item.id}, got ${first.itemID}`)
    ok(first.addedToCollection, 'the item should have been added to the collection')
    const reloaded = await Zotero.Items.getAsync(item.id)
    ok(reloaded.inCollection(collection.id), 'the item is not in the collection')

    const second = await importByDoi(doi, target)
    ok(
      second.status === 'exists' && !second.addedToCollection,
      `expected exists without adding, got ${JSON.stringify(second)}`,
    )
  })

  it('refuses a library that does not exist', () => {
    ok(!canImportInto({ libraryID: 987654321, collectionID: null }), 'a nonexistent library should not be importable')
  })

  it('refuses a collection that does not exist', () => {
    ok(!canImportInto({ libraryID, collectionID: 987654321 }), 'a nonexistent collection should not be importable')
  })
})
