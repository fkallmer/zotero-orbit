/**
 * Topic clusters over the seeds of a collection network.
 *
 * Seeds that share references are bibliographically coupled; Leiden groups the
 * coupling network into clusters, the way VOSviewer does (CPM, association
 * strength normalisation, resolution 1). Each cluster is then named after the
 * OpenAlex primary topic most of its members carry.
 *
 * Free of Zotero so `node --test` can check it. The algorithm is
 * `networkanalysis-ts` (MIT), the TypeScript port of CWTS's networkanalysis.
 */

import NetworkClustering from 'networkanalysis-ts/run/networkClustering.js'

import type { Cluster, CouplingEdge, OpenAlexId } from './collectionTypes.ts'

/** Clusters smaller than this are no cluster at all; their members get `null`. */
export const MIN_CLUSTER_SIZE = 2

interface LeidenNode {
  id: number
  cluster?: number
}

/**
 * Run the clustering with its progress chatter silenced.
 *
 * `NetworkClustering.run()` writes some twenty lines to `console.log` per call,
 * which in Zotero lands in the browser console on every analysis. The run is
 * synchronous, so swapping the method out for its duration cannot swallow
 * anyone else's output.
 */
function quietly(run: () => void): void {
  // A plugin scope is not guaranteed a `console` (zotero-plugin-toolkit checks
  // for one too), and `run()` calls it unguarded: lend it a silent one.
  if (typeof console === 'undefined') {
    Reflect.set(globalThis, 'console', { log: () => undefined })
    try {
      run()
    } finally {
      Reflect.deleteProperty(globalThis, 'console')
    }
    return
  }
  // Held and put back as it is, never called, so it needs no binding.
  const original: unknown = Reflect.get(console, 'log')
  Reflect.set(console, 'log', () => undefined)
  try {
    run()
  } finally {
    Reflect.set(console, 'log', original)
  }
}

/**
 * Leiden clusters of the coupling network, by seed.
 *
 * Every seed gets an entry. A seed without a coupling edge, or left in a
 * cluster smaller than two, gets `null`. Cluster ids are 0-based and ordered by
 * size, largest first; equal sizes go by their smallest member id. The input
 * is sorted before it reaches the algorithm and the random seed is fixed, so
 * the same network always yields the same clusters.
 */
export function clusterByCoupling(
  seedIds: readonly OpenAlexId[],
  coupling: readonly CouplingEdge[],
): Map<OpenAlexId, number | null> {
  const result = new Map<OpenAlexId, number | null>()
  for (const id of seedIds) result.set(id, null)

  // Only edges between two distinct, known seeds with a positive weight.
  const edges = coupling
    .filter((edge) => edge.a !== edge.b && edge.shared > 0 && result.has(edge.a) && result.has(edge.b))
    .map((edge) => (edge.a < edge.b ? edge : { a: edge.b, b: edge.a, shared: edge.shared }))
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0))
  if (edges.length === 0) return result

  // Isolated seeds stay out of the network: the algorithm would only make
  // singletons of them, or fold them into a neighbour they do not have.
  const connected = [...new Set(edges.flatMap((edge) => [edge.a, edge.b]))].sort()
  const indexOf = new Map(connected.map((id, index) => [id, index]))
  const nodes: LeidenNode[] = connected.map((_, index) => ({ id: index }))
  const links = edges.map((edge) => ({
    node1: nodes[indexOf.get(edge.a)!],
    node2: nodes[indexOf.get(edge.b)!],
    weight: edge.shared,
  }))

  quietly(() => {
    new NetworkClustering()
      .data(nodes, links)
      .qualityFunction('CPM')
      .normalization('AssociationStrength')
      .resolution(1)
      .minClusterSize(MIN_CLUSTER_SIZE)
      .algorithm('Leiden')
      .randomStarts(10)
      .iterations(10)
      .randomness(0.01)
      .seed(0)
      .run()
  })

  // The library's own ids are ordered by size, but its small-cluster pass runs
  // after that ordering; renumber here rather than trust them.
  const byRaw = new Map<number, OpenAlexId[]>()
  nodes.forEach((node, index) => {
    if (node.cluster === undefined) return
    const members = byRaw.get(node.cluster)
    if (members) members.push(connected[index])
    else byRaw.set(node.cluster, [connected[index]])
  })
  const groups = [...byRaw.values()]
    .filter((members) => members.length >= MIN_CLUSTER_SIZE)
    // `connected` is sorted, so members[0] is each group's smallest id.
    .sort((x, y) => y.length - x.length || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
  groups.forEach((members, clusterId) => {
    for (const id of members) result.set(id, clusterId)
  })
  return result
}

/**
 * Clusters with names.
 *
 * The label is the primary topic most members share; equal counts go to the
 * alphabetically first name. `topicShare` is that topic's share of all
 * members, those without a known topic included. A cluster none of whose
 * members has a topic is named by `fallback`.
 */
export function labelClusters(
  assignment: ReadonlyMap<OpenAlexId, number | null>,
  topicOf: (id: OpenAlexId) => { id: string; name: string } | null,
  fallback: (clusterId: number) => string,
): Cluster[] {
  const members = new Map<number, OpenAlexId[]>()
  for (const [id, clusterId] of assignment) {
    if (clusterId === null) continue
    const list = members.get(clusterId)
    if (list) list.push(id)
    else members.set(clusterId, [id])
  }

  // Largest first, so when two clusters share their most common topic the
  // larger one keeps it. Two legend entries with one name tell the reader
  // nothing about how they differ; the smaller takes its next most common
  // topic instead, which still says what it is about, and only when it has
  // none left does it get a number.
  const used = new Set<string>()
  return [...members.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([id, ids]) => {
      const sorted = [...ids].sort()
      const counts = new Map<string, number>()
      for (const member of sorted) {
        const name = topicOf(member)?.name
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      const ranked = [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      if (ranked.length === 0) return { id, label: fallback(id), topicShare: 0, members: sorted }
      const fresh = ranked.find(([name]) => !used.has(name))
      let label: string
      let count: number
      if (fresh) {
        ;[label, count] = fresh
      } else {
        // Every topic it has is already a name: number the most common one.
        const [name, top] = ranked[0]
        let n = 2
        while (used.has(`${name} (${n})`)) n++
        label = `${name} (${n})`
        count = top
      }
      used.add(label)
      return { id, label, topicShare: count / sorted.length, members: sorted }
    })
}
