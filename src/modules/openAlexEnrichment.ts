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
  buildSourceUrl,
  buildWorkUrl,
  normalizeSource,
  normalizeWork,
  OPENALEX_DATABASE,
  openAlexRecordCacheKey,
  toLookupDoi,
  WORK_FULL_SELECT,
} from './openAlexClient.core.ts'

import type { ItemIdentifier } from './citationTypes.ts'
import type { JournalMetrics, ScholarlyRecord } from './openAlexClient.core.ts'

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
