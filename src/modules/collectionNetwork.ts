/**
 * The collection network, Zotero side: from a collection or a library to a
 * finished `CollectionNetwork`.
 *
 * The steps, each reported through `onProgress`:
 *
 * 1. `seeds`: every item's identifiers -- its DOI, the DOI arXiv mints for
 *    its arXiv id, its PMID from Extra.
 * 2. `lookup`: each item as an OpenAlex work, in batches of a hundred by
 *    DOI, then by PMID.
 * 3. `references`: the works at least two seeds cite, in batches of a hundred.
 * 4. `citing`: with an API key and on request, the works citing at least two
 *    seeds, paged by cursor.
 * 5. `library`: which of those works the library holds.
 * 6. `clusters`: coupling, Leiden, labels; then the gaps.
 *
 * The finished network is cached as a whole under `collnet:v1:...`, keyed by
 * its seeds. The pure parts are in collectionNetwork.core and clustering.core.
 */

import { getString } from '../utils/locale'
import { debugLog } from '../utils/log'
import { getPref } from '../utils/prefs'
import { readCache, writeCache } from '../utils/recordCache'

import { Helpers } from './citationCounts'
import { clusterByCoupling, labelClusters } from './clustering.core'
import {
  BATCH_SIZE,
  chooseSeeds,
  citationEdges,
  citersOfSeveral,
  CITING_PAGE_CAP,
  couplingEdges,
  fromCacheEntry,
  networkCacheKey,
  rankGaps,
  rematch,
  sharedReferences,
  toCacheEntry,
} from './collectionNetwork.core'
import { getLibraryMatcher, matchInLibrary } from './libraryIndex'
import { itemKeys } from './libraryMatch.core'
import { hasOpenAlexApiKey, toLookupDoi } from './openAlexClient.core'
import { fetchOpenAlexPage } from './openAlexEnrichment'
import {
  buildCitingAnyUrl,
  buildWorksListUrl,
  CITING_SELECT,
  normalizeNetworkWorks,
  pageMeta,
  SEED_SELECT,
  SHARED_SELECT,
} from './openAlexNetwork.core'
import { normalizeSeedLimit, normalizeSeedPolicy } from './preferenceSettings.core'

import type {
  BuildOptions,
  CollectionNetwork,
  NetworkCoverage,
  NetworkScope,
  NetworkStep,
  NetworkWork,
  OpenAlexId,
  SeedPolicy,
  SeedWork,
} from './collectionTypes'
import type { OpenAlexWork } from './openAlexNetwork.core'

// --- Scope and seed choice -----------------------------------------------------

/**
 * The regular, untrashed items of a collection (its direct children) or of a
 * whole library. `total` is their count, the `itemsInScope` of the coverage.
 */
export async function resolveSeedItems(scope: NetworkScope): Promise<{ items: Zotero.Item[]; total: number }> {
  let candidates: Zotero.Item[] = []
  if (scope.kind === 'collection') {
    const collection = Zotero.Collections.get(scope.collectionID)
    candidates = collection ? collection.getChildItems(false, false) : []
  } else {
    candidates = await Zotero.Items.getAll(scope.libraryID, true, false)
  }
  const items = candidates.filter((item) => item.isRegularItem() && !item.deleted)
  return { items, total: items.length }
}

/** The seed limit and policy as set, normalized. */
export function readSeedSettings(): { limit: number; policy: SeedPolicy } {
  return {
    limit: normalizeSeedLimit(getPref('networkSeedLimit')),
    policy: normalizeSeedPolicy(getPref('networkSeedPolicy')),
  }
}

/** The identifiers an item can be looked up by in OpenAlex. */
export interface ItemLookupIds {
  /** Lower-cased, most specific first: the item's own DOI before an arXiv DOI. */
  dois: string[]
  pmid: string | null
}

function field(item: Zotero.Item, name: string): string {
  try {
    return item.getField(name) || ''
  } catch {
    // Item types without the field throw rather than return empty.
    return ''
  }
}

/** DOI, arXiv as `10.48550/arxiv.<id>`, a `DOI:` line in Extra, PMID from Extra. */
export function itemLookupIds(item: Zotero.Item): ItemLookupIds {
  const dois: string[] = []
  const add = (doi: string): void => {
    const lower = doi.toLowerCase()
    if (!dois.includes(lower)) dois.push(lower)
  }
  try {
    for (const identifier of Helpers.getAllItemIdentifiers(item)) add(toLookupDoi(identifier))
  } catch (err) {
    debugLog('Citation debug - Network: could not read identifiers of item', item.id, err)
  }
  let pmid: string | null = null
  for (const key of itemKeys({ extra: field(item, 'extra') })) {
    if (key.startsWith('doi:')) add(key.slice(4))
    else if (key.startsWith('pmid:')) pmid = key.slice(5)
  }
  // An arXiv DOI after every publisher DOI: the published version is the one
  // OpenAlex counts citations against.
  dois.sort((a, b) => Number(a.startsWith('10.48550/')) - Number(b.startsWith('10.48550/')))
  return { dois, pmid }
}

