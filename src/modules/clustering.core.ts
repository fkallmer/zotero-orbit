/**
 * Topic clusters over the seeds of a collection network.
 *
 * Seeds that share references are bibliographically coupled; Leiden groups the
 * coupling network into clusters, the way VOSviewer does (CPM, association
 * strength normalisation, resolution 1). Each cluster is then named after the
 * OpenAlex topic, subfield or field most of its members carry.
 *
 * Free of Zotero so `node --test` can check it. The algorithm is
 * `networkanalysis-ts` (MIT), the TypeScript port of CWTS's networkanalysis.
 */

import NetworkClustering from 'networkanalysis-ts/run/networkClustering.js'

import type { Cluster, CouplingEdge, OpenAlexId, PrimaryTopic } from './collectionTypes.ts'

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
 * A cluster is named by a level of the topic hierarchy that a majority of its
 * members share. Below that it is only a plurality, and the name says less.
 */
export const MAJORITY_SHARE = 0.5

/** Longest label a legend entry gets, ellipsis and any " (n)" included. */
export const MAX_LABEL_LENGTH = 45

/** Words a shortened label should not end on. */
const DANGLING = /\s+(?:and|or|of|in|for|the|with|to|on|by|at|from|&)$/i

/**
 * `name` cut to `max` characters at a word boundary, with an ellipsis.
 *
 * A trailing comma or connector would read as a half sentence ("Diabetes,
 * Cardiovascular Risks, and…"), so those go too. A name with no space early
 * enough is cut mid-word rather than reduced to almost nothing.
 */
function shorten(name: string, max: number): string {
  if (name.length <= max) return name
  const room = name.slice(0, max - 1)
  const space = name[max - 1] === ' ' ? room.length : room.lastIndexOf(' ')
  let head = space >= max / 2 ? room.slice(0, space) : room
  for (let prev = ''; prev !== head;) {
    prev = head
    head = head.replace(/[\s,;:\-\u2013\u2014]+$/, '').replace(DANGLING, '')
  }
  return `${head || room.trimEnd()}\u2026`
}

type Level = 'topic' | 'subfield'

/**
 * Most specific first: of two equally good names, the narrower says more.
 * The field is left out on purpose: "Medicine" or "Computer Science" is true
 * of a cluster and tells the reader nothing about it.
 */
const LEVELS: readonly Level[] = ['topic', 'subfield']

interface Candidate {
  /** As OpenAlex gives it; `label` is it shortened. */
  name: string
  label: string
  count: number
  share: number
  level: number
}

function nameAt(topic: PrimaryTopic | null, level: Level): string | undefined {
  if (!topic) return undefined
  return level === 'topic' ? topic.name : topic[level]?.name
}

/**
 * The names a cluster could carry, best first.
 *
 * First every name a majority shares, topic before subfield.
 * Then the rest by how many members carry them, so a scattered cluster, or one
 * that lost its best name, takes the name true of most of it -- often a
 * subfield -- rather than a topic one member in ten happens to carry. Equal counts go
 * to the narrower level, then the name. With topics alone (an old cache) this
 * is today's order: the most common topic, then the next.
 */
function candidatesOf(members: readonly OpenAlexId[], topicOf: (id: OpenAlexId) => PrimaryTopic | null): Candidate[] {
  const all: Candidate[] = []
  LEVELS.forEach((level, rank) => {
    const counts = new Map<string, number>()
    for (const member of members) {
      const name = nameAt(topicOf(member), level)
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    for (const [name, count] of counts) {
      all.push({ name, label: shorten(name, MAX_LABEL_LENGTH), count, share: count / members.length, level: rank })
    }
  })
  const byName = (x: Candidate, y: Candidate) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0)
  const majority = all
    .filter((c) => c.share >= MAJORITY_SHARE)
    .sort((x, y) => x.level - y.level || y.count - x.count || byName(x, y))
  const rest = all
    .filter((c) => c.share < MAJORITY_SHARE)
    .sort((x, y) => y.count - x.count || x.level - y.level || byName(x, y))
  // Two raw names can shorten to one label; the first, better one stands.
  const seen = new Set<string>()
  return [...majority, ...rest].filter((c) => !seen.has(c.label) && seen.add(c.label))
}

/**
 * Clusters with names.
 *
 * Each cluster is named by the most specific level of the OpenAlex hierarchy
 * -- topic, then subfield, never the broad field -- that a majority of its members share; when none
 * does, by the name most members carry. `topicShare` is the share of all members,
 * those without a topic included, that carry what the label names. A cluster
 * none of whose members has a topic is named by `fallback`.
 *
 * Names are unique. When clusters want the same name, the one it is truest of
 * (highest share, then most members, then lowest id) keeps it, and the others
 * move down their own list; only a cluster with nothing left numbers its first
 * name, "Name (2)". Labels are at most MAX_LABEL_LENGTH characters.
 *
 * Seeds cached without subfield and field are named from their topics alone.
 */
export function labelClusters(
  assignment: ReadonlyMap<OpenAlexId, number | null>,
  topicOf: (id: OpenAlexId) => PrimaryTopic | null,
  fallback: (clusterId: number) => string,
): Cluster[] {
  const members = new Map<number, OpenAlexId[]>()
  for (const [id, clusterId] of assignment) {
    if (clusterId === null) continue
    const list = members.get(clusterId)
    if (list) list.push(id)
    else members.set(clusterId, [id])
  }

  const clusters = [...members.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([id, ids]) => {
      const sorted = [...ids].sort()
      return { id, members: sorted, candidates: candidatesOf(sorted, topicOf), next: 0 }
    })

  const named = new Map<number, { label: string; topicShare: number }>()
  const used = new Set<string>()
  for (const cluster of clusters) {
    if (cluster.candidates.length > 0) continue
    const label = fallback(cluster.id)
    named.set(cluster.id, { label, topicShare: 0 })
    used.add(label)
  }

  // Rounds: every unnamed cluster asks for its next name, and of those asking
  // for one name the cluster it is truest of gets it. A name once given stays.
  let pending = clusters.filter((cluster) => !named.has(cluster.id))
  while (pending.length > 0) {
    const asking = new Map<string, { cluster: (typeof clusters)[number]; candidate: Candidate }[]>()
    for (const cluster of pending) {
      const candidate = cluster.candidates[cluster.next]
      if (!candidate) {
        // Every name it has is taken: number its best one.
        const [best] = cluster.candidates
        let n = 2
        let label: string
        do {
          const suffix = ` (${n++})`
          label = `${shorten(best.name, MAX_LABEL_LENGTH - suffix.length)}${suffix}`
        } while (used.has(label))
        named.set(cluster.id, { label, topicShare: best.share })
        used.add(label)
        continue
      }
      const list = asking.get(candidate.label)
      if (list) list.push({ cluster, candidate })
      else asking.set(candidate.label, [{ cluster, candidate }])
    }
    for (const [label, askers] of asking) {
      if (used.has(label)) continue
      const [winner] = askers.sort(
        (x, y) =>
          y.candidate.share - x.candidate.share || y.candidate.count - x.candidate.count || x.cluster.id - y.cluster.id,
      )
      named.set(winner.cluster.id, { label, topicShare: winner.candidate.share })
      used.add(label)
    }
    for (const cluster of pending) cluster.next++
    pending = pending.filter((cluster) => !named.has(cluster.id))
  }

  return clusters.map(({ id, members: sorted }) => ({ id, ...named.get(id)!, members: sorted }))
}
