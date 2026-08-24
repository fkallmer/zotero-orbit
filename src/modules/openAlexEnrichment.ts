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

import { lookupFetch, RateLimitManager, REQUEST_HEADERS } from './citationTally'
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
    response = await lookupFetch(url, { headers: REQUEST_HEADERS })
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
  const collected = await fetchWorkLinks(withDoi.map((node) => node.doi as string))
  if (collected === null) return [] // a partial map would invent absences

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

/**
 * How many works of a level get expanded, and how many the next level adds.
 *
 * Both are hard caps, and both matter. Without the first, a seed with fifty
 * citing works costs fifty requests for one step outward; without the second,
 * sixteen references with forty entries each put six hundred marks on a plot
 * that is unreadable past a hundred. Fanning out from the most-cited is not
 * arbitrary -- those are the works the level is actually about.
 */
export const EXPAND_FANOUT = 10
export const LEVEL_CAP = 25

interface Candidate {
  openAlexId: string
  /** How many works of the previous level cite it. */
  weight: number
}

/**
 * Rank what the previous level cites by how many of them cite it.
 *
 * Co-citation, and it is the whole reason a second level is worth drawing. A
 * work that eleven of the seed's references all cite is the shared ancestor
 * of that literature; one cited by a single reference is that reference's own
 * business. Ranking by the candidates' own citation counts instead would need
 * them resolved first -- hundreds of works fetched to keep twenty-five.
 */
export function rankByCoCitation(bibliographies: readonly (readonly string[])[]): Candidate[] {
  const weights = new Map<string, number>()
  for (const cited of bibliographies) {
    // A work counts once per citing work however often it appears in its list.
    for (const id of new Set(cited)) weights.set(id, (weights.get(id) ?? 0) + 1)
  }
  return [...weights.entries()]
    .map(([openAlexId, weight]) => ({ openAlexId, weight }))
    .sort((a, b) => b.weight - a.weight || a.openAlexId.localeCompare(b.openAlexId))
}

/**
 * Every work's OpenAlex id and bibliography, by DOI, in batches.
 *
 * Null rather than a short list on any failure: the callers use absence as
 * evidence -- "these two are not connected", "nothing else cites this" -- and
 * a partial answer would turn a dropped request into a finding.
 */
export async function fetchWorkLinks(dois: readonly string[]): Promise<WorkLinks[] | null> {
  const collected: WorkLinks[] = []
  for (let at = 0; at < dois.length; at += REFERENCE_CHUNK) {
    const json = await fetchJson(buildWorksByDoiUrl(dois.slice(at, at + REFERENCE_CHUNK)))
    if (json === null) return null
    collected.push(...normalizeWorkLinks(json))
  }
  return collected
}

/** What one step outward found, ready to be turned into nodes. */
export interface Expansion {
  references: ResolvedReference[]
  citing: ResolvedReference[]
}

/**
 * One step outward from a level of the graph.
 *
 * Backwards by co-citation over the whole level at once, forwards one request
 * per work, and both capped -- see EXPAND_FANOUT and LEVEL_CAP for why. Works
 * already in the graph are dropped here rather than by the caller, so the cap
 * counts what the level actually adds.
 */
export async function expandLevel(
  level: readonly { key: string; doi: string | null; citedByCount: number | null }[],
  known: ReadonlySet<string>,
): Promise<Expansion> {
  const seeds = [...level]
    .filter((work) => work.doi !== null)
    .sort((a, b) => (b.citedByCount ?? 0) - (a.citedByCount ?? 0))
    .slice(0, EXPAND_FANOUT)
  if (seeds.length === 0) return { references: [], citing: [] }

  const links = await fetchWorkLinks(seeds.map((work) => work.doi as string))
  if (links === null) return { references: [], citing: [] }

  // Backwards: rank the whole level's bibliographies together, then resolve
  // only what survives the cap. Ranking after resolving would mean fetching
  // hundreds of works to keep twenty-five.
  const wanted = rankByCoCitation(links.map((work) => work.referencedWorks))
    .map((candidate) => candidate.openAlexId)
    .filter((id) => !known.has(id.toLowerCase()))
    .slice(0, LEVEL_CAP)

  const references: ResolvedReference[] = []
  for (let at = 0; at < wanted.length; at += REFERENCE_CHUNK) {
    const json = await fetchJson(buildWorksByIdUrl(wanted.slice(at, at + REFERENCE_CHUNK)))
    if (json !== null) references.push(...normalizeReferences(json))
  }

  // Forwards: one request each, most-cited first, and the cap applies to the
  // level rather than to each work, so one popular paper cannot fill it.
  const citing: ResolvedReference[] = []
  const seen = new Set(known)
  for (const work of links) {
    if (citing.length >= LEVEL_CAP) break
    const json = await fetchJson(buildCitingWorksUrl(work.openAlexId, LEVEL_CAP))
    if (json === null) continue
    for (const found of normalizeReferences(json)) {
      const key = (found.doi ?? found.title ?? '').toLowerCase()
      if (key === '' || seen.has(key) || citing.length >= LEVEL_CAP) continue
      seen.add(key)
      citing.push(found)
    }
  }
  return { references, citing }
}
