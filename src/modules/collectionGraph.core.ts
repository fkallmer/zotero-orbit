/**
 * A collection network, as marks and lines for the graph tab.
 *
 * The renderer was built for one paper and the works around it; a network is
 * many papers and the works they share. Nothing about the plot needs to know
 * that -- it takes nodes and links -- so this translates, and decides what is
 * drawn: which works, how many, and which of the citations between them.
 *
 * Every key is an OpenAlex id, so a link from `net.citations` names its two
 * marks directly. Pure; the tab calls it again on every toggle.
 */

import type { CollectionNetwork, Gap, NetworkScope, NetworkWork, OpenAlexId } from './collectionTypes'
import type { GraphLink, GraphNode } from './graphModel.core'

/**
 * How much of a network the plot takes, at most.
 *
 * The gaps list shows every gap; the plot shows the ones worth a mark. Past a
 * few hundred marks the axes stop separating anything and the labels give up.
 */
export const DRAW_LIMITS = { gaps: 150, citing: 100, links: 2000 } as const

export interface NetworkGraphOptions {
  /** Works the library lacks, drawn hollow. */
  showGaps: boolean
  /** Works citing the seeds, held or not. */
  showCiting: boolean
  /** Works the library holds, exactly or probably, that are not seeds. */
  showHeld: boolean
  gapLimit: number
  citingLimit: number
  linkLimit: number
  /**
   * Cluster ids taken out by the legend; `null` is the unclustered seeds. A
   * work drawn only because of hidden seeds goes with them.
   */
  hiddenClusters?: ReadonlySet<number | null>
}

export const DEFAULT_NETWORK_OPTIONS: NetworkGraphOptions = {
  showGaps: true,
  showCiting: true,
  showHeld: true,
  gapLimit: DRAW_LIMITS.gaps,
  citingLimit: DRAW_LIMITS.citing,
  linkLimit: DRAW_LIMITS.links,
}

/**
 * The surname from an OpenAlex display name, for a label beside a mark.
 *
 * "Family, Given" when there is a comma, the last word otherwise -- the same
 * guess the single-paper graph makes, and wrong for the same few conventions.
 */
export function surnameOf(name: string | undefined | null): string | null {
  const trimmed = (name ?? '').trim()
  if (trimmed === '') return null
  if (trimmed.includes(',')) return trimmed.split(',')[0].trim() || null
  const parts = trimmed.split(/\s+/)
  return parts[parts.length - 1] || null
}

/** The cluster of a seed: `null` when it is in none, or the network never said. */
export function clusterOfSeed(net: Pick<CollectionNetwork, 'clusterOf'>, id: OpenAlexId): number | null {
  const cluster = net.clusterOf[id]
  return typeof cluster === 'number' ? cluster : null
}

/** Most seeds first, then the more cited, then by id: the order a cap keeps. */
function byWeight(a: NetworkWork, b: NetworkWork): number {
  return (
    b.seeds.length - a.seeds.length ||
    (b.citedByCount ?? -1) - (a.citedByCount ?? -1) ||
    (a.openAlexId < b.openAlexId ? -1 : a.openAlexId > b.openAlexId ? 1 : 0)
  )
}

/**
 * Translate a network into the renderer's nodes and links.
 *
 * - Seeds are always drawn, unless their cluster is hidden. They are library
 *   items by construction, so each carries its `itemID` and an exact match.
 * - A work the library holds keeps its item and how sure the match is, so a
 *   title match draws the dashed collar. Shown with `showHeld`.
 * - A work it lacks is drawn hollow. Shown with `showGaps`.
 * - Citing works, held or not, are shown with `showCiting`.
 *
 * The caps apply in that order: first the citing works are cut to
 * `citingLimit` (most seeds, then most cited), then the gaps that remain, in
 * either direction, to `gapLimit` by score -- `Gap.rank` counts within a
 * direction, so it cannot order the two together. Held works are not capped:
 * a work needs two seeds to be in the network at all, and those the reader
 * already has are the context for the rest.
 *
 * Links are the citations both of whose ends are drawn, at most `linkLimit`:
 * those between two seeds first, then by the seed count of the other end.
 */
