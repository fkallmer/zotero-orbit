import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  centroid,
  clusterEntries,
  clusterShown,
  DEFAULT_NETWORK_OPTIONS,
  DRAW_LIMITS,
  hiddenBySelection,
  importTargetFor,
  networkScopeFor,
  networkToGraph,
  routeFor,
  surnameOf,
  toggleClusterSelection,
} from '../src/modules/collectionGraph.core.ts'
import { rankGaps } from '../src/modules/collectionNetwork.core.ts'

import type { CollectionNetwork, NetworkWork, SeedWork } from '../src/modules/collectionTypes.ts'
import type { NetworkGraphOptions } from '../src/modules/collectionGraph.core.ts'

function seed(id: string, itemID: number, extra: Partial<SeedWork> = {}): SeedWork {
  return {
    itemID,
    openAlexId: id,
    doi: `10.1/${id.toLowerCase()}`,
    title: `Seed ${id}`,
    year: 2020,
    citedByCount: 10,
    referenceCount: 30,
    authors: ['Ada Lovelace'],
    referencedWorks: [],
    primaryTopic: null,
    ...extra,
  }
}

function work(id: string, extra: Partial<NetworkWork> = {}): NetworkWork {
  return {
    openAlexId: id,
    doi: `10.2/${id.toLowerCase()}`,
    title: `Work ${id}`,
    year: 2010,
    citedByCount: 100,
    referenceCount: 20,
    authors: ['Turing, Alan'],
    direction: 'reference',
    seeds: ['S1', 'S2'],
    match: null,
    ...extra,
  }
}

function network(works: NetworkWork[], extra: Partial<CollectionNetwork> = {}): CollectionNetwork {
  const { gaps, probable } = rankGaps(works)
  return {
    version: 1,
    scope: { kind: 'collection', collectionID: 7, libraryID: 1, name: 'Mine' },
    builtAt: 0,
    seeds: [seed('S1', 101), seed('S2', 102), seed('S3', 103)],
    works,
    coupling: [],
    citations: [],
    clusters: [
      { id: 0, label: 'Topic A', topicShare: 1, members: ['S1', 'S2'] },
      { id: 1, label: 'Topic B', topicShare: 1, members: [] },
    ],
    clusterOf: { S1: 0, S2: 0, S3: null },
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
      requestsMade: 3,
    },
    ...extra,
  }
}

const all: NetworkGraphOptions = { ...DEFAULT_NETWORK_OPTIONS }

