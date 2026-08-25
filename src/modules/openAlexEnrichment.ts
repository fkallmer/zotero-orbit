/**
 * Fetching the OpenAlex data the item pane shows.
 *
 * Kept apart from the citation-count path on purpose. That path runs for every
 * item in a bulk update and asks for a single field; this one pulls a much
 * larger record and only ever runs for the item currently on screen. Merging
 * them would make every library-wide refresh substantially heavier.
 *
 * The plan called for separate `openAlexRecord` and `openAlexSource` modules.
 * They are together here because they share the whole fetch path -- rate
 * limiter, headers, cache, error handling -- and splitting them would only
 * duplicate it.
 */

import { debugLog } from '../utils/log'
import { dropCache, readCache, writeCache } from '../utils/recordCache'

import { lookupFetch, RateLimitManager, requestHeaders } from './citationCounts'
import {
  buildCitingWorksUrl,
  buildSourceUrl,
  buildWorksByDoiUrl,
  buildWorksByIdUrl,
  buildWorkUrl,
  normalizeReferences,
  normalizeSource,
  normalizeWork,
  normalizeWorkLinks,
  OPENALEX_DATABASE,
  openAlexRecordCacheKey,
  REFERENCE_CHUNK,
  toLookupDoi,
  WORK_FULL_SELECT,
} from './openAlexClient.core.ts'

import type { ItemIdentifier } from './citationTypes.ts'
import type { JournalMetrics, ResolvedReference, ScholarlyRecord, WorkLinks } from './openAlexClient.core.ts'

/** Journals change far more slowly than works, and there are few of them. */
const SOURCE_TTL_MS = 60 * 24 * 60 * 60 * 1000

function sourceCacheKey(sourceId: string): string {
  return `source:${sourceId.toLowerCase()}`
}

async function fetchJson(url: string): Promise<unknown> {
  await RateLimitManager.waitForRateLimit(OPENALEX_DATABASE)
  let response: Response
  try {
    response = await lookupFetch(url, { headers: requestHeaders() })
  } catch (err) {
    debugLog('Citation debug - OpenAlex enrichment request failed:', err)
    return null
  }

  // Same budget accounting as the count path; the pane's requests spend from
  // the same allowance.
  RateLimitManager.noteBudget(OPENALEX_DATABASE, response)

  if (!response.ok) {
    if (response.status === 429) RateLimitManager.handleRateLimit(OPENALEX_DATABASE)
    debugLog(`Citation debug - OpenAlex enrichment HTTP ${response.status} for ${url}`)
    return null
  }

  try {
    const json: unknown = await response.json()
    RateLimitManager.handleSuccess(OPENALEX_DATABASE)
    return json
  } catch (err) {
    debugLog('Citation debug - OpenAlex enrichment body parse failed:', err)
    return null
  }
}

/**
 * The full record for an item, from cache when possible.
 *
 * Tries every identifier the item offers, for the same reason the count path
 * does: a published work resolves through its publisher DOI, a preprint
 * through the DOI arXiv mints, and which one hits is not knowable in advance.
 */
export async function fetchScholarlyRecord(
  identifiers: readonly ItemIdentifier[],
  options: { force?: boolean } = {},
): Promise<ScholarlyRecord | null> {
  for (const identifier of identifiers) {
    const lookupDoi = toLookupDoi(identifier)
    const key = openAlexRecordCacheKey(lookupDoi)

    if (options.force) {
      dropCache(key)
    } else {
      const cached = readCache<ScholarlyRecord>(key)
      if (cached) {
        debugLog(`Citation debug - OpenAlex record from cache: ${lookupDoi}`)
        return cached
      }
    }

    const json = await fetchJson(buildWorkUrl(lookupDoi, WORK_FULL_SELECT))
    const record = normalizeWork(json)
    if (record) {
      writeCache(key, record)
      return record
    }
  }
  return null
}

/**
 * Journal-level metrics.
 *
 * Cached per source, not per item: a library of a few hundred papers draws on
 * a few dozen journals, so this is a handful of requests however many items
 * the user browses.
 */
export async function fetchJournalMetrics(
  sourceId: string,
  options: { force?: boolean } = {},
): Promise<JournalMetrics | null> {
  const key = sourceCacheKey(sourceId)
  if (options.force) {
    dropCache(key)
  } else {
    const cached = readCache<JournalMetrics>(key, SOURCE_TTL_MS)
    if (cached) return cached
  }

  const metrics = normalizeSource(await fetchJson(buildSourceUrl(sourceId)))
  if (metrics) writeCache(key, metrics)
  return metrics
}

/**
 * Resolve a record's referenced works into something showable.
 *
 * The fallback for when Semantic Scholar has no reference list -- often because
 * the publisher told it not to serve one. OpenAlex answered with all 17 for a
 * paper S2 elides, each with its own citation count.
 *
 * One request per chunk of ids, not one per reference.
 */
