/**
 * The gaps list, rendered into a real DOM.
 *
 * Nothing builds a CollectionNetwork yet, so the networks here are made by
 * hand: a few seeds, gaps in both directions out of rank order, and the
 * probable matches. The import handler is a fake that resolves with whatever
 * outcome the case needs, which is all the panel sees of an import.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseHTML } from 'linkedom'

import {
  authorLine,
  formatScore,
  gapSections,
  mostReferenced,
  seedsOfGap,
  sortGaps,
} from '../src/modules/gapsPanel.core.ts'

import type { CollectionNetwork, Gap, NetworkWork, SeedWork } from '../src/modules/collectionTypes.ts'
import type { ImportOutcome } from '../src/modules/doiImport.ts'

const { window, document } = parseHTML('<html><body></body></html>')
const noop = (): void => {}
const anything = new Proxy(noop, { get: () => noop, apply: () => undefined })

const globals = globalThis as unknown as Record<string, unknown>
globals.Zotero = new Proxy({}, { get: (_target, key) => (key === 'debug' || key === 'logError' ? noop : anything) })
globals.window = window
globals.document = document
globals.addon = {
  data: {
    config: { addonID: 'orbit@fkallmer.dev', addonRef: 'orbit', addonInstance: 'Orbit' },
    // Message ids come back as themselves, so the assertions read structure.
    locale: {
      current: {
        formatMessagesSync: (reqs: { id: string }[]) => reqs.map(({ id }) => ({ value: id, attributes: null })),
      },
    },
  },
}
globals.ztoolkit = new Proxy({}, { get: () => noop })

const { renderGapsPanel } = await import('../src/modules/gapsPanel.ts')

function seed(n: number): SeedWork {
  return {
    itemID: 100 + n,
    openAlexId: `W${n}`,
    doi: null,
    title: `Seed ${n}`,
    year: 2020,
    citedByCount: 5,
    referenceCount: 10,
    authors: [],
    referencedWorks: [],
    primaryTopic: null,
  }
}

function gap(id: string, rank: number, direction: Gap['direction'], extra: Partial<Gap> = {}): Gap {
  return {
    openAlexId: id,
    doi: `10.1/${id.toLowerCase()}`,
    title: `Gap ${id}`,
    year: 2010,
    citedByCount: 42,
    referenceCount: 20,
    authors: [],
    direction,
    seeds: ['W1', 'W2'],
    match: null,
    score: 1 / rank,
    rank,
    ...extra,
  }
}

function probableWork(id: string, itemID: number): NetworkWork {
  return {
    openAlexId: id,
    doi: null,
    title: `Probable ${id}`,
    year: 2015,
    citedByCount: 3,
    referenceCount: 1,
    authors: [],
    direction: 'reference',
    seeds: ['W1', 'W3'],
    match: { itemID, confidence: 'probable', via: 'title' },
  }
}

function network(gaps: Gap[], probable: NetworkWork[] = []): CollectionNetwork {
  return {
    version: 1,
    scope: { kind: 'collection', collectionID: 7, libraryID: 1, name: 'Test' },
    builtAt: 0,
    seeds: [seed(1), seed(2), seed(3)],
    works: [...gaps, ...probable],
    coupling: [],
    citations: [],
    clusters: [],
    clusterOf: {},
    gaps,
    probable,
    coverage: {
      itemsInScope: 3,
      analysed: 3,
      capped: false,
      resolved: 3,
      unresolved: [],
      citingIncluded: true,
      citingTruncated: false,
      requestsMade: 0,
    },
  }
}

const mixed = network(
  [
    gap('WR3', 3, 'reference'),
    gap('WC1', 1, 'citing', { seeds: ['W3'] }),
    gap('WR1', 1, 'reference', { seeds: ['W1', 'W2', 'W3'] }),
    gap('WR2', 2, 'reference', { doi: null }),
  ],
  [probableWork('WP1', 501), probableWork('WP2', 502)],
)

interface Calls {
  focus: string[]
  show: number[]
  imported: string[]
}

function render(
  net: CollectionNetwork,
  opts: { canImport?: boolean; outcome?: (gap: Gap) => Promise<ImportOutcome> } = {},
): { root: HTMLElement; calls: Calls } {
  const calls: Calls = { focus: [], show: [], imported: [] }
  const root = renderGapsPanel(document as unknown as Document, net, {
    canImport: opts.canImport ?? true,
    onImport: (g) => {
      calls.imported.push(g.openAlexId)
      return opts.outcome ? opts.outcome(g) : Promise.resolve({ status: 'imported', itemID: 900 })
    },
    onFocus: (id) => calls.focus.push(id),
    onShowItem: (id) => calls.show.push(id),
  })
  document.body?.replaceChildren(root)
  return { root, calls }
}

function click(node: Element | null): void {
  assert.ok(node, 'element to click is missing')
  node.dispatchEvent(new window.Event('click'))
}

function rows(root: Element, direction: Gap['direction']): Element[] {
  return [...root.querySelectorAll(`section[data-direction="${direction}"] .orbit-gap`)]
}

function row(root: Element, id: string): Element {
  const found = root.querySelector(`.orbit-gap[data-openalex="${id}"]`)
  assert.ok(found, `row ${id} missing`)
  return found
}

/** Let the click handler's promise chain run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('gaps panel core', () => {
  it('splits the gaps by direction and orders each by rank', () => {
    const sections = gapSections(mixed.gaps)
    assert.deepEqual(
      sections.reference.map((g) => g.openAlexId),
      ['WR1', 'WR2', 'WR3'],
    )
    assert.deepEqual(
      sections.citing.map((g) => g.openAlexId),
      ['WC1'],
    )
  })

  it('names the seeds behind a gap and skips ids the network does not hold', () => {
    const seeds = seedsOfGap({ seeds: ['W2', 'W9', 'W1'] }, mixed)
    assert.deepEqual(
      seeds.map((s) => s.itemID),
      [102, 101],
    )
  })

  it('formats the score to two decimals', () => {
    assert.equal(formatScore(1.23456), '1.23')
    assert.equal(formatScore(2), '2.00')
    assert.equal(formatScore(Number.NaN), '–')
  })
})

describe('gaps panel render', () => {
  it('renders both directions, each in rank order', () => {
    const { root } = render(mixed)
    const reference = rows(root, 'reference')
    assert.equal(reference.length, 3)
    assert.deepEqual(
      reference.map((r) => r.getAttribute('data-rank')),
      ['1', '2', '3'],
    )
    assert.deepEqual(
      reference.map((r) => r.querySelector('.orbit-gap-rank')?.textContent),
      ['1', '2', '3'],
    )
    assert.equal(rows(root, 'citing').length, 1)
    const headings = [...root.querySelectorAll('.orbit-gaps-heading')].map((h) => h.textContent)
    assert.deepEqual(headings, ['orbit-gaps-heading-reference', 'orbit-gaps-heading-citing'])
  })

  it('leaves out the citing section when there are no citing gaps', () => {
    const { root } = render(network([gap('WR1', 1, 'reference')]))
    assert.equal(root.querySelector('section[data-direction="citing"]'), null)
    assert.equal(rows(root, 'reference').length, 1)
  })

  it('shows year, citation count and the score with its explanation', () => {
    const { root } = render(mixed)
    const first = row(root, 'WR1')
    assert.equal(first.querySelector('.orbit-gap-year')?.textContent, '2010')
    assert.equal(first.querySelector('.orbit-gap-cited')?.textContent, 'orbit-gaps-citations')
    const score = first.querySelector('.orbit-gap-score')
    assert.equal(score?.getAttribute('title'), 'orbit-gaps-score-hint')
  })

  it('focuses the gap when its title is clicked', () => {
    const { root, calls } = render(mixed)
    click(row(root, 'WR2').querySelector('.orbit-gap-title'))
    assert.deepEqual(calls.focus, ['WR2'])
  })

  it('expands to the seed titles, each opening its item', () => {
    const { root, calls } = render(mixed)
    const first = row(root, 'WR1')
    const toggle = first.querySelector('.orbit-gap-seeds-toggle')
    const list = first.querySelector<HTMLElement>('.orbit-gap-seeds')
    assert.equal(toggle?.getAttribute('data-count'), '3')
    assert.ok(toggle?.textContent?.includes('orbit-gaps-cited-by'))
    assert.equal(list?.style.display, 'none')
    assert.equal(toggle?.getAttribute('aria-expanded'), 'false')

    click(toggle)
    assert.equal(list?.style.display, '')
    assert.equal(toggle?.getAttribute('aria-expanded'), 'true')
    const seeds = [...first.querySelectorAll('.orbit-gap-seed')]
    assert.deepEqual(
      seeds.map((s) => s.textContent),
      ['Seed 1', 'Seed 2', 'Seed 3'],
    )
    click(seeds[1])
    assert.deepEqual(calls.show, [102])

    click(toggle)
    assert.equal(list?.style.display, 'none')
  })

  it('words the seed line for citing gaps as citing your items', () => {
    const { root } = render(mixed)
    const toggle = row(root, 'WC1').querySelector('.orbit-gap-seeds-toggle')
    assert.ok(toggle?.textContent?.includes('orbit-gaps-cites'))
    assert.equal(toggle?.getAttribute('data-count'), '1')
  })

  it('offers Import only for gaps with a DOI', () => {
    const { root } = render(mixed)
    assert.ok(row(root, 'WR1').querySelector('.orbit-gap-import'))
    assert.equal(row(root, 'WR2').querySelector('.orbit-gap-import'), null)
  })

  it('hides every Import button when importing is not possible', () => {
    const { root } = render(mixed, { canImport: false })
    assert.equal(root.querySelectorAll('.orbit-gap-import').length, 0)
  })

  for (const outcome of [
    { status: 'imported', itemID: 900 },
    { status: 'exists', itemID: 901, addedToCollection: true },
  ] as const) {
    it(`turns into "in your library" on ${outcome.status}`, async () => {
      let resolve: (value: ImportOutcome) => void = noop
      const { root, calls } = render(mixed, { outcome: () => new Promise((r) => (resolve = r)) })
      const button = row(root, 'WR1').querySelector<HTMLButtonElement>('.orbit-gap-import')
      click(button)
      assert.equal(button?.disabled, true)
      assert.equal(button?.getAttribute('data-state'), 'running')
      assert.equal(button?.textContent, 'orbit-import-running')
      // A second click while running does not start a second import.
      click(button)
      assert.deepEqual(calls.imported, ['WR1'])

      resolve(outcome)
      await settle()
      assert.equal(button?.getAttribute('data-state'), 'done')
      assert.equal(button?.disabled, true)
      assert.equal(button?.textContent, 'orbit-import-done')
      assert.equal(button?.getAttribute('data-item-id'), String(outcome.itemID))
    })
  }

  for (const reason of ['read-only', 'no-translator', 'no-result', 'error'] as const) {
    it(`shows the reason and re-enables on failed (${reason})`, async () => {
      const { root } = render(mixed, {
        outcome: () => Promise.resolve({ status: 'failed', reason, message: 'detail' }),
      })
      const control = row(root, 'WR1')
      const button = control.querySelector<HTMLButtonElement>('.orbit-gap-import')
      const note = control.querySelector<HTMLElement>('.orbit-gap-import-error')
      assert.equal(note?.style.display, 'none')
      click(button)
      await settle()
      assert.equal(button?.disabled, false)
      assert.equal(button?.getAttribute('data-state'), 'failed')
      assert.equal(button?.textContent, 'orbit-import-button')
      assert.equal(note?.textContent, `orbit-import-failed-${reason}`)
      assert.equal(note?.getAttribute('title'), 'detail')
      assert.equal(note?.style.display, '')
    })
  }

  it('reads a rejected import as an error and lets it be retried', async () => {
    let attempt = 0
    const { root, calls } = render(mixed, {
      outcome: () =>
        attempt++ === 0 ? Promise.reject(new Error('boom')) : Promise.resolve({ status: 'imported', itemID: 5 }),
    })
    const control = row(root, 'WR1')
    const button = control.querySelector<HTMLButtonElement>('.orbit-gap-import')
    click(button)
    await settle()
    assert.equal(control.querySelector('.orbit-gap-import-error')?.textContent, 'orbit-import-failed-error')
    click(button)
    await settle()
    assert.equal(button?.getAttribute('data-state'), 'done')
    assert.deepEqual(calls.imported, ['WR1', 'WR1'])
  })

  it('goes quietly back to idle when the user declines the confirmation', async () => {
    const { root } = render(mixed, { outcome: () => Promise.resolve({ status: 'cancelled' }) })
    const control = row(root, 'WR1')
    const button = control.querySelector<HTMLButtonElement>('.orbit-gap-import')
    click(button)
    await settle()
    assert.equal(button?.getAttribute('data-state'), 'idle')
    assert.equal(button?.disabled, false)
    assert.equal(button?.textContent, 'orbit-import-button')
    // A deliberate No is not an error, so no error note appears.
    assert.equal(control.querySelector<HTMLElement>('.orbit-gap-import-error')?.style.display, 'none')
  })

  it('collapses the probable matches behind their count, each with Show item', () => {
    const { root, calls } = render(mixed)
    const probable = root.querySelector('.orbit-gaps-probable')
    assert.equal(probable?.getAttribute('data-count'), '2')
    const toggle = probable?.querySelector('.orbit-gaps-probable-toggle')
    assert.ok(toggle?.textContent?.includes('orbit-gaps-probable-heading'))
    const list = probable?.querySelector<HTMLElement>('.orbit-gaps-probable-list')
    assert.equal(list?.style.display, 'none')
    assert.equal(probable?.querySelectorAll('.orbit-gaps-probable-item').length, 2)
    click(toggle ?? null)
    assert.equal(list?.style.display, '')
    click(probable?.querySelector('.orbit-gaps-probable-item[data-openalex="WP2"] .orbit-gaps-show-item') ?? null)
    assert.deepEqual(calls.show, [502])
    // Probable matches are not gaps: no Import.
    assert.equal(probable?.querySelectorAll('.orbit-gap-import').length, 0)
  })

  it('has no probable section when nothing matched by title', () => {
    const { root } = render(network([gap('WR1', 1, 'reference')]))
    assert.equal(root.querySelector('.orbit-gaps-probable'), null)
  })

  it('says so when there are no gaps', () => {
    const { root } = render(network([], [probableWork('WP1', 501)]))
    assert.equal(root.querySelector('.orbit-gaps-empty')?.textContent, 'orbit-gaps-empty')
    assert.equal(root.querySelectorAll('.orbit-gaps-section').length, 0)
    // The probable matches still show beside the empty state.
    assert.ok(root.querySelector('.orbit-gaps-probable'))
  })
})

describe('sorting the gaps', () => {
  const sortable = [
    gap('WA', 1, 'reference', { year: 2001, citedByCount: 10, referenceCount: 5 }),
    gap('WB', 2, 'reference', { year: 2019, citedByCount: null, referenceCount: 90 }),
    gap('WC', 3, 'reference', { year: null, citedByCount: 900, referenceCount: null }),
    gap('WD', 4, 'reference', { year: 2019, citedByCount: 50, referenceCount: 40 }),
  ]
  const order = (sort: Parameters<typeof sortGaps>[1]): string[] => sortGaps(sortable, sort).map((g) => g.openAlexId)

  it('orders by score rank by default', () => {
    assert.deepEqual(order(undefined), ['WA', 'WB', 'WC', 'WD'])
    assert.deepEqual(order('score'), ['WA', 'WB', 'WC', 'WD'])
  })

  it('orders by year, newest first, ties by rank, unknown last', () => {
    assert.deepEqual(order('year'), ['WB', 'WD', 'WA', 'WC'])
  })

  it('orders by citations and by references, highest first, unknown last', () => {
    assert.deepEqual(order('citations'), ['WC', 'WD', 'WA', 'WB'])
    assert.deepEqual(order('references'), ['WB', 'WD', 'WA', 'WC'])
  })

  it('reorders the rows in place, keeping each rank number and an import already done', async () => {
    const { root } = render(network(sortable))
    const button = row(root, 'WA').querySelector<HTMLButtonElement>('.orbit-gap-import')
    click(button)
    await settle()
    assert.equal(button?.getAttribute('data-state'), 'done')

    const select = root.querySelector<HTMLSelectElement>('.orbit-gaps-sort-select')
    assert.ok(select)
    // linkedom's select.value has only a getter; Gecko's sets the choice.
    Object.defineProperty(select, 'value', { value: 'citations', configurable: true })
    select.dispatchEvent(new window.Event('change'))

    const shown = rows(root, 'reference')
    assert.deepEqual(
      shown.map((r) => r.getAttribute('data-openalex')),
      ['WC', 'WD', 'WA', 'WB'],
    )
    // Rank numbers are the score ranks, the numbers on the graph's marks.
    assert.deepEqual(
      shown.map((r) => r.querySelector('.orbit-gap-rank')?.textContent),
      ['3', '4', '1', '2'],
    )
    // The same row element, so the finished import is still shown.
    assert.equal(row(root, 'WA').querySelector('.orbit-gap-import')?.getAttribute('data-state'), 'done')
  })

  it('shows the reference count when it is known', () => {
    const { root } = render(network(sortable))
    assert.equal(row(root, 'WB').querySelector('.orbit-gap-references')?.textContent, 'orbit-gaps-references')
    assert.equal(row(root, 'WC').querySelector('.orbit-gap-references'), null)
  })
})

describe('the author line', () => {
  it('names one author, two joined, or the first and et al.', () => {
    assert.deepEqual(authorLine([]), { kind: 'none' })
    assert.deepEqual(authorLine(['Yann LeCun']), { kind: 'one', first: 'LeCun' })
    assert.deepEqual(authorLine(['Sepp Hochreiter', 'Jürgen Schmidhuber']), {
      kind: 'two',
      first: 'Hochreiter',
      second: 'Schmidhuber',
    })
    assert.deepEqual(authorLine(['Martin Jinek', 'Krzysztof Chylinski', 'Ines Fonfara']), {
      kind: 'many',
      first: 'Jinek',
    })
  })

  it('takes the surname the way the graph label does, and skips blank names', () => {
    assert.deepEqual(authorLine(['Doudna, Jennifer A.', '  ']), { kind: 'one', first: 'Doudna' })
  })

  it('shows the authors in the row, with the full list on hover', () => {
    const { root } = render(
      network([
        gap('WX', 1, 'reference', { authors: ['Martin Jinek', 'Krzysztof Chylinski', 'Ines Fonfara'] }),
        gap('WY', 2, 'reference', { authors: [] }),
      ]),
    )
    const authors = row(root, 'WX').querySelector('.orbit-gap-authors')
    assert.equal(authors?.textContent, 'orbit-gaps-authors-many')
    assert.equal(authors?.getAttribute('title'), 'Martin Jinek, Krzysztof Chylinski, Ines Fonfara')
    assert.equal(row(root, 'WY').querySelector('.orbit-gap-authors'), null)
  })
})

describe('the most referenced view', () => {
  // W1..W3 are the analysed items. HELD is a shared reference the library has,
  // MISS one it lacks, ONCE is cited by one item only; W2 is cited by W1 and W3.
  const held: NetworkWork = {
    ...probableWork('HELD', 700),
    title: 'Held work',
    seeds: ['W1', 'W2', 'W3'],
    citedByCount: 900,
    match: { itemID: 700, confidence: 'exact', via: 'doi' },
  }
  const missing = gap('MISS', 1, 'reference', { seeds: ['W1', 'W3'], citedByCount: 50 })
  const once = gap('ONCE', 2, 'reference', { seeds: ['W1'] })
  const net: CollectionNetwork = {
    ...network([missing, once]),
    works: [held, missing, once],
    citations: [
      { from: 'W1', to: 'W2' },
      { from: 'W3', to: 'W2' },
      { from: 'W1', to: 'HELD' },
    ],
  }

  it('lists every work two items cite, held or not, the analysed items included', () => {
    const list = mostReferenced(net)
    assert.deepEqual(
      list.map((w) => [w.openAlexId, w.seeds.length, w.held, w.rank]),
      [
        ['HELD', 3, 'exact', 1],
        ['MISS', 2, null, 2],
        ['W2', 2, 'seed', 3],
      ],
    )
  })

  it('switches between the missing works and the most referenced', () => {
    const { root } = render(net)
    const missingView = root.querySelector<HTMLElement>('.orbit-gaps-view-missing')
    const referencedView = root.querySelector<HTMLElement>('.orbit-gaps-view-referenced')
    assert.equal(missingView?.style.display, 'flex')
    assert.equal(referencedView?.style.display, 'none')
    click(root.querySelector('.orbit-gaps-view[data-view="referenced"]'))
    assert.equal(missingView?.style.display, 'none')
    assert.equal(referencedView?.style.display, 'flex')
  })

  it('offers Show item for what is held and Import for what is not', () => {
    const { root, calls } = render(net)
    const heldRow = root.querySelector('.orbit-referenced[data-openalex="HELD"]')
    assert.equal(heldRow?.getAttribute('data-held'), 'exact')
    click(heldRow?.querySelector('.orbit-gaps-show-item') ?? null)
    assert.deepEqual(calls.show, [700])
    const missingRow = root.querySelector('.orbit-referenced[data-openalex="MISS"]')
    assert.ok(missingRow?.querySelector('.orbit-gap-import'), 'no import on a missing work')
    const seedRow = root.querySelector('.orbit-referenced[data-openalex="W2"]')
    assert.equal(seedRow?.getAttribute('data-held'), 'seed')
  })
})
