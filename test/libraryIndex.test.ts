/**
 * The DOI index that marks references already in the library.
 *
 * It decides whether a row in the item pane and a node in the graph say "you
 * have this", so a wrong key here draws a ring around the wrong paper. The
 * Zotero calls are stubbed one by one rather than with a catch-all proxy, so
 * every assertion is about something the module actually asked Zotero for.
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

interface FakeItem {
  id: number
  isRegularItem: () => boolean
  getField: (name: string) => string
}

interface Observer {
  notify: (event: string, type: string, ids: number[], extra: object) => void
}

/** What the module asked of Zotero, so tests can assert on it. */
const calls = {
  getAll: [] as Array<[number, boolean]>,
  registered: [] as Array<[Observer, string[]]>,
  unregistered: [] as string[],
}
let libraries: Record<number, FakeItem[]> = {}

const globals = globalThis as unknown as Record<string, unknown>
globals.Zotero = {
  Items: {
    getAll: async (libraryID: number, onlyTopLevel: boolean) => {
      calls.getAll.push([libraryID, onlyTopLevel])
      return libraries[libraryID] ?? []
    },
  },
  Notifier: {
    registerObserver: (observer: Observer, types: string[]) => {
      calls.registered.push([observer, types])
      return `observer-${calls.registered.length}`
    },
    unregisterObserver: (id: string) => {
      calls.unregistered.push(id)
    },
  },
  // debugLog reads this; off keeps ztoolkit out of the picture.
  Prefs: { get: () => undefined },
}

const { normalizeDoi, getDoiIndex, clearDoiIndex, registerLibraryIndexNotifier, unregisterLibraryIndexNotifier } =
  await import('../src/modules/libraryIndex.ts')

function item(id: number, doi: string, options: { regular?: boolean; throws?: boolean } = {}): FakeItem {
  return {
    id,
    isRegularItem: () => options.regular ?? true,
    getField: (name: string) => {
      assert.equal(name, 'DOI')
      if (options.throws) throw new Error(`'DOI' is not a valid field for this item type`)
      return doi
    },
  }
}

function lastObserver(): Observer {
  const last = calls.registered.at(-1)
  assert.ok(last, 'no observer was registered')
  return last[0]
}

beforeEach(() => {
  clearDoiIndex()
  libraries = {}
  calls.getAll.length = 0
})

describe('normalizeDoi', () => {
  it('drops resolver prefixes, case and surrounding space', () => {
    assert.equal(normalizeDoi('10.1000/ABC'), '10.1000/abc')
    assert.equal(normalizeDoi('  10.1000/abc \n'), '10.1000/abc')
    assert.equal(normalizeDoi('https://doi.org/10.1000/ABC'), '10.1000/abc')
    assert.equal(normalizeDoi('http://dx.doi.org/10.1000/abc'), '10.1000/abc')
    assert.equal(normalizeDoi('HTTPS://DOI.ORG/10.1000/abc'), '10.1000/abc')
    assert.equal(normalizeDoi('doi:10.1000/abc'), '10.1000/abc')
    assert.equal(normalizeDoi('DOI: 10.1000/abc'), '10.1000/abc')
  })

  it('leaves the rest of the DOI alone', () => {
    // Only a leading prefix is stripped; the suffix may contain anything.
    assert.equal(normalizeDoi('10.1000/doi.org/x'), '10.1000/doi.org/x')
    assert.equal(normalizeDoi('10.1002/(SICI)1097-4636'), '10.1002/(sici)1097-4636')
  })
})

describe('getDoiIndex', () => {
  it('maps each normalized DOI to its item, asking for top-level items only', async () => {
    libraries[1] = [item(10, 'https://doi.org/10.1/A'), item(11, '10.1/b')]
    const index = await getDoiIndex(1)
    assert.deepEqual(
      [...index],
      [
        ['10.1/a', 10],
        ['10.1/b', 11],
      ],
    )
    assert.deepEqual(calls.getAll, [[1, true]])
  })

  it('skips notes and attachments, items without a DOI, and types without the field', async () => {
    libraries[1] = [
      item(20, '10.1/note', { regular: false }),
      item(21, ''),
      item(22, '', { throws: true }),
      item(23, '10.1/kept'),
    ]
    assert.deepEqual([...(await getDoiIndex(1))], [['10.1/kept', 23]])
  })

  it('keeps the first item when two share a DOI', async () => {
    libraries[1] = [item(30, '10.1/dup'), item(31, 'doi:10.1/DUP')]
    assert.equal((await getDoiIndex(1)).get('10.1/dup'), 30)
  })

  it('builds once per library until cleared', async () => {
    libraries[1] = [item(40, '10.1/a')]
    libraries[2] = [item(50, '10.1/a')]
    const first = await getDoiIndex(1)
    assert.equal(await getDoiIndex(1), first)
    assert.equal((await getDoiIndex(2)).get('10.1/a'), 50)
    assert.deepEqual(calls.getAll, [
      [1, true],
      [2, true],
    ])

    clearDoiIndex()
    libraries[1] = [item(41, '10.1/a')]
    assert.equal((await getDoiIndex(1)).get('10.1/a'), 41)
    assert.equal(calls.getAll.length, 3)
  })
})

describe('the notifier', () => {
  it('registers once for item events and clears on changes that can move a DOI', async () => {
    registerLibraryIndexNotifier()
    registerLibraryIndexNotifier()
    assert.equal(calls.registered.length, 1)
    assert.deepEqual(calls.registered[0]?.[1], ['item'])
    const observer = lastObserver()

    for (const event of ['add', 'delete', 'trash', 'modify']) {
      libraries[1] = [item(60, '10.1/a')]
      await getDoiIndex(1)
      const before = calls.getAll.length
      observer.notify(event, 'item', [60], {})
      await getDoiIndex(1)
      assert.equal(calls.getAll.length, before + 1, `${event} should invalidate`)
    }

    for (const event of ['select', 'refresh', 'index']) {
      await getDoiIndex(1)
      const before = calls.getAll.length
      observer.notify(event, 'item', [60], {})
      await getDoiIndex(1)
      assert.equal(calls.getAll.length, before, `${event} should not invalidate`)
    }

    unregisterLibraryIndexNotifier()
  })

  it('unregisters the observer it registered, clears, and does nothing a second time', async () => {
    registerLibraryIndexNotifier()
    const id = `observer-${calls.registered.length}`
    libraries[1] = [item(70, '10.1/a')]
    await getDoiIndex(1)

    unregisterLibraryIndexNotifier()
    assert.equal(calls.unregistered.at(-1), id)
    await getDoiIndex(1)
    assert.equal(calls.getAll.length, 2, 'unregistering should drop the cached index')

    const unregisteredBefore = calls.unregistered.length
    unregisterLibraryIndexNotifier()
    assert.equal(calls.unregistered.length, unregisteredBefore)

    // And it can be registered again afterwards.
    registerLibraryIndexNotifier()
    assert.equal(calls.registered.length, 3)
    unregisterLibraryIndexNotifier()
  })
})