describe('networkToGraph', () => {
  it('draws every seed as a seed, keyed by its OpenAlex id, with its item and cluster', () => {
    const { nodes } = networkToGraph(network([]), all)
    const seeds = nodes.filter((node) => node.role === 'seed')
    assert.deepEqual(
      seeds.map((node) => [node.key, node.itemID, node.cluster, node.match]),
      [
        ['S1', 101, 0, 'exact'],
        ['S2', 102, 0, 'exact'],
        ['S3', 103, null, 'exact'],
      ],
    )
    assert.equal(seeds[0].author, 'Lovelace')
    assert.equal(seeds[0].hollow, undefined)
  })

  it('gives reference and citing works their roles, and leaves their cluster unset', () => {
    const { nodes } = networkToGraph(network([work('R'), work('C', { direction: 'citing' })]), all)
    const byKey = new Map(nodes.map((node) => [node.key, node]))
    assert.equal(byKey.get('R')?.role, 'reference')
    assert.equal(byKey.get('C')?.role, 'citing')
    assert.equal(byKey.get('R')?.cluster, undefined)
    assert.equal(byKey.get('R')?.author, 'Turing')
  })

  it('draws a work the library lacks hollow, and one it holds with its item and confidence', () => {
    const net = network([
      work('GAP'),
      work('HELD', { match: { itemID: 9, confidence: 'exact', via: 'doi' } }),
      work('MAYBE', { match: { itemID: 10, confidence: 'probable', via: 'title' } }),
    ])
    const byKey = new Map(networkToGraph(net, all).nodes.map((node) => [node.key, node]))
    assert.equal(byKey.get('GAP')?.hollow, true)
    assert.equal(byKey.get('GAP')?.itemID, null)
    assert.equal(byKey.get('HELD')?.hollow, undefined)
    assert.equal(byKey.get('HELD')?.itemID, 9)
    assert.equal(byKey.get('HELD')?.match, 'exact')
    assert.equal(byKey.get('MAYBE')?.itemID, 10)
    assert.equal(byKey.get('MAYBE')?.match, 'probable')
  })

  it('takes gaps, held works and citing works out on request, and never the seeds', () => {
    const net = network([
      work('GAP'),
      work('HELD', { match: { itemID: 9, confidence: 'exact', via: 'doi' } }),
      work('C', { direction: 'citing' }),
    ])
    const keys = (opts: Partial<NetworkGraphOptions>) =>
      networkToGraph(net, { ...all, ...opts })
        .nodes.map((node) => node.key)
        .sort()
    assert.deepEqual(keys({ showGaps: false }), ['HELD', 'S1', 'S2', 'S3'])
    assert.deepEqual(keys({ showHeld: false }), ['C', 'GAP', 'S1', 'S2', 'S3'])
    assert.deepEqual(keys({ showCiting: false }), ['GAP', 'HELD', 'S1', 'S2', 'S3'])
    assert.deepEqual(keys({ showGaps: false, showHeld: false, showCiting: false }), ['S1', 'S2', 'S3'])
  })

  it('hides a cluster’s seeds, and the works only they lean on', () => {
    const net = network([work('ONLY_A', { seeds: ['S1', 'S2'] }), work('SHARED', { seeds: ['S2', 'S3'] })])
    const keys = (hidden: (number | null)[]) =>
      networkToGraph(net, { ...all, hiddenClusters: new Set(hidden) })
        .nodes.map((node) => node.key)
        .sort()
    assert.deepEqual(keys([0]), ['S3', 'SHARED'])
    assert.deepEqual(keys([null]), ['ONLY_A', 'S1', 'S2', 'SHARED'])
    assert.deepEqual(keys([0, null]), [])
  })

  it('caps the gaps by score across both directions', () => {
    const works = [
      work('LOW', { seeds: ['S1', 'S2'], citedByCount: 100000 }),
      work('HIGH', { seeds: ['S1', 'S2', 'S3'], citedByCount: 0 }),
      work('MID', { direction: 'citing', seeds: ['S1', 'S2', 'S3'], citedByCount: 50 }),
    ]
    const { nodes } = networkToGraph(network(works), { ...all, gapLimit: 2 })
    assert.deepEqual(
      nodes
        .filter((node) => node.role !== 'seed')
        .map((node) => node.key)
        .sort(),
      ['HIGH', 'MID'],
    )
  })

  it('caps the citing works first, by seed count, held and gaps alike', () => {
    const works = [
      work('C2', { direction: 'citing', seeds: ['S1', 'S2'] }),
      work('C3', {
        direction: 'citing',
        seeds: ['S1', 'S2', 'S3'],
        match: { itemID: 5, confidence: 'exact', via: 'doi' },
      }),
      work('R', { seeds: ['S1', 'S2'] }),
    ]
    const keys = networkToGraph(network(works), { ...all, citingLimit: 1 })
      .nodes.filter((node) => node.role !== 'seed')
      .map((node) => node.key)
      .sort()
    assert.deepEqual(keys, ['C3', 'R'])
  })

  it('uses the plan’s limits by default', () => {
    assert.deepEqual(DRAW_LIMITS, { gaps: 150, citing: 100, links: 2000 })
    const many = Array.from({ length: 200 }, (_, index) => work(`G${String(index).padStart(3, '0')}`))
    const { nodes } = networkToGraph(network(many), all)
    assert.equal(nodes.filter((node) => node.hollow).length, 150)
  })

  it('draws only the citations both of whose ends are drawn', () => {
    const net = network([work('R'), work('C', { direction: 'citing' })], {
      citations: [
        { from: 'S1', to: 'R' },
        { from: 'C', to: 'S2' },
        { from: 'S1', to: 'S2' },
        { from: 'S1', to: 'GONE' },
      ],
    })
    assert.deepEqual(networkToGraph(net, all).links, [
      { from: 'S1', to: 'R' },
      { from: 'C', to: 'S2' },
      { from: 'S1', to: 'S2' },
    ])
    assert.deepEqual(networkToGraph(net, { ...all, showCiting: false }).links, [
      { from: 'S1', to: 'R' },
      { from: 'S1', to: 'S2' },
    ])
  })

  it('keeps the most important links when there are too many: seed to seed, then by seed count', () => {
    const net = network([work('R2', { seeds: ['S1', 'S2'] }), work('R3', { seeds: ['S1', 'S2', 'S3'] })], {
      citations: [
        { from: 'S1', to: 'R2' },
        { from: 'S1', to: 'R3' },
        { from: 'S2', to: 'S3' },
      ],
    })
    assert.deepEqual(networkToGraph(net, { ...all, linkLimit: 2 }).links, [
      { from: 'S1', to: 'R3' },
      { from: 'S2', to: 'S3' },
    ])
  })

  it('does not draw a seed twice when the network also lists it as a work', () => {
    const { nodes } = networkToGraph(network([work('S1')]), all)
    assert.equal(nodes.filter((node) => node.key === 'S1').length, 1)
  })
})

