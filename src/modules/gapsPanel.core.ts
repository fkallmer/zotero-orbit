/**
 * What the gaps list shows, decided without a DOM.
 *
 * The network hands over its gaps in one array, both directions mixed; the
 * list shows them in two sections, each in rank order, and names the seeds
 * behind each gap by title. See gapsPanel.ts for the rendering.
 */

import { surnameOf } from './collectionGraph.core'

import type { CollectionNetwork, Gap, OpenAlexId, SeedWork } from './collectionTypes'

export interface GapSections {
  /** Works the seeds cite: "Cited by your items". */
  reference: Gap[]
  /** Works that cite the seeds: "Citing your items". */
  citing: Gap[]
}

function byRank(a: Gap, b: Gap): number {
  return a.rank - b.rank || b.score - a.score
}

/** What the list can be ordered by. `score` is the rank, and the default. */
export type GapSort = 'score' | 'year' | 'citations' | 'references'

export const GAP_SORTS: readonly GapSort[] = ['score', 'year', 'citations', 'references']

const SORT_VALUE: Record<Exclude<GapSort, 'score'>, (gap: Gap) => number | null> = {
  year: (gap) => gap.year,
  citations: (gap) => gap.citedByCount,
  references: (gap) => gap.referenceCount,
}

/**
 * The gaps in the chosen order. Every order but `score` runs highest first --
 * newest, most cited, longest reference list -- with unknown values last and
 * ties kept in rank order, so the rank numbers stay what they were.
 */
export function sortGaps(gaps: readonly Gap[], sort: GapSort = 'score'): Gap[] {
  if (sort === 'score') return [...gaps].sort(byRank)
  const value = SORT_VALUE[sort]
  return [...gaps].sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    if (va === null || vb === null) return va === vb ? byRank(a, b) : va === null ? 1 : -1
    return vb - va || byRank(a, b)
  })
}

export function gapSections(gaps: readonly Gap[], sort: GapSort = 'score'): GapSections {
  return {
    reference: sortGaps(
      gaps.filter((gap) => gap.direction === 'reference'),
      sort,
    ),
    citing: sortGaps(
      gaps.filter((gap) => gap.direction === 'citing'),
      sort,
    ),
  }
}

/** The seeds behind a gap, in the order the gap lists them. Ids the network does not hold are skipped. */
export function seedsOfGap(gap: Pick<Gap, 'seeds'>, net: Pick<CollectionNetwork, 'seeds'>): SeedWork[] {
  const byId = new Map(net.seeds.map((seed) => [seed.openAlexId, seed]))
  return gap.seeds.flatMap((id) => {
    const seed = byId.get(id)
    return seed ? [seed] : []
  })
}

/** Two decimals; the score is a ratio, and more digits would suggest a precision it does not have. */
export function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : '–'
}

/**
 * Who wrote a gap, the way a reference list would say it: one surname, two
 * joined, or the first and "et al." -- with the surname taken exactly as the
 * graph takes it for the label on the mark, so list and graph agree.
 */
export type AuthorLine =
  | { kind: 'none' }
  | { kind: 'one'; first: string }
  | { kind: 'two'; first: string; second: string }
  | { kind: 'many'; first: string }

export function authorLine(authors: readonly string[]): AuthorLine {
  const names = authors.map((name) => surnameOf(name)).filter((name): name is string => name !== null)
  if (names.length === 0) return { kind: 'none' }
  if (names.length === 1) return { kind: 'one', first: names[0] }
  if (names.length === 2) return { kind: 'two', first: names[0], second: names[1] }
  return { kind: 'many', first: names[0] }
}

/**
 * A work the analysed items cite, held or not: the "most referenced" view.
 *
 * The gaps list answers "what am I missing"; this answers "what does my
 * collection rest on", so it keeps what the library already holds -- the
 * shared references it has, and the user's own items that other items cite.
 */
export interface ReferencedWork {
  openAlexId: OpenAlexId
  title: string
  authors: string[]
  year: number | null
  citedByCount: number | null
  referenceCount: number | null
  doi: string | null
  /** The analysed items that cite it. */
  seeds: OpenAlexId[]
  /** 'seed': one of the analysed items. Otherwise how the library holds it, or null. */
  held: 'seed' | 'exact' | 'probable' | null
  itemID: number | null
  /** 1-based, by how many analysed items cite it. */
  rank: number
}

/**
 * Every work at least two analysed items cite, most cited by them first:
 * the shared references (held or missing) and the analysed items themselves
 * where other analysed items cite them. Ties go to the more cited work
 * overall, then the newer one.
 */
export function mostReferenced(
  net: Pick<CollectionNetwork, 'seeds' | 'works' | 'citations'>,
  minSeeds = 2,
): ReferencedWork[] {
  const seedIds = new Set(net.seeds.map((seed) => seed.openAlexId))
  const entries: Omit<ReferencedWork, 'rank'>[] = []

  for (const work of net.works) {
    if (work.direction !== 'reference' || work.seeds.length < minSeeds) continue
    entries.push({
      openAlexId: work.openAlexId,
      title: work.title,
      authors: work.authors,
      year: work.year,
      citedByCount: work.citedByCount,
      referenceCount: work.referenceCount,
      doi: work.doi,
      seeds: work.seeds,
      held: work.match?.confidence ?? null,
      itemID: work.match?.itemID ?? null,
    })
  }

  // The analysed items cited by other analysed items, from the citation edges.
  const citers = new Map<OpenAlexId, Set<OpenAlexId>>()
  for (const edge of net.citations) {
    if (!seedIds.has(edge.from) || !seedIds.has(edge.to) || edge.from === edge.to) continue
    const set = citers.get(edge.to) ?? new Set<OpenAlexId>()
    set.add(edge.from)
    citers.set(edge.to, set)
  }
  for (const seed of net.seeds) {
    const by = citers.get(seed.openAlexId)
    if (!by || by.size < minSeeds) continue
    entries.push({
      openAlexId: seed.openAlexId,
      title: seed.title,
      authors: seed.authors,
      year: seed.year,
      citedByCount: seed.citedByCount,
      referenceCount: seed.referenceCount,
      doi: seed.doi,
      seeds: [...by].sort(),
      held: 'seed',
      itemID: seed.itemID,
    })
  }

  return entries
    .sort(
      (a, b) =>
        b.seeds.length - a.seeds.length ||
        (b.citedByCount ?? -1) - (a.citedByCount ?? -1) ||
        (b.year ?? -1) - (a.year ?? -1) ||
        (a.openAlexId < b.openAlexId ? -1 : a.openAlexId > b.openAlexId ? 1 : 0),
    )
    .map((entry, index) => ({ ...entry, rank: index + 1 }))
}
