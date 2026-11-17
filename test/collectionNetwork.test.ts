import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clusterByCoupling, labelClusters } from '../src/modules/clustering.core.ts'
import {
  CITING_PAGE_CAP,
  chooseSeeds,
  citationEdges,
  citersOfSeveral,
  couplingEdges,
  estimateRequests,
  gapScore,
  MIN_SHARED,
  networkCacheKey,
  rankGaps,
  rematch,
  SHARED_REFS_PER_SEED,
  sharedReferences,
} from '../src/modules/collectionNetwork.core.ts'

import type {
  CollectionNetwork,
  MatchableWork,
  MatchResult,
  NetworkWork,
  SeedWork,
} from '../src/modules/collectionTypes.ts'

function seed(openAlexId: string, referencedWorks: string[], extra: Partial<SeedWork> = {}): SeedWork {
  return {
    itemID: Number(openAlexId.replace(/\D/g, '')) || 1,
    openAlexId,
    doi: null,
    title: openAlexId,
    year: 2020,
    citedByCount: 10,
    referenceCount: referencedWorks.length,
    authors: [],
    referencedWorks,
    primaryTopic: null,
    ...extra,
  }
}

function work(openAlexId: string, extra: Partial<NetworkWork> = {}): NetworkWork {
  return {
    openAlexId,
    doi: null,
    title: openAlexId,
    year: 2020,
    citedByCount: 10,
    referenceCount: null,
    authors: [],
    direction: 'reference',
    seeds: ['S1', 'S2'],
    match: null,
    ...extra,
  }
}

