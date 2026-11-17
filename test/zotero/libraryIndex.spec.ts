/**
 * The library index against real Zotero items.
 *
 * The Node tests stub `getField`, so they cannot say what Zotero does when an
 * item type lacks a field: throw, as the index assumes, or return empty. Both
 * must leave the item's other identifiers indexed. This creates items in the
 * test profile, reads the index, and removes them again.
 *
 * Bundled by the scaffold into the Zotero test window, like startup.spec.ts.
 */

import { clearLibraryIndex, getLibraryIndex } from '../../src/modules/libraryIndex'

declare const Zotero: any
declare function describe(title: string, fn: (this: { timeout: (ms: number) => void }) => void): void
declare function it(title: string, fn: () => void | Promise<void>): void
declare function after(fn: () => void | Promise<void>): void

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function fieldValid(type: string, field: string): boolean {
  return Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), Zotero.ItemTypes.getID(type))
}

describe('Orbit library index', function () {
  this.timeout(30000)
  const created: number[] = []

  async function make(type: string, fields: Record<string, string>): Promise<number> {
    const item = new Zotero.Item(type)
    item.libraryID = Zotero.Libraries.userLibraryID
    for (const [name, value] of Object.entries(fields)) item.setField(name, value)
    // skipNotifier: with fetchOnAdd on, a notified add would send these probes
    // to Crossref and Semantic Scholar and write counts into them mid-test.
    await item.saveTx({ skipNotifier: true })
    created.push(item.id)
    return item.id
  }

  after(async () => {
    for (const id of created) await Zotero.Items.get(id).eraseTx({ skipNotifier: true })
    clearLibraryIndex()
  })

  it('indexes a preprint by its DOI, Archive ID and arXiv URL', async () => {
    const id = await make('preprint', {
      title: 'Orbit index probe: preprint',
      DOI: '10.48550/arXiv.1706.03762',
      archiveID: 'arXiv:1706.03762',
      url: 'https://arxiv.org/abs/1706.03762v5',
    })
    clearLibraryIndex()
    const index = await getLibraryIndex(Zotero.Libraries.userLibraryID)
    ok(index.get('doi:10.48550/arxiv.1706.03762') === id, 'DOI key missing')
    ok(index.get('arxiv:1706.03762') === id, 'arXiv key missing')
  })

  it('indexes the Extra lines of a type without a DOI field', async () => {
    // Whichever common type lacks the field in this Zotero; the point is the
    // field lookup that fails, not the type.
    const type = ['webpage', 'thesis', 'book', 'report'].find((candidate) => !fieldValid(candidate, 'DOI'))
    ok(type, 'every candidate type has a DOI field here; pick another')
    const id = await make(type, {
      title: 'Orbit index probe: no DOI field',
      extra: 'DOI: 10.9999/orbit-probe\nPMID: 99999999\narXiv:1409.0473 [cs.CL]',
    })
    clearLibraryIndex()
    const index = await getLibraryIndex(Zotero.Libraries.userLibraryID)
    ok(index.get('doi:10.9999/orbit-probe') === id, `Extra DOI key missing on ${type}`)
    ok(index.get('pmid:99999999') === id, `PMID key missing on ${type}`)
    ok(index.get('arxiv:1409.0473') === id, `Extra arXiv key missing on ${type}`)
  })
})