describe('the legend’s clusters', () => {
  it('counts the seeds of each cluster and adds the unclustered at the end', () => {
    assert.deepEqual(clusterEntries(network([])), [
      { id: 0, label: 'Topic A', count: 2 },
      { id: 1, label: 'Topic B', count: 0 },
      { id: null, label: '', count: 1 },
    ])
  })

  it('leaves the unclustered entry out when every seed has a cluster', () => {
    const net = network([], { clusterOf: { S1: 0, S2: 0, S3: 1 } })
    assert.equal(
      clusterEntries(net).some((entry) => entry.id === null),
      false,
    )
  })
})

describe('routing and scope', () => {
  it('analyses a collection and a library as networks, and draws a selection or a work as before', () => {
    assert.equal(routeFor('collection'), 'network')
    assert.equal(routeFor('library'), 'network')
    assert.equal(routeFor('items'), 'single')
    assert.equal(routeFor('work'), 'single')
  })

  it('scopes a library seed to the library, so it never ends in an empty graph for want of an item', () => {
    assert.deepEqual(networkScopeFor({ kind: 'library', libraryID: 3, name: 'Group' }, null), {
      kind: 'library',
      libraryID: 3,
      name: 'Group',
    })
  })

  it('scopes a collection seed to its library, or to nothing when it is gone', () => {
    const seedArg = { kind: 'collection' as const, collectionID: 7, name: 'Mine' }
    assert.deepEqual(networkScopeFor(seedArg, 1), { kind: 'collection', collectionID: 7, libraryID: 1, name: 'Mine' })
    assert.equal(networkScopeFor(seedArg, null), null)
  })

  it('imports into the analysed collection, or the library root', () => {
    assert.deepEqual(importTargetFor({ kind: 'collection', collectionID: 7, libraryID: 1, name: 'x' }), {
      libraryID: 1,
      collectionID: 7,
    })
    assert.deepEqual(importTargetFor({ kind: 'library', libraryID: 2, name: 'x' }), {
      libraryID: 2,
      collectionID: null,
    })
  })
})

describe('small helpers', () => {
  it('finds the middle of the seeds', () => {
    assert.deepEqual(
      centroid([
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ]),
      { x: 5, y: 10 },
    )
    assert.equal(centroid([]), null)
  })

  it('takes the surname from either order of a display name', () => {
    assert.equal(surnameOf('Grace Hopper'), 'Hopper')
    assert.equal(surnameOf('Turing, Alan'), 'Turing')
    assert.equal(surnameOf(''), null)
    assert.equal(surnameOf(undefined), null)
  })
})

describe('the cluster selection', () => {
  const all = [0, 1, 2, null]

  it('shows everything with nothing picked', () => {
    assert.deepEqual([...hiddenBySelection(all, new Set())], [])
    assert.ok(clusterShown(new Set(), 1))
  })

  it('shows only what is picked, adding step by step', () => {
    let picked = toggleClusterSelection(new Set(), 1)
    assert.deepEqual([...hiddenBySelection(all, picked)].sort(), [0, 2, null].sort())
    picked = toggleClusterSelection(picked, null)
    assert.deepEqual([...hiddenBySelection(all, picked)].sort(), [0, 2].sort())
    assert.ok(clusterShown(picked, null) && !clusterShown(picked, 0))
  })

  it('takes a picked cluster out again, and shows all once the last one goes', () => {
    const picked = toggleClusterSelection(toggleClusterSelection(new Set(), 1), 1)
    assert.equal(picked.size, 0)
    assert.deepEqual([...hiddenBySelection(all, picked)], [])
  })
})