export async function fetchReferences(
  record: ScholarlyRecord,
  options: { force?: boolean } = {},
): Promise<ResolvedReference[]> {
  // Defensive as well as versioned: a cache entry from an older shape should
  // degrade to "no references" rather than throw.
  const ids = record.referencedWorks ?? []
  if (ids.length === 0) return []

  const key = `refs:${(record.openAlexId ?? '').toLowerCase()}`
  if (options.force) dropCache(key)
  else {
    const cached = readCache<ResolvedReference[]>(key)
    if (cached) return cached
  }

  const resolved: ResolvedReference[] = []
  for (let at = 0; at < ids.length; at += REFERENCE_CHUNK) {
    const chunk = ids.slice(at, at + REFERENCE_CHUNK)
    const json = await fetchJson(buildWorksByIdUrl(chunk))
    if (json === null) break // partial beats nothing, and the cache is skipped below
    resolved.push(...normalizeReferences(json))
  }

  if (resolved.length > 0) writeCache(key, resolved)
  return resolved
}

/** How many citing works a graph takes on; the rest would not be readable. */
export const CITING_LIMIT = 50

/**
 * Works that cite this one, most-cited first.
 *
 * The forward direction of the graph. One request, and the sort means a
 * heavily cited paper contributes its most consequential descendants rather
 * than an arbitrary fifty.
 */
export async function fetchCitingWorks(
  record: ScholarlyRecord,
  options: { force?: boolean } = {},
): Promise<ResolvedReference[]> {
  if (!record.openAlexId) return []

  const key = `cites:${record.openAlexId.toLowerCase()}`
  if (options.force) dropCache(key)
  else {
    const cached = readCache<ResolvedReference[]>(key)
    if (cached) return cached
  }

  const json = await fetchJson(buildCitingWorksUrl(record.openAlexId, CITING_LIMIT))
  if (json === null) return []
  const resolved = normalizeReferences(json)
  if (resolved.length > 0) writeCache(key, resolved)
  return resolved
}

/** One work in the graph citing another work in the same graph. */
export interface GraphLink {
  from: string
  to: string
}

/** Stable across runs, and short enough for a cache key. */
function digest(text: string): string {
  let hash = 5381
  for (let at = 0; at < text.length; at++) hash = ((hash << 5) + hash + text.charCodeAt(at)) | 0
  return (hash >>> 0).toString(36)
}

/**
 * The paths between the surrounding works themselves.
 *
 * The graph already draws what the seed cites and what cites the seed. It said
 * nothing about the far more common case in a real bibliography: that the
 * references cite each other, often in a chain that is the actual line of
 * descent the reader is looking for.
 *
 * Seeing it needs both a DOI and an OpenAlex id on every node -- references
 * arrive from Semantic Scholar with only the first, `referenced_works` speaks
 * only the second -- so this is one batched lookup that puts them on the same
 * work. One request for a graph of fifty; the edge list is cached, not the
 * bibliographies, which are two orders of magnitude larger and of no use once
 * the crossings are known.
 */
export async function fetchGraphLinks(
  nodes: readonly { key: string; doi: string | null; role: string }[],
  options: { force?: boolean } = {},
): Promise<GraphLink[]> {
  const withDoi = nodes.filter((node) => node.doi !== null)
  if (withDoi.length < 2) return []

  const seedKey = nodes.find((node) => node.role === 'seed')?.key ?? null
  const key = `links:${digest(
    withDoi
      .map((node) => node.key)
      .sort()
      .join(','),
  )}`
  if (options.force) dropCache(key)
  else {
    const cached = readCache<GraphLink[]>(key)
    if (cached) return cached
  }

  const byDoi = new Map(withDoi.map((node) => [(node.doi as string).toLowerCase(), node.key]))
  const collected: WorkLinks[] = []
  for (let at = 0; at < withDoi.length; at += REFERENCE_CHUNK) {
    const chunk = withDoi.slice(at, at + REFERENCE_CHUNK).map((node) => node.doi as string)
    const json = await fetchJson(buildWorksByDoiUrl(chunk))
    if (json === null) return [] // a partial map would invent absences
    collected.push(...normalizeWorkLinks(json))
  }

  const keyOfOpenAlexId = new Map<string, string>()
  for (const work of collected) {
    const nodeKey = work.doi === null ? undefined : byDoi.get(work.doi)
    if (nodeKey) keyOfOpenAlexId.set(work.openAlexId, nodeKey)
  }

  const links: GraphLink[] = []
  for (const work of collected) {
    const from = work.doi === null ? undefined : byDoi.get(work.doi)
    if (!from) continue
    for (const cited of work.referencedWorks) {
      const to = keyOfOpenAlexId.get(cited)
      // Self-links are noise, and anything touching the seed is already drawn
      // as one of the main edges.
      if (!to || to === from || to === seedKey || from === seedKey) continue
      links.push({ from, to })
    }
  }

  writeCache(key, links)
  return links
}
