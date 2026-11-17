/**
 * Pure logic of the collection network: which items become seeds, which
 * works the seeds share, how they couple, which missing works matter most,
 * and what an analysis will cost.
 *
 * Free of Zotero so `node --test` can check it. The fetching and the library
 * lookups are in collectionNetwork.ts.
 */

import type {
  CitationEdge,
  CollectionNetwork,
  CouplingEdge,
  Gap,
  MatchableWork,
  MatchResult,
  NetworkWork,
  OpenAlexId,
  RequestEstimate,
  SeedPolicy,
  SeedWork,
} from './collectionTypes.ts'

/** A work enters the network once at least this many seeds are connected to it. */
export const MIN_SHARED = 2

/** Cursor pages fetched per group of a hundred seeds before the citing side is cut off. */
export const CITING_PAGE_CAP = 30

/** OpenAlex's batch size: OR-filter values per list request, and works per page. */
export const BATCH_SIZE = 100

/** OpenAlex charges list and filter requests at $0.10 per thousand; single GETs are free. */
export const USD_PER_LIST_REQUEST = 0.1 / 1000

/** The daily allowance without and with an API key. */
export const DAILY_BUDGET_USD = { withoutKey: 0.1, withKey: 1 } as const

/**
 * Assumed number of distinct works per seed that at least MIN_SHARED seeds
 * cite, for the estimate only.
 *
 * A seed lists about fifty references. In a coherent collection a quarter of
 * them are shared with another seed, and many of those with several, so the
 * distinct shared works come to roughly a dozen per seed: 300 seeds, about
 * 3600 works, 36 batches. The real count is only known once the seeds are in.
 */
export const SHARED_REFS_PER_SEED = 12

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// --- Seeds -----------------------------------------------------------------

/**
 * The items to analyse, in the order they should be analysed.
 *
 * Items with an identifier come first, because only they can be looked up;
 * within each group the most recently added first, then the higher item id.
 *
 * - `cap`: the first `limit`; `capped` when there were more.
 * - `warn`: every item, with `needsConfirmation` when there are more than
 *   `limit`. The caller asks, and on no calls again with `cap`.
 * - `all`: every item.
 */
export function chooseSeeds<T extends { itemID: number; hasIdentifier: boolean; dateAdded: string }>(
  items: readonly T[],
  limit: number,
  policy: SeedPolicy,
): { chosen: T[]; capped: boolean; needsConfirmation: boolean } {
  const ordered = [...items].sort(
    (a, b) =>
      Number(b.hasIdentifier) - Number(a.hasIdentifier) ||
      // Zotero's `dateAdded` is 'YYYY-MM-DD HH:MM:SS' in UTC: sortable as text.
      compareIds(b.dateAdded, a.dateAdded) ||
      b.itemID - a.itemID,
  )
  const over = ordered.length > limit
  if (policy === 'cap') return { chosen: ordered.slice(0, limit), capped: over, needsConfirmation: false }
  if (policy === 'warn') return { chosen: ordered, capped: false, needsConfirmation: over }
  return { chosen: ordered, capped: false, needsConfirmation: false }
}

// --- Structure ---------------------------------------------------------------

type SeedRefs = Pick<SeedWork, 'openAlexId' | 'referencedWorks'>

/** Reference id -> the seeds citing it, each seed once, both sorted. */
function citersByReference(seeds: readonly SeedRefs[]): Map<OpenAlexId, OpenAlexId[]> {
  const byRef = new Map<OpenAlexId, OpenAlexId[]>()
  const ordered = [...seeds].sort((a, b) => compareIds(a.openAlexId, b.openAlexId))
  for (const seed of ordered) {
    for (const ref of new Set(seed.referencedWorks)) {
      if (ref === seed.openAlexId) continue
      const citers = byRef.get(ref)
      if (citers) {
        // Seeds arrive sorted, so a duplicate seed would sit at the end.
        if (citers[citers.length - 1] !== seed.openAlexId) citers.push(seed.openAlexId)
      } else {
        byRef.set(ref, [seed.openAlexId])
      }
    }
  }
  return byRef
}

/**
 * Non-seed works cited by at least MIN_SHARED seeds, with the seeds citing
 * them. Ordered by citer count, most first, then by id.
 */
export function sharedReferences(seeds: readonly SeedRefs[]): Map<OpenAlexId, OpenAlexId[]> {
  const seedIds = new Set(seeds.map((seed) => seed.openAlexId))
  const shared = [...citersByReference(seeds)].filter(
    ([ref, citers]) => !seedIds.has(ref) && citers.length >= MIN_SHARED,
  )
  shared.sort((x, y) => y[1].length - x[1].length || compareIds(x[0], y[0]))
  return new Map(shared)
}

/**
 * Bibliographic coupling: every pair of seeds sharing at least one reference,
 * with how many they share. Ordered by `a`, then `b`.
 *
 * Built from the reference side -- each reference adds one to every pair of
 * its citers -- so the cost follows the shared references, not the square of
 * the seed count times their bibliographies.
 */