/** A small deterministic PRNG (mulberry32), so random tests are reproducible. */
function prng(seedValue: number): () => number {
  let a = seedValue >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` seeds with `refs` references each, drawn from a pool of `pool` works. */
function randomSeeds(count: number, refs: number, pool: number, random: () => number): SeedWork[] {
  return Array.from({ length: count }, (_, i) => {
    const referenced = Array.from({ length: refs }, () => `R${Math.floor(random() * pool)}`)
    // Now and then a seed cites another seed.
    if (random() < 0.2) referenced.push(`S${String(Math.floor(random() * count)).padStart(3, '0')}`)
    return seed(`S${String(i).padStart(3, '0')}`, referenced)
  })
}

describe('couplingEdges', () => {
  it('counts shared references per pair, a < b, ordered', () => {
    const seeds = [seed('S2', ['R1', 'R2', 'R3']), seed('S1', ['R1', 'R2', 'R9']), seed('S3', ['R3', 'R3'])]
    assert.deepEqual(couplingEdges(seeds), [
      { a: 'S1', b: 'S2', shared: 2 },
      { a: 'S2', b: 'S3', shared: 1 },
    ])
  })

  it('equals a brute-force pairwise count on random data', () => {
    const random = prng(42)
    for (let round = 0; round < 5; round++) {
      const seeds = randomSeeds(40, 15, 120, random)
      const expected: { a: string; b: string; shared: number }[] = []
      for (let i = 0; i < seeds.length; i++) {
        for (let j = 0; j < seeds.length; j++) {
          const [x, y] = [seeds[i], seeds[j]]
          if (x.openAlexId >= y.openAlexId) continue
          const ys = new Set(y.referencedWorks.filter((ref) => ref !== y.openAlexId))
          const shared = new Set(x.referencedWorks.filter((ref) => ref !== x.openAlexId && ys.has(ref))).size
          if (shared > 0) expected.push({ a: x.openAlexId, b: y.openAlexId, shared })
        }
      }
      expected.sort((p, q) => (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : p.b > q.b ? 1 : 0))
      assert.deepEqual(couplingEdges(seeds), expected)
    }
  })
})

describe('sharedReferences', () => {
  it(`keeps non-seed works cited by at least ${MIN_SHARED} seeds`, () => {
    const seeds = [
      seed('S1', ['R1', 'R2', 'S2', 'R4']),
      seed('S2', ['R1', 'R2', 'R3']),
      seed('S3', ['R1', 'S2', 'R3', 'R3']),
    ]
    const shared = sharedReferences(seeds)
    // S2 is cited twice but is a seed; R4 once; R3 twice by one seed counts once.
    assert.deepEqual(
      [...shared],
      [
        ['R1', ['S1', 'S2', 'S3']],
        ['R2', ['S1', 'S2']],
        ['R3', ['S2', 'S3']],
      ],
    )
  })
})

describe('citersOfSeveral', () => {
  it('keeps citers of at least two seeds, once each, without seeds', () => {
    const citers = [
      { openAlexId: 'C1', referencedWorks: ['S1', 'X'] },
      { openAlexId: 'C2', referencedWorks: ['S1', 'S2', 'S2'] },
      { openAlexId: 'C3', referencedWorks: ['S1', 'S2', 'S3'] },
      { openAlexId: 'C2', referencedWorks: ['S1', 'S2'] },
      { openAlexId: 'S3', referencedWorks: ['S1', 'S2'] },
    ]
    const result = citersOfSeveral(citers, ['S1', 'S2', 'S3'])
    assert.deepEqual(
      result.map((entry) => [entry.work.openAlexId, entry.seeds]),
      [
        ['C3', ['S1', 'S2', 'S3']],
        ['C2', ['S1', 'S2']],
      ],
    )
  })
})

describe('citationEdges', () => {
  it('links seed to seed, seed to reference and citer to seed, once each, both ends present', () => {
    const seeds = [seed('S1', ['S2', 'R1', 'R1', 'Rmissing']), seed('S2', ['R1'])]
    const works = [
      work('R1', { seeds: ['S1', 'S2'] }),
      work('C1', { direction: 'citing', seeds: ['S1', 'S2', 'Sgone'] }),
    ]
    assert.deepEqual(citationEdges(seeds, works), [
      { from: 'C1', to: 'S1' },
      { from: 'C1', to: 'S2' },
      { from: 'S1', to: 'R1' },
      { from: 'S1', to: 'S2' },
      { from: 'S2', to: 'R1' },
    ])
  })
})

describe('gapScore', () => {
  it('is seedCount / ln(citedBy + 2), unknown and negative counts as zero', () => {
    assert.equal(gapScore(3, null), 3 / Math.log(2))
    assert.equal(gapScore(3, 0), 3 / Math.log(2))
    assert.equal(gapScore(3, -5), 3 / Math.log(2))
    assert.equal(gapScore(3, 1), 3 / Math.log(3))
    assert.ok(Math.abs(gapScore(5, 41000) - 5 / Math.log(41002)) < 1e-12)
    assert.ok(gapScore(4, 0) > gapScore(5, 41000))
  })
})

describe('rankGaps', () => {
  const exact: MatchResult = { itemID: 9, confidence: 'exact', via: 'doi' }
  const probableMatch: MatchResult = { itemID: 8, confidence: 'probable', via: 'title' }

  it('ranks within direction, with ties by seed count, year and id', () => {
    const works = [
      work('Wfamous', { seeds: ['S1', 'S2', 'S3'], citedByCount: 50000 }),
      work('Wniche', { seeds: ['S1', 'S2'], citedByCount: 0 }),
      // The same score, 2/ln 3 = 4/ln 9: the larger seed count first.
      work('Wtie2', { seeds: ['S1', 'S2'], citedByCount: 1 }),
      work('Wtie4', { seeds: ['S1', 'S2', 'S3', 'S4'], citedByCount: 7 }),
      // Exactly equal: year, newest first, then id.
      work('Wold', { seeds: ['S1', 'S2'], citedByCount: 100, year: 2001 }),
      work('Wnew', { seeds: ['S1', 'S2'], citedByCount: 100, year: 2020 }),
      work('Wnew0', { seeds: ['S1', 'S2'], citedByCount: 100, year: 2020 }),
      work('Wheld', { seeds: ['S1', 'S2', 'S3'], citedByCount: 0, match: exact }),
      work('Wmaybe', { seeds: ['S1', 'S2'], match: probableMatch }),
      work('Cciting', { direction: 'citing', seeds: ['S1', 'S2'], citedByCount: 3 }),
    ]
    const { gaps, probable } = rankGaps(works)
    assert.deepEqual(
      gaps.map((gap) => [gap.openAlexId, gap.direction, gap.rank]),
      [
        ['Wniche', 'reference', 1],
        ['Wtie4', 'reference', 2],
        ['Wtie2', 'reference', 3],
        ['Wnew', 'reference', 4],
        ['Wnew0', 'reference', 5],
        ['Wold', 'reference', 6],
        ['Wfamous', 'reference', 7],
        ['Cciting', 'citing', 1],
      ],
    )
    assert.ok(gaps.every((gap) => gap.match === null && gap.score === gapScore(gap.seeds.length, gap.citedByCount)))
    assert.deepEqual(
      probable.map((entry) => entry.openAlexId),
      ['Wmaybe'],
    )
  })
})

describe('chooseSeeds', () => {
  const items = [
    { itemID: 1, hasIdentifier: false, dateAdded: '2026-01-05 10:00:00' },
    { itemID: 2, hasIdentifier: true, dateAdded: '2024-01-01 10:00:00' },
    { itemID: 3, hasIdentifier: true, dateAdded: '2026-01-01 10:00:00' },
    { itemID: 4, hasIdentifier: false, dateAdded: '2025-01-01 10:00:00' },
    { itemID: 5, hasIdentifier: true, dateAdded: '2026-01-01 10:00:00' },
  ]
  const ids = (list: { itemID: number }[]) => list.map((item) => item.itemID)

  it('orders identifier first, then newest, then higher id', () => {
    assert.deepEqual(ids(chooseSeeds(items, 10, 'all').chosen), [5, 3, 2, 1, 4])
  })

  it('cap keeps the first N and says so', () => {
    const result = chooseSeeds(items, 2, 'cap')
    assert.deepEqual(ids(result.chosen), [5, 3])
    assert.equal(result.capped, true)
    assert.equal(result.needsConfirmation, false)
    assert.equal(chooseSeeds(items, 5, 'cap').capped, false)
  })

  it('warn keeps all and asks only above the limit', () => {
    const over = chooseSeeds(items, 2, 'warn')
    assert.equal(over.chosen.length, 5)
    assert.deepEqual([over.capped, over.needsConfirmation], [false, true])
    assert.equal(chooseSeeds(items, 5, 'warn').needsConfirmation, false)
  })

  it('all keeps all without asking', () => {
    const result = chooseSeeds(items, 2, 'all')
    assert.deepEqual([result.chosen.length, result.capped, result.needsConfirmation], [5, false, false])
  })
})

describe('estimateRequests', () => {
  it('300 seeds, none cached, no citing: 3 lookups + shared-reference batches', () => {
    const estimate = estimateRequests({ seeds: 300, cachedSeeds: 0, withCiting: false, hasKey: false })
    const sharedBatches = Math.ceil((300 * SHARED_REFS_PER_SEED) / 100)
    assert.equal(SHARED_REFS_PER_SEED, 12)
    assert.equal(estimate.listRequests, 3 + sharedBatches)
    assert.equal(estimate.listRequests, 39)
    assert.equal(estimate.singleRequests, 0)
    assert.ok(Math.abs(estimate.usd - 0.0039) < 1e-12)
    assert.equal(estimate.dailyBudgetUsd, 0.1)
    assert.ok(Math.abs(estimate.shareOfDailyBudget - 0.039) < 1e-12)
  })

  it('cached seeds cost no lookup', () => {
    const estimate = estimateRequests({ seeds: 300, cachedSeeds: 250, withCiting: false, hasKey: true })
    assert.equal(estimate.listRequests, 1 + 36)
    assert.equal(estimate.dailyBudgetUsd, 1)
  })

  it('citing pages per group of 100, capped', () => {
    const known = estimateRequests({ seeds: 300, cachedSeeds: 300, withCiting: true, citingCount: 6000, hasKey: true })
    // 3 groups, 2000 citers each, 20 pages each.
    assert.equal(known.listRequests, 36 + 3 * 20)
    const unknown = estimateRequests({ seeds: 300, cachedSeeds: 300, withCiting: true, hasKey: true })
    assert.equal(unknown.listRequests, 36 + 3 * CITING_PAGE_CAP)
    const huge = estimateRequests({ seeds: 100, cachedSeeds: 100, withCiting: true, citingCount: 1e6, hasKey: true })
    assert.equal(huge.listRequests, 12 + CITING_PAGE_CAP)
    const noKey = estimateRequests({ seeds: 100, cachedSeeds: 100, withCiting: true, citingCount: 1e6, hasKey: false })
    assert.equal(noKey.listRequests, 12 + 1)
  })

  it('nothing to do costs nothing', () => {
    const estimate = estimateRequests({ seeds: 0, cachedSeeds: 0, withCiting: true, hasKey: true })
    assert.deepEqual([estimate.listRequests, estimate.usd], [0, 0])
  })
})

describe('rematch', () => {
  it('turns a gap into a held work after an import, without fetching', () => {
    const seeds = [seed('S1', ['R1', 'R2']), seed('S2', ['R1', 'R2'])]
    const works = [work('R1', { doi: '10.1/r1' }), work('R2', { doi: '10.1/r2' })]
    const net: CollectionNetwork = {
      version: 1,
      scope: { kind: 'library', libraryID: 1, name: 'My Library' },
      builtAt: 0,
      seeds,
      works,
      coupling: couplingEdges(seeds),
      citations: citationEdges(seeds, works),
      clusters: [],
      clusterOf: { S1: null, S2: null },
      ...rankGaps(works),
      coverage: {
        itemsInScope: 2,
        analysed: 2,
        capped: false,
        resolved: 2,
        unresolved: [],
        citingIncluded: false,
        citingTruncated: false,
        requestsMade: 3,
      },
    }
    assert.equal(net.gaps.length, 2)

    const asked: MatchableWork[] = []
    const after = rematch(net, (candidate) => {
      asked.push(candidate)
      if (candidate.doi === '10.1/r1') return { itemID: 77, confidence: 'exact', via: 'doi' }
      if (candidate.doi === '10.1/r2') return { itemID: 78, confidence: 'probable', via: 'title' }
      return null
    })
    assert.equal(asked.length, 2)
    assert.deepEqual(after.gaps, [])
    assert.deepEqual(
      after.probable.map((entry) => entry.openAlexId),
      ['R2'],
    )
    assert.equal(after.works[0].match?.itemID, 77)
    // A new network; the old one is untouched, and nothing else changed.
    assert.equal(net.gaps.length, 2)
    assert.equal(net.works[0].match, null)
    assert.equal(after.coverage.requestsMade, 3)
    assert.equal(after.seeds, net.seeds)
  })
})

describe('networkCacheKey', () => {
  it('depends on the seed set and the citing flag, not on order', () => {
    const key = networkCacheKey(['W2', 'W1', 'W3'], false)
    assert.match(key, /^collnet:v1:/)
    assert.equal(networkCacheKey(['W3', 'W1', 'W2', 'W1'], false), key)
    assert.notEqual(networkCacheKey(['W1', 'W2', 'W3'], true), key)
    assert.notEqual(networkCacheKey(['W1', 'W2', 'W4'], false), key)
  })
})

describe('a synthetic 300-seed network', () => {
  it('assembles in under 500 ms and stays JSON-safe', () => {
    const random = prng(7)
    // Three topical neighbourhoods, fifty references a seed.
    const seeds = Array.from({ length: 300 }, (_, i) => {
      const topic = i % 3
      const referenced = Array.from({ length: 50 }, () => `R${topic * 2000 + Math.floor(random() * 2000)}`)
      return seed(`W${String(i).padStart(4, '0')}`, referenced, {
        primaryTopic: { id: `T${topic}`, name: ['Ecology', 'Genetics', 'Optics'][topic] },
      })
    })

    const started = performance.now()
    const shared = sharedReferences(seeds)
    const works = [...shared].map(([id, citers], index) =>
      work(id, {
        seeds: citers,
        citedByCount: index % 500,
        match: index % 10 === 0 ? { itemID: index, confidence: 'exact', via: 'doi' } : null,
      }),
    )
    const coupling = couplingEdges(seeds)
    const assignment = clusterByCoupling(
      seeds.map((entry) => entry.openAlexId),
      coupling,
    )
    const topics = new Map(seeds.map((entry) => [entry.openAlexId, entry.primaryTopic]))
    const clusters = labelClusters(
      assignment,
      (id) => topics.get(id) ?? null,
      (id) => `Cluster ${id + 1}`,
    )
    const { gaps, probable } = rankGaps(works)
    const citations = citationEdges(seeds, works)
    const elapsed = performance.now() - started

    assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)} ms`)
    assert.ok(shared.size > 1000)
    assert.ok(coupling.length > 0)
    assert.ok(clusters.length >= 3, `${clusters.length} clusters`)
    // The three neighbourhoods do not mix.
    for (const cluster of clusters) assert.equal(cluster.topicShare, 1, cluster.label)
    assert.ok(gaps.length > 0 && citations.length > 0)
    assert.equal(probable.length, 0)
    const net = { seeds, works, coupling, clusters, clusterOf: Object.fromEntries(assignment), gaps, citations }
    assert.deepEqual(JSON.parse(JSON.stringify(net)), net)
  })
})
