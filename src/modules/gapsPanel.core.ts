/**
 * What the gaps list shows, decided without a DOM.
 *
 * The network hands over its gaps in one array, both directions mixed; the
 * list shows them in two sections, each in rank order, and names the seeds
 * behind each gap by title. See gapsPanel.ts for the rendering.
 */

import type { CollectionNetwork, Gap, SeedWork } from './collectionTypes'

export interface GapSections {
  /** Works the seeds cite: "Cited by your items". */
  reference: Gap[]
  /** Works that cite the seeds: "Citing your items". */
  citing: Gap[]
}

function byRank(a: Gap, b: Gap): number {
  return a.rank - b.rank || b.score - a.score
}

export function gapSections(gaps: readonly Gap[]): GapSections {
  return {
    reference: gaps.filter((gap) => gap.direction === 'reference').sort(byRank),
    citing: gaps.filter((gap) => gap.direction === 'citing').sort(byRank),
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