/**
 * The shape `chooseSeeds` orders by, with the item attached. Pass the result
 * to `chooseSeeds`, and the chosen `.item`s to `buildCollectionNetwork`.
 */
export function seedCandidates(
  items: readonly Zotero.Item[],
): { itemID: number; hasIdentifier: boolean; dateAdded: string; item: Zotero.Item }[] {
  return items.map((item) => {
    const ids = itemLookupIds(item)
    return { itemID: item.id, hasIdentifier: ids.dois.length > 0 || ids.pmid !== null, dateAdded: item.dateAdded, item }
  })
}

export { chooseSeeds }

// --- Building ------------------------------------------------------------------

function abortError(): Error {
  // Not a DOMException: in a degraded runtime that constructor is a stub.
  const err = new Error('The network analysis was cancelled')
  err.name = 'AbortError'
  return err
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

const OPENALEX_URL = /^https?:\/\/openalex\.org\//i

function bare(id: string): string {
  return id.trim().replace(OPENALEX_URL, '')
}

function seedFromWork(itemID: number, work: OpenAlexWork, lookupDoi: string | null): SeedWork {
  return {
    itemID,
    openAlexId: work.openAlexId,
    doi: work.doi ?? lookupDoi,
    title: work.title ?? work.doi ?? lookupDoi ?? work.openAlexId,
    year: work.year,
    citedByCount: work.citedByCount,
    referenceCount: work.referenceCount,
    authors: work.authors,
    referencedWorks: work.referencedWorks,
    primaryTopic: work.primaryTopic,
  }
}

function toNetworkWork(work: OpenAlexWork, direction: NetworkWork['direction'], seeds: OpenAlexId[]): NetworkWork {
  return {
    openAlexId: work.openAlexId,
    doi: work.doi,
    title: work.title ?? work.doi ?? work.openAlexId,
    year: work.year,
    citedByCount: work.citedByCount,
    referenceCount: work.referenceCount,
    authors: work.authors,
    direction,
    seeds,
    match: null,
  }
}

function clusterFallback(clusterId: number): string {
  try {
    return getString('network-cluster-fallback', { args: { number: clusterId + 1 } })
  } catch {
    return `Cluster ${clusterId + 1}`
  }
}

function isCachedNetwork(value: unknown, seedIds: ReadonlySet<OpenAlexId>): value is CollectionNetwork {
  const net = value as CollectionNetwork | null
  return (
    net !== null &&
    typeof net === 'object' &&
    net.version === 1 &&
    Array.isArray(net.seeds) &&
    Array.isArray(net.works) &&
    net.seeds.length === seedIds.size &&
    net.seeds.every((seed) => seedIds.has(seed.openAlexId))
  )
}

/**
 * Analyse the given items as a network.
 *
 * `items` are the seeds as chosen already (see `seedCandidates` and
 * `chooseSeeds`): choosing, and asking whether to go past the limit, happens
 * between resolving the scope and building. `context` carries what only the
 * caller knows about that choice into the coverage; without it the items are
 * taken as the whole scope.
 *
 * Throws an error named `AbortError` once `options.signal` aborts, checked
 * before every request. A failed seed or reference request fails the build; a
 * failed citing request keeps what came in and marks the citing side
 * truncated. Nothing is cached after a failed request.
 */
export async function buildCollectionNetwork(
  scope: NetworkScope,
  items: readonly Zotero.Item[],
  options: BuildOptions,
  context: { itemsInScope?: number; capped?: boolean } = {},
): Promise<CollectionNetwork> {
  const { signal, onProgress } = options
  const progress = (step: NetworkStep, done: number, total: number): void => {
    try {
      onProgress?.({ step, done, total })
    } catch (err) {
      debugLog('Citation debug - Network progress callback failed:', err)
    }
  }
  const checkAbort = (): void => {
    if (signal?.aborted) throw abortError()
  }
  let requestsMade = 0
  let failedRequest = false
  const fetchPage = async (url: string): Promise<unknown> => {
    checkAbort()
    requestsMade++
    try {
      return await fetchOpenAlexPage(url)
    } catch (err) {
      // Whatever a request cancelled mid-flight throws, the caller asked to stop.
      if (signal?.aborted) throw abortError()
      throw err
    }
  }

  // 1. Identifiers.
  const idsByItem = new Map<number, ItemLookupIds>()
  items.forEach((item, index) => {
    idsByItem.set(item.id, itemLookupIds(item))
    if (index % 50 === 0) progress('seeds', index, items.length)
  })
  progress('seeds', items.length, items.length)

  // 2. Seeds: DOI batches (own DOI first, arXiv DOI on a second round), then
  // PMID batches. Always fetched, never taken from the item pane's `work:`
  // records: those lack `primary_topic`, and the clusters are named by it.
  const seedByItem = new Map<number, SeedWork>()
  const lookupTotal = items.length
  let lookedUp = 0
  progress('lookup', 0, lookupTotal)
  for (let round = 0; ; round++) {
    // DOI -> the items asking for it; duplicates in the library share a slot.
    const wanted = new Map<string, number[]>()
    for (const item of items) {
      if (seedByItem.has(item.id)) continue
      const doi = idsByItem.get(item.id)!.dois[round]
      if (doi === undefined) continue
      const askers = wanted.get(doi)
      if (askers) askers.push(item.id)
      else wanted.set(doi, [item.id])
    }
    if (wanted.size === 0) break
    for (const batch of chunks([...wanted.keys()], BATCH_SIZE)) {
      const works = normalizeNetworkWorks(await fetchPage(buildWorksListUrl('doi', batch, SEED_SELECT)))
      for (const work of works) {
        if (!work.doi) continue
        for (const itemID of wanted.get(work.doi) ?? []) {
          if (!seedByItem.has(itemID)) seedByItem.set(itemID, seedFromWork(itemID, work, work.doi))
        }
      }
      if (round === 0) lookedUp += batch.length
      progress('lookup', Math.min(lookedUp, lookupTotal), lookupTotal)
    }
  }

  const byPmid = new Map<string, number[]>()
  for (const item of items) {
    const pmid = idsByItem.get(item.id)!.pmid
    if (seedByItem.has(item.id) || pmid === null) continue
    const askers = byPmid.get(pmid)
    if (askers) askers.push(item.id)
    else byPmid.set(pmid, [item.id])
  }
  for (const batch of chunks([...byPmid.keys()], BATCH_SIZE)) {
    const works = normalizeNetworkWorks(await fetchPage(buildWorksListUrl('ids.pmid', batch, SEED_SELECT)))
    for (const work of works) {
      if (!work.pmid) continue
      for (const itemID of byPmid.get(work.pmid) ?? []) {
        if (!seedByItem.has(itemID)) seedByItem.set(itemID, seedFromWork(itemID, work, null))
      }
    }
  }
  progress('lookup', lookupTotal, lookupTotal)

  // Two items can be one work -- duplicates, or a preprint filed twice. The
  // first item keeps the node.
  const seeds: SeedWork[] = []
  const seedIds = new Set<OpenAlexId>()
  const unresolved: NetworkCoverage['unresolved'] = []
  for (const item of items) {
    const seed = seedByItem.get(item.id)
    if (!seed) {
      const ids = idsByItem.get(item.id)!
      unresolved.push({
        itemID: item.id,
        reason: ids.dois.length === 0 && ids.pmid === null ? 'no-identifier' : 'not-found',
      })
      continue
    }
    if (seedIds.has(seed.openAlexId)) continue
    seedIds.add(seed.openAlexId)
    seeds.push(seed)
  }
  debugLog(`Citation debug - Network: ${seeds.length} seeds, ${unresolved.length} unresolved, ${requestsMade} requests`)

  const citing = options.includeCiting && hasOpenAlexApiKey()
  const coverageBase = {
    itemsInScope: context.itemsInScope ?? items.length,
    analysed: items.length,
    capped: context.capped ?? false,
    resolved: seedByItem.size,
    unresolved,
  }

  // The whole analysis, cached under its seeds.
  const cacheKey = networkCacheKey([...seedIds], citing)
  if (!options.force) {
    const cached = readCache<unknown>(cacheKey)
    if (isCachedNetwork(cached, seedIds)) {
      debugLog(`Citation debug - Network: using cached analysis ${cacheKey}`)
      const itemOf = new Map(seeds.map((seed) => [seed.openAlexId, seed.itemID]))
      const matcher = await getLibraryMatcher(scope.libraryID)
      return rematch(
        {
          ...fromCacheEntry(cached),
          scope,
          seeds: cached.seeds.map((seed) => ({ ...seed, itemID: itemOf.get(seed.openAlexId) ?? seed.itemID })),
          coverage: {
            ...cached.coverage,
            ...coverageBase,
            requestsMade,
          },
        },
        (work) => matchInLibrary(matcher, work),
      )
    }
  }

  // 3. Shared references.
  const shared = sharedReferences(seeds)
  const sharedIds = [...shared.keys()]
  const works: NetworkWork[] = []
  const workIds = new Set<OpenAlexId>()
  progress('references', 0, sharedIds.length)
  let resolvedRefs = 0
  for (const batch of chunks(sharedIds, BATCH_SIZE)) {
    const page = normalizeNetworkWorks(await fetchPage(buildWorksListUrl('openalex_id', batch, SHARED_SELECT)))
    for (const work of page) {
      const citers = shared.get(work.openAlexId)
      if (!citers || workIds.has(work.openAlexId)) continue
      workIds.add(work.openAlexId)
      works.push(toNetworkWork(work, 'reference', citers))
    }
    resolvedRefs += batch.length
    progress('references', resolvedRefs, sharedIds.length)
  }

  // 4. Citing works: only with a key, since OpenAlex pages a cursor past the
  // first page only then.
  let citingTruncated = false
  if (citing) {
    const groups = chunks([...seedIds].sort(), BATCH_SIZE)
    const fetched: OpenAlexWork[] = []
    progress('citing', 0, groups.length)
    for (const [index, group] of groups.entries()) {
      let cursor: string | null = '*'
      let pages = 0
      try {
        while (cursor !== null && pages < CITING_PAGE_CAP) {
          const json = await fetchPage(buildCitingAnyUrl(group, cursor, CITING_SELECT))
          pages++
          const page = normalizeNetworkWorks(json)
          fetched.push(...page)
          cursor = page.length === 0 ? null : pageMeta(json).nextCursor
        }
        if (cursor !== null) citingTruncated = true
      } catch (err) {
        if (signal?.aborted) throw abortError()
        // A shutdown aborts every lookup in flight; that is not a failed page.
        if ((err as { name?: unknown } | null)?.name === 'AbortError') throw err
        // A timeout, an HTTP error, bad JSON: keep what came in; the citing
        // side is incomplete, and says so.
        debugLog('Citation debug - Network: citing works request failed:', err)
        citingTruncated = true
        failedRequest = true
      }
      progress('citing', index + 1, groups.length)
    }
    for (const { work, seeds: cited } of citersOfSeveral(fetched, seedIds)) {
      // A work both shared reference and citer stays a reference: one node
      // per id, and the reference side is the one every analysis has.
      if (workIds.has(work.openAlexId)) continue
      workIds.add(work.openAlexId)
      works.push(toNetworkWork(work, 'citing', cited))
    }
  }

  // 5. Library.
  checkAbort()
  progress('library', 0, works.length)
  const matcher = await getLibraryMatcher(scope.libraryID)
  for (const work of works) {
    work.match = matchInLibrary(matcher, { doi: work.doi, title: work.title, year: work.year, authors: work.authors })
  }
  progress('library', works.length, works.length)

  // 6. Clusters.
  checkAbort()
  progress('clusters', 0, 1)
  const coupling = couplingEdges(seeds)
  const seedList = seeds.map((seed) => seed.openAlexId)
  let assignment: Map<OpenAlexId, number | null>
  try {
    assignment = clusterByCoupling(seedList, coupling)
  } catch (err) {
    // A network without clusters is still a network.
    debugLog('Citation debug - Network: clustering failed:', err)
    assignment = new Map(seedList.map((id) => [id, null]))
  }
  const topicById = new Map(seeds.map((seed) => [seed.openAlexId, seed.primaryTopic]))
  const clusters = labelClusters(assignment, (id) => topicById.get(id) ?? null, clusterFallback)
  progress('clusters', 1, 1)

  // 7. Gaps, edges, coverage.
  const { gaps, probable } = rankGaps(works)
  const net: CollectionNetwork = {
    version: 1,
    scope,
    builtAt: Date.now(),
    seeds,
    works,
    coupling,
    citations: citationEdges(seeds, works),
    clusters,
    clusterOf: Object.fromEntries(assignment),
    gaps,
    probable,
    coverage: {
      ...coverageBase,
      citingIncluded: citing,
      citingTruncated,
      requestsMade,
    },
  }
  debugLog(
    `Citation debug - Network: ${works.length} works, ${gaps.length} gaps, ${clusters.length} clusters,`,
    `${requestsMade} requests`,
  )

  // 8. Cache, unless something failed on the way.
  if (!failedRequest) writeCache(cacheKey, toCacheEntry(net))
  return net
}
