/**
 * Pure OpenAlex logic for the collection network: list and cursor URLs, and
 * the work shape the network builder reads.
 *
 * Free of Zotero so `node --test` can check it against recorded responses.
 * The fetching itself is `fetchOpenAlexPage` in openAlexEnrichment, which
 * paces and authenticates every request the same way the rest of the plugin
 * does.
 */

import { mailtoSuffix, openAlexContact } from './openAlexClient.core.ts'

const API_ROOT = 'https://api.openalex.org'

/** OpenAlex serves at most this many works per page. */
export const LIST_PAGE_MAX = 100

/** OpenAlex accepts at most this many values in one OR filter. */
export const OR_FILTER_MAX = 100

/**
 * Seeds carry their whole bibliography and their topic: the references are the
 * backward edges, the topic labels the clusters.
 */
export const SEED_SELECT =
  'id,doi,ids,display_name,publication_year,cited_by_count,referenced_works,referenced_works_count,authorships,primary_topic'

/**
 * Works shared by several seeds are drawn, not walked, so their own
 * bibliographies would be dead weight.
 */
export const SHARED_SELECT =
  'id,doi,ids,display_name,publication_year,cited_by_count,referenced_works_count,authorships'

/** Citing works need `referenced_works` to tell which seeds each one cites. */
export const CITING_SELECT =
  'id,doi,ids,display_name,publication_year,cited_by_count,referenced_works_count,referenced_works,authorships'

const OPENALEX_PREFIX = /^https?:\/\/openalex\.org\//i
const DOI_PREFIX = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i
const PMID_PREFIX = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i

function bareOpenAlexId(id: string): string {
  return id.trim().replace(OPENALEX_PREFIX, '')
}

function bareDoi(doi: string): string {
  return doi.trim().replace(DOI_PREFIX, '').toLowerCase()
}

function barePmid(pmid: string): string | null {
  const digits = pmid.trim().replace(PMID_PREFIX, '').replace(/\/+$/, '')
  return /^\d+$/.test(digits) ? digits : null
}

function assertOrList(values: readonly string[]): void {
  if (values.length > OR_FILTER_MAX) {
    throw new RangeError(`OpenAlex accepts at most ${OR_FILTER_MAX} OR values; got ${values.length}`)
  }
}

/**
 * Up to a hundred works by one identifier, in one request.
 *
 * Each value is encoded on its own and the list joined with a literal `|`:
 * an encoded `%7C` would be read as part of a DOI, not as the separator.
 */
export function buildWorksListUrl(
  field: 'doi' | 'ids.pmid' | 'openalex_id',
  values: readonly string[],
  select: string,
): string {
  assertOrList(values)
  const bare = values.map((value) => {
    if (field === 'doi') return bareDoi(value)
    if (field === 'ids.pmid') return barePmid(value) ?? value.trim()
    return bareOpenAlexId(value)
  })
  return (
    `${API_ROOT}/works?filter=${field}:${bare.map((value) => encodeURIComponent(value)).join('|')}` +
    `&select=${encodeURIComponent(select)}&per-page=${LIST_PAGE_MAX}` +
    `${mailtoSuffix(openAlexContact())}`
  )
}

/**
 * One page of the works citing any of up to a hundred seeds.
 *
 * Pass `*` for the first page and `meta.next_cursor` after that. OpenAlex only
 * pages past the first with an API key; without one the caller gets page one
 * and a cursor that leads nowhere.
 */
export function buildCitingAnyUrl(seedIds: readonly string[], cursor: string, select: string): string {
  assertOrList(seedIds)
  const bare = seedIds.map((id) => encodeURIComponent(bareOpenAlexId(id)))
  return (
    `${API_ROOT}/works?filter=cites:${bare.join('|')}` +
    `&select=${encodeURIComponent(select)}&per-page=${LIST_PAGE_MAX}` +
    `&cursor=${encodeURIComponent(cursor)}${mailtoSuffix(openAlexContact())}`
  )
}

/** A work as the network needs it; every id bare. */
export interface OpenAlexWork {
  openAlexId: string
  doi: string | null
  pmid: string | null
  title: string | null
  year: number | null
  citedByCount: number | null
  referenceCount: number | null
  authors: string[]
  referencedWorks: string[]
  primaryTopic: { id: string; name: string } | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function normalizeTopic(raw: unknown): { id: string; name: string } | null {
  const topic = asRecord(raw)
  const id = asNonEmptyString(topic?.id)
  const name = asNonEmptyString(topic?.display_name)
  return id && name ? { id: bareOpenAlexId(id), name } : null
}

/**
 * Read a list response into works.
 *
 * Entries without an id are dropped: the id is the node key, and a work
 * without one could not be linked to anything. Fields a select left out come
 * back empty rather than missing.
 */
export function normalizeNetworkWorks(json: unknown): OpenAlexWork[] {
  const body = asRecord(json)
  const results = Array.isArray(body?.results) ? body.results : []
  const out: OpenAlexWork[] = []
  for (const entry of results) {
    const work = asRecord(entry)
    const id = asNonEmptyString(work?.id)
    if (!work || !id) continue
    const ids = asRecord(work.ids)
    const doi = asNonEmptyString(work.doi) ?? asNonEmptyString(ids?.doi)
    const pmid = asNonEmptyString(ids?.pmid)
    out.push({
      openAlexId: bareOpenAlexId(id),
      doi: doi ? bareDoi(doi) : null,
      pmid: pmid ? barePmid(pmid) : null,
      title: asNonEmptyString(work.display_name) ?? asNonEmptyString(work.title),
      year: asFiniteNumber(work.publication_year),
      citedByCount: asFiniteNumber(work.cited_by_count),
      referenceCount: asFiniteNumber(work.referenced_works_count),
      authors: (Array.isArray(work.authorships) ? work.authorships : [])
        .map((authorship) => asNonEmptyString(asRecord(asRecord(authorship)?.author)?.display_name))
        .filter((name): name is string => name !== null),
      referencedWorks: (Array.isArray(work.referenced_works) ? work.referenced_works : [])
        .map((ref) => asNonEmptyString(ref))
        .filter((ref): ref is string => ref !== null)
        .map(bareOpenAlexId),
      primaryTopic: normalizeTopic(work.primary_topic),
    })
  }
  return out
}

/** The total and the cursor to the next page, when the response has them. */
export function pageMeta(json: unknown): { count: number | null; nextCursor: string | null } {
  const meta = asRecord(asRecord(json)?.meta)
  return {
    count: asFiniteNumber(meta?.count),
    nextCursor: asNonEmptyString(meta?.next_cursor),
  }
}