export function couplingEdges(seeds: readonly SeedRefs[]): CouplingEdge[] {
  const pairs = new Map<string, CouplingEdge>()
  for (const citers of citersByReference(seeds).values()) {
    if (citers.length < 2) continue
    for (let i = 0; i < citers.length; i++) {
      for (let j = i + 1; j < citers.length; j++) {
        // `citers` is sorted, so citers[i] < citers[j].
        const key = `${citers[i]} ${citers[j]}`
        const edge = pairs.get(key)
        if (edge) edge.shared++
        else pairs.set(key, { a: citers[i], b: citers[j], shared: 1 })
      }
    }
  }
  return [...pairs.values()].sort((x, y) => compareIds(x.a, y.a) || compareIds(x.b, y.b))
}

/**
 * Citing works that cite at least MIN_SHARED of the seeds, each once, with the
 * seeds they cite. Seeds themselves are left out: they are in the network
 * already. Ordered by cited-seed count, most first, then by id.
 *
 * Checked against every seed, not only the group a page was fetched for: a
 * work citing one seed in each of two groups shows up in both.
 */
export function citersOfSeveral<T extends { openAlexId: OpenAlexId; referencedWorks: readonly OpenAlexId[] }>(
  citers: readonly T[],
  seedIds: Iterable<OpenAlexId>,
): { work: T; seeds: OpenAlexId[] }[] {
  const seeds = new Set(seedIds)
  const seen = new Set<OpenAlexId>()
  const out: { work: T; seeds: OpenAlexId[] }[] = []
  for (const work of citers) {
    if (seeds.has(work.openAlexId) || seen.has(work.openAlexId)) continue
    seen.add(work.openAlexId)
    const cited = [...new Set(work.referencedWorks.filter((ref) => seeds.has(ref)))].sort()
    if (cited.length >= MIN_SHARED) out.push({ work, seeds: cited })
  }
  out.sort((x, y) => y.seeds.length - x.seeds.length || compareIds(x.work.openAlexId, y.work.openAlexId))
  return out
}

/**
 * Citation edges, citer -> cited, with both ends in the network: seed to seed,
 * seed to a shared reference, and citing work to seed. Each edge once, sorted.
 */
export function citationEdges(
  seeds: readonly SeedRefs[],
  works: readonly Pick<NetworkWork, 'openAlexId' | 'direction' | 'seeds'>[],
): CitationEdge[] {
  const present = new Set([...seeds.map((seed) => seed.openAlexId), ...works.map((work) => work.openAlexId)])
  const seedIds = new Set(seeds.map((seed) => seed.openAlexId))
  const edges = new Map<string, CitationEdge>()
  const add = (from: OpenAlexId, to: OpenAlexId): void => {
    if (from === to || !present.has(from) || !present.has(to)) return
    const key = `${from} ${to}`
    if (!edges.has(key)) edges.set(key, { from, to })
  }

  // A seed's bibliography covers seed -> seed and seed -> reference alike.
  for (const seed of seeds) {
    for (const ref of seed.referencedWorks) add(seed.openAlexId, ref)
  }
  for (const work of works) {
    for (const seed of work.seeds) {
      if (!seedIds.has(seed)) continue
      if (work.direction === 'citing') add(work.openAlexId, seed)
      else add(seed, work.openAlexId)
    }
  }
  return [...edges.values()].sort((x, y) => compareIds(x.from, y.from) || compareIds(x.to, y.to))
}

// --- Gaps --------------------------------------------------------------------

/**
 * How much the seeds lean on a work, for how well known it is:
 * `seedCount / log10(10 + citedBy)`.
 *
 * The divisor is 1 at zero citations, 2 at ninety, 3 at a thousand and about
 * 4.6 at forty thousand: fame is discounted without ever cancelling the local
 * count. An unknown count divides by 1, the same as zero. The divisor follows
 * zotero-citation-graph's gap list (idea only, no code).
 */
export function gapScore(seedCount: number, citedByCount: number | null): number {
  return seedCount / Math.log10(10 + Math.max(0, citedByCount ?? 0))
}

/**
 * Higher score first. Scores equal up to rounding tie: two scores that are the
 * same number on paper should not be ordered by floating-point noise.
 */
function scoreOrder(x: number, y: number): number {
  const diff = y - x
  return Math.abs(diff) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y)) ? 0 : diff
}

/**
 * The works the library does not hold, ranked, and those it probably holds.
 *
 * Gaps are ranked within their direction (references first, then citing
 * works) by score, then by seed count, then by year, newest first, then by
 * id. Probable matches are listed apart, in the order given; exact matches
 * are neither.
 */