export function networkToGraph(
  net: CollectionNetwork,
  opts: NetworkGraphOptions,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const hidden = opts.hiddenClusters ?? new Set<number | null>()
  const visibleSeeds = new Set<OpenAlexId>()
  const nodes: GraphNode[] = []

  for (const seed of net.seeds) {
    const cluster = clusterOfSeed(net, seed.openAlexId)
    if (hidden.has(cluster)) continue
    visibleSeeds.add(seed.openAlexId)
    nodes.push({
      key: seed.openAlexId,
      title: seed.title,
      year: seed.year,
      citedByCount: seed.citedByCount,
      role: 'seed',
      doi: seed.doi,
      author: surnameOf(seed.authors[0]),
      referenceCount: seed.referenceCount,
      itemID: seed.itemID,
      cluster,
      match: 'exact',
    })
  }

  const scoreOf = new Map<OpenAlexId, Gap>(net.gaps.map((gap) => [gap.openAlexId, gap]))
  const seedIds = new Set(net.seeds.map((seed) => seed.openAlexId))

  let works = net.works.filter((work) => {
    if (seedIds.has(work.openAlexId)) return false
    // Hidden clusters take the works only they lean on with them; otherwise a
    // filtered view keeps a scatter of marks pointing at nothing on screen.
    if (hidden.size > 0 && !work.seeds.some((id) => visibleSeeds.has(id))) return false
    if (work.direction === 'citing' && !opts.showCiting) return false
    return work.match === null ? opts.showGaps : opts.showHeld
  })

  const citing = works.filter((work) => work.direction === 'citing')
  if (citing.length > opts.citingLimit) {
    const kept = new Set(
      [...citing]
        .sort(byWeight)
        .slice(0, Math.max(0, opts.citingLimit))
        .map((work) => work.openAlexId),
    )
    works = works.filter((work) => work.direction !== 'citing' || kept.has(work.openAlexId))
  }

  const gaps = works.filter((work) => work.match === null)
  if (gaps.length > opts.gapLimit) {
    const kept = new Set(
      [...gaps]
        .sort(
          (a, b) => (scoreOf.get(b.openAlexId)?.score ?? 0) - (scoreOf.get(a.openAlexId)?.score ?? 0) || byWeight(a, b),
        )
        .slice(0, Math.max(0, opts.gapLimit))
        .map((work) => work.openAlexId),
    )
    works = works.filter((work) => work.match !== null || kept.has(work.openAlexId))
  }

  const weight = new Map<OpenAlexId, number>()
  for (const work of works) {
    weight.set(work.openAlexId, work.seeds.length)
    nodes.push({
      key: work.openAlexId,
      title: work.title,
      year: work.year,
      citedByCount: work.citedByCount,
      role: work.direction === 'citing' ? 'citing' : 'reference',
      doi: work.doi,
      author: surnameOf(work.authors[0]),
      referenceCount: work.referenceCount,
      itemID: work.match?.itemID ?? null,
      match: work.match?.confidence ?? null,
      ...(work.match === null ? { hollow: true } : {}),
      // Only the "cited by your items" ranks: citing works have a list of
      // their own, and two marks numbered 1 would point at two rows.
      ...(work.match === null && work.direction === 'reference' && scoreOf.has(work.openAlexId)
        ? { gapRank: scoreOf.get(work.openAlexId)?.rank ?? null }
        : {}),
    })
  }

  const drawn = new Set(nodes.map((node) => node.key))
  const importance = (link: GraphLink): number => {
    const from = visibleSeeds.has(link.from) ? Infinity : (weight.get(link.from) ?? 0)
    const to = visibleSeeds.has(link.to) ? Infinity : (weight.get(link.to) ?? 0)
    return Math.min(from, to)
  }
  const seen = new Set<string>()
  const candidates: GraphLink[] = []
  for (const edge of net.citations) {
    if (edge.from === edge.to || !drawn.has(edge.from) || !drawn.has(edge.to)) continue
    const id = `${edge.from}>${edge.to}`
    if (seen.has(id)) continue
    seen.add(id)
    candidates.push({ from: edge.from, to: edge.to })
  }
  // The kept links stay in the network's own order; equal importance is
  // decided by that order too.
  let links = candidates
  if (candidates.length > opts.linkLimit) {
    const kept = new Set(
      candidates
        .map((link, index) => ({ index, rank: importance(link) }))
        .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank > b.rank ? -1 : 1))
        .slice(0, Math.max(0, opts.linkLimit))
        .map((entry) => entry.index),
    )
    links = candidates.filter((_, index) => kept.has(index))
  }

  return { nodes, links }
}

/** One legend entry per cluster, plus the seeds in none. Counts are seeds. */
export function clusterEntries(
  net: Pick<CollectionNetwork, 'clusters' | 'clusterOf' | 'seeds'>,
): { id: number | null; label: string; count: number }[] {
  const counts = new Map<number | null, number>()
  for (const seed of net.seeds) {
    const cluster = clusterOfSeed(net, seed.openAlexId)
    counts.set(cluster, (counts.get(cluster) ?? 0) + 1)
  }
  const entries: { id: number | null; label: string; count: number }[] = net.clusters.map((cluster) => ({
    id: cluster.id,
    label: cluster.label,
    count: counts.get(cluster.id) ?? 0,
  }))
  const none = counts.get(null) ?? 0
  if (none > 0) entries.push({ id: null, label: '', count: none })
  return entries
}

/** The middle of the given points, or null when there are none. */
export function centroid(points: readonly { x: number; y: number }[]): { x: number; y: number } | null {
  if (points.length === 0) return null
  let x = 0
  let y = 0
  for (const point of points) {
    x += point.x
    y += point.y
  }
  return { x: x / points.length, y: y / points.length }
}

/** The graph tab's seed, as far as routing needs it. */
export type SeedKind = 'collection' | 'items' | 'library' | 'work'

/**
 * Which way a seed is drawn. A collection or a library is a set of papers and
 * is analysed as one; a selection or a single work is drawn from its own point
 * of view.
 */
export function routeFor(kind: SeedKind): 'network' | 'single' {
  return kind === 'collection' || kind === 'library' ? 'network' : 'single'
}

/**
 * The scope to analyse for a network seed.
 *
 * A collection seed carries no library id, so the caller looks the
 * collection up and passes its library -- or null when it is gone, which is
 * null here too.
 */
export function networkScopeFor(
  seed:
    { kind: 'collection'; collectionID: number; name: string } | { kind: 'library'; libraryID: number; name: string },
  collectionLibraryID: number | null,
): NetworkScope | null {
  if (seed.kind === 'library') return { kind: 'library', libraryID: seed.libraryID, name: seed.name }
  if (collectionLibraryID === null) return null
  return { kind: 'collection', collectionID: seed.collectionID, libraryID: collectionLibraryID, name: seed.name }
}

/** Where an import from this network lands: the collection, or the library root. */
export function importTargetFor(scope: NetworkScope): { libraryID: number; collectionID: number | null } {
  return { libraryID: scope.libraryID, collectionID: scope.kind === 'collection' ? scope.collectionID : null }
}