export function rankGaps(works: readonly NetworkWork[]): { gaps: Gap[]; probable: NetworkWork[] } {
  const probable = works.filter((work) => work.match?.confidence === 'probable')
  const scored = works
    .filter((work) => work.match === null)
    .map((work) => ({ ...work, match: null, score: gapScore(work.seeds.length, work.citedByCount), rank: 0 }))
  const gaps: Gap[] = []
  for (const direction of ['reference', 'citing'] as const) {
    const ranked = scored
      .filter((gap) => gap.direction === direction)
      .sort(
        (x, y) =>
          scoreOrder(x.score, y.score) ||
          y.seeds.length - x.seeds.length ||
          (y.year ?? -Infinity) - (x.year ?? -Infinity) ||
          compareIds(x.openAlexId, y.openAlexId),
      )
    ranked.forEach((gap, index) => gaps.push({ ...gap, rank: index + 1 }))
  }
  return { gaps, probable }
}

// --- Cost ----------------------------------------------------------------------

/**
 * What an analysis will cost, before it runs.
 *
 *     seed lookups   ceil(seeds / 100)
 *     shared refs    ceil(seeds * SHARED_REFS_PER_SEED / 100)
 *     citing         groups = ceil(seeds / 100); per group
 *                    min(CITING_PAGE_CAP, max(1, ceil(citingCount / groups / 100)))
 *                    pages, or CITING_PAGE_CAP when citingCount is unknown
 *     usd            listRequests * $0.0001
 *
 * Every request the analysis makes is a list request; there are no single
 * GETs. A seed found only by its PMID, or only by its arXiv DOI after the
 * publisher DOI missed, costs a few more lookups than this assumes.
 * `citingCount` is the number of works citing the seeds, e.g. the sum of
 * their citation counts, which overstates overlap and so errs high.
 */
export function estimateRequests(input: {
  seeds: number
  withCiting: boolean
  citingCount?: number
  hasKey: boolean
}): RequestEstimate {
  const seeds = Math.max(0, Math.floor(input.seeds))
  // Every seed is looked up, none taken from a cache: see collectionNetwork.ts.
  const lookups = Math.ceil(seeds / BATCH_SIZE)
  const shared = Math.ceil((seeds * SHARED_REFS_PER_SEED) / BATCH_SIZE)

  let citing = 0
  if (input.withCiting && seeds > 0) {
    const groups = Math.ceil(seeds / BATCH_SIZE)
    // Without a key OpenAlex serves only the first page of a cursor.
    const cap = input.hasKey ? CITING_PAGE_CAP : 1
    const perGroup =
      input.citingCount === undefined
        ? cap
        : Math.min(cap, Math.max(1, Math.ceil(Math.max(0, input.citingCount) / groups / BATCH_SIZE)))
    citing = groups * perGroup
  }

  const listRequests = lookups + shared + citing
  const usd = listRequests * USD_PER_LIST_REQUEST
  const dailyBudgetUsd = input.hasKey ? DAILY_BUDGET_USD.withKey : DAILY_BUDGET_USD.withoutKey
  return { listRequests, singleRequests: 0, usd, dailyBudgetUsd, shareOfDailyBudget: usd / dailyBudgetUsd }
}

// --- Rematch -------------------------------------------------------------------

/**
 * The same network against the library as it is now, without a request.
 *
 * Every work is matched again -- after an import, a gap becomes held -- and
 * the gaps and probable matches recomputed. Seeds are library items by
 * construction and keep their item ids; `SeedWork` has no held status.
 */
export function rematch(net: CollectionNetwork, match: (work: MatchableWork) => MatchResult | null): CollectionNetwork {
  const works = net.works.map((work) => ({
    ...work,
    match: match({ doi: work.doi, title: work.title, year: work.year, authors: work.authors }),
  }))
  const { gaps, probable } = rankGaps(works)
  return { ...net, works, gaps, probable }
}

// --- Cache key -----------------------------------------------------------------

/** cyrb53: a fast 53-bit string hash. Not cryptographic; a cache address only. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * Where a finished analysis is cached: the set of seeds and whether citing
 * works were fetched. The same seeds reached from another collection share
 * the entry; the caller replaces the scope on a hit.
 */
export function networkCacheKey(seedIds: readonly OpenAlexId[], citing: boolean): string {
  const ids = [...new Set(seedIds)].sort()
  return `collnet:v1:${hash53(`${citing ? 'c1' : 'c0'}|${ids.join(',')}`)}:${ids.length}`
}

/**
 * The network as it is cached: without the parts that follow from the rest.
 *
 * Coupling, citation edges, gaps and probable matches are recomputed from the
 * seeds and works in well under a second, and together they are more than
 * half the entry -- the gaps alone repeat most of the works. The cache file is
 * rewritten whole on every flush, so a 300-seed analysis is worth keeping lean.
 */
export function toCacheEntry(net: CollectionNetwork): CollectionNetwork {
  return { ...net, coupling: [], citations: [], gaps: [], probable: [] }
}

/** The full network from a cached entry, the derived parts recomputed. */
export function fromCacheEntry(entry: CollectionNetwork): CollectionNetwork {
  return {
    ...entry,
    coupling: couplingEdges(entry.seeds),
    citations: citationEdges(entry.seeds, entry.works),
    ...rankGaps(entry.works),
  }
}
