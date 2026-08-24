/**
 * Pure OpenAlex logic: identifier resolution, URL construction, normalization.
 *
 * Free of Zotero dependencies so `node --test` can exercise it against recorded
 * fixtures, mirroring `semanticScholarClient.core` and `googleScholarClient.core`.
 */

import { stripArxivVersion } from '../utils/identifiers.ts'

import type { ItemIdentifier } from './citationTypes.ts'

export const OPENALEX_DATABASE = 'openalex'

/**
 * Cache address for a normalized work record.
 *
 * Shared so the count path and the item pane write and read the same entry --
 * the count lookup fetches the full record anyway, and the pane should not
 * refetch what it already paid for.
 */
export function openAlexRecordCacheKey(lookupDoi: string): string {
  return `work:${lookupDoi.toLowerCase()}`
}

const API_ROOT = 'https://api.openalex.org'

/**
 * OpenAlex reads the contact from a `mailto` query parameter, not from the
 * User-Agent, and only then routes the request into its polite pool.
 */
/**
 * Substituted at build time; absent everywhere else, including the tests.
 *
 * Kept out of the source because it identifies whoever runs the build, and a
 * fork published from this repository must not go on sending someone else's
 * address. See `.orbit-contact` and zotero-plugin.config.ts.
 */
declare const __contact__: string | undefined

export const OPENALEX_CONTACT = typeof __contact__ === 'string' ? __contact__ : ''

/**
 * The polite-pool parameter, or nothing at all.
 *
 * OpenAlex asks for a contact address and gives faster, higher limits in
 * return. Without one it still answers, from the common pool -- so an unset
 * address must produce a URL with no `mailto` rather than one with an empty
 * one, which would claim a contact and name nobody.
 */
export function mailtoSuffix(contact: string): string {
  return contact.trim() === '' ? '' : `&mailto=${encodeURIComponent(contact.trim())}`
}

/** Fields the citation-count path needs. Kept minimal; it runs per item in bulk. */
export const WORK_COUNT_SELECT = 'cited_by_count'

/** Fields the item pane needs. Still a fraction of the full record. */
export const WORK_FULL_SELECT = [
  'id',
  'doi',
  'display_name',
  'publication_year',
  'type',
  'is_retracted',
  'cited_by_count',
  'counts_by_year',
  'fwci',
  'cited_by_percentile_year',
  'open_access',
  'best_oa_location',
  'primary_location',
  'apc_list',
  'apc_paid',
  'authorships',
  'funders',
  'awards',
  'referenced_works',
  'referenced_works_count',
  'updated_date',
].join(',')

/** Batch-resolving referenced works: one request however many there are. */
export const REFERENCE_SELECT = 'id,doi,display_name,publication_year,cited_by_count,referenced_works_count,authorships'

/** OpenAlex caps a filter list; longer reference lists go in chunks. */
export const REFERENCE_CHUNK = 50

/**
 * Resolve many works in one request.
 *
 * `openalex_id` takes an OR-list, so a reference list costs one round trip
 * rather than one per entry.
 */
export function buildWorksByIdUrl(openAlexIds: readonly string[]): string {
  const bare = openAlexIds.map((id) => id.replace(/^https?:\/\/openalex\.org\//i, ''))
  return (
    `${API_ROOT}/works?filter=openalex_id:${bare.join('|')}` +
    `&select=${encodeURIComponent(REFERENCE_SELECT)}&per-page=${REFERENCE_CHUNK}` +
    `${mailtoSuffix(OPENALEX_CONTACT)}`
  )
}

/**
 * Works citing a given one, newest first.
 *
 * `cites:` is a filter like any other, so this is one request per page rather
 * than a walk. Capped: a paper with 12,000 citations is not a graph anyone can
 * read, and the most-cited of them carry the story.
 */
export function buildCitingWorksUrl(openAlexId: string, perPage: number): string {
  const bare = openAlexId.replace(/^https?:\/\/openalex\.org\//i, '')
  return (
    `${API_ROOT}/works?filter=cites:${encodeURIComponent(bare)}` +
    `&select=${encodeURIComponent(REFERENCE_SELECT)}&per-page=${perPage}` +
    `&sort=cited_by_count:desc${mailtoSuffix(OPENALEX_CONTACT)}`
  )
}

/**
 * Just enough to draw the paths between the surrounding works.
 *
 * `referenced_works` is what says that one reference cites another, and it is
 * asked for on its own rather than added to REFERENCE_SELECT: a bibliography
 * of two hundred ids for each of fifty works is a large payload to carry on
 * every reference lookup, and it is only ever needed once per graph.
 */
export const LINK_SELECT = 'id,doi,referenced_works'

/**
 * Resolve many works by DOI in one request.
 *
 * The graph's nodes arrive with DOIs, sometimes from Semantic Scholar and
 * sometimes from OpenAlex, and a path between two of them can only be seen in
 * OpenAlex ids. This is the one lookup that puts both on the same work.
 */
export function buildWorksByDoiUrl(dois: readonly string[]): string {
  const bare = dois.map((doi) => doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase())
  return (
    `${API_ROOT}/works?filter=doi:${bare.map((doi) => encodeURIComponent(doi)).join('|')}` +
    `&select=${encodeURIComponent(LINK_SELECT)}&per-page=${REFERENCE_CHUNK}` +
    `${mailtoSuffix(OPENALEX_CONTACT)}`
  )
}

/** A work, its DOI, and everything it cites -- all in OpenAlex ids. */
export interface WorkLinks {
  openAlexId: string
  doi: string | null
  referencedWorks: string[]
}

export function normalizeWorkLinks(json: unknown): WorkLinks[] {
  const body = asRecord(json)
  const results = Array.isArray(body?.results) ? body.results : []
  const out: WorkLinks[] = []
  for (const entry of results) {
    const work = asRecord(entry)
    const openAlexId = asNonEmptyString(work?.id)
    if (!openAlexId) continue
    const doi = asNonEmptyString(work?.doi)
    out.push({
      openAlexId: openAlexId.replace(/^https?:\/\/openalex\.org\//i, ''),
      doi: doi ? doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : null,
      referencedWorks: (Array.isArray(work?.referenced_works) ? work.referenced_works : [])
        .map((id) => asNonEmptyString(id))
        .filter((id): id is string => id !== null)
        .map((id) => id.replace(/^https?:\/\/openalex\.org\//i, '')),
    })
  }
  return out
}

export const SOURCE_SELECT = 'id,display_name,issn_l,is_in_doaj,is_oa,apc_usd,apc_prices,summary_stats'

/**
 * The DOI to look an item up by.
 *
 * OpenAlex has no arXiv identifier -- its only usable id filters are `doi`,
 * `ids.mag`, `ids.openalex`, `ids.pmcid` and `ids.pmid`. arXiv items go through
 * the DOI arXiv mints itself, `10.48550/arxiv.<id>`, of which OpenAlex indexes
 * roughly 1.9M. That resolves for preprints without a journal version; once a
 * work is published the publisher DOI carries the count and the arXiv DOI may
 * 404, so callers should try every identifier the item offers.
 */
export function toLookupDoi(identifier: ItemIdentifier): string {
  return identifier.type === 'doi' ? identifier.id : `10.48550/arxiv.${stripArxivVersion(identifier.id)}`
}

/** Percent-encode a DOI for use in a path segment. */
function encodePath(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/')
}

export function buildWorkUrl(lookupDoi: string, select: string): string {
  return (
    `${API_ROOT}/works/doi:${encodePath(lookupDoi)}` +
    `?select=${encodeURIComponent(select)}${mailtoSuffix(OPENALEX_CONTACT)}`
  )
}

/** Accepts either a bare id (`S189694085`) or the full OpenAlex URL. */
export function buildSourceUrl(sourceId: string): string {
  const bare = sourceId.replace(/^https?:\/\/openalex\.org\//i, '')
  return (
    `${API_ROOT}/sources/${encodeURIComponent(bare)}` +
    `?select=${encodeURIComponent(SOURCE_SELECT)}${mailtoSuffix(OPENALEX_CONTACT)}`
  )
}

// --- Normalized shapes -----------------------------------------------------

export interface YearCount {
  year: number
  count: number
}

export interface RecordAuthor {
  name: string
  orcid: string | null
  institutions: { name: string; ror: string | null }[]
}

export interface RecordFunding {
  funder: string
  awardId: string | null
}

export interface JournalMetrics {
  sourceId: string
  name: string | null
  issnL: string | null
  isInDoaj: boolean
  isOa: boolean
  apcUsd: number | null
  /** OpenAlex's 2-year mean citedness, its analogue to an impact factor. */
  twoYearMeanCitedness: number | null
  hIndex: number | null
  i10Index: number | null
}

/** A work cited by the record, resolved far enough to show and match. */
export interface ResolvedReference {
  title: string | null
  doi: string | null
  year: number | null
  citedByCount: number | null
  /** First author's surname, for a label that fits beside a mark. */
  author: string | null
  /** How many works it cites -- breadth, as against the impact on the y-axis. */
  referenceCount: number | null
}

/**
 * The surname alone.
 *
 * A label beside a mark has room for "Soleimani 2019" and not for
 * "Manuchehr Soleimani". OpenAlex gives no surname field, so the last
 * whitespace-separated part it is -- wrong for a few naming conventions, and
 * the full name stays in the tooltip for those.
 */
function surnameOf(displayName: string | null): string | null {
  if (!displayName) return null
  const parts = displayName.trim().split(/\s+/)
  return parts[parts.length - 1] || null
}

export function normalizeReferences(json: unknown): ResolvedReference[] {
  const body = asRecord(json)
  const results = Array.isArray(body?.results) ? body.results : []
  const out: ResolvedReference[] = []
  for (const entry of results) {
    const work = asRecord(entry)
    if (!work) continue
    const title = asNonEmptyString(work.display_name)
    const doi = asNonEmptyString(work.doi)
    if (!title && !doi) continue
    const first = Array.isArray(work.authorships) ? asRecord(work.authorships[0]) : null
    out.push({
      title,
      doi: doi ? doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : null,
      year: asFiniteNumber(work.publication_year),
      citedByCount: asFiniteNumber(work.cited_by_count),
      author: surnameOf(asNonEmptyString(asRecord(first?.author)?.display_name)),
      referenceCount: asFiniteNumber(work.referenced_works_count),
    })
  }
  return out
}

export interface ScholarlyRecord {
  openAlexId: string | null
  title: string | null
  publicationYear: number | null
  isRetracted: boolean
  citedByCount: number | null
  /** Chronological, gaps filled -- see `toChronologicalSeries`. */
  countsByYear: YearCount[]
  /** Field-weighted citation impact; 1.0 is the field average. */
  fwci: number | null
  percentile: { min: number; max: number } | null
  openAccess: { isOa: boolean; status: string | null; url: string | null }
  /** Article processing charge as listed by the publisher. */
  apc: { value: number; currency: string } | null
  sourceId: string | null
  sourceName: string | null
  sourceIsInDoaj: boolean
  authors: RecordAuthor[]
  funding: RecordFunding[]
  /** OpenAlex ids of the works this one cites; resolved lazily, in one batch. */
  referencedWorks: string[]
  referencedWorksCount: number | null
  updatedDate: string | null
}

// --- Normalization ---------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Turn OpenAlex's `counts_by_year` into a chronological series with no holes.
 *
 * Two properties of the raw data would otherwise produce a misleading chart:
 * it arrives newest-first, and years with no citations are omitted entirely
 * rather than sent as zero. One real record returns 2026, 2025, 2024, 2021 --
 * rendering that as four adjacent bars invents a history the work does not
 * have. Missing years are filled with zero so the axis stays linear.
 */
export function toChronologicalSeries(raw: unknown): YearCount[] {
  if (!Array.isArray(raw)) return []
  const byYear = new Map<number, number>()
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) continue
    const year = asFiniteNumber(record.year)
    const count = asFiniteNumber(record.cited_by_count)
    if (year === null || count === null) continue
    byYear.set(year, count)
  }
  if (byYear.size === 0) return []

  const years = [...byYear.keys()]
  const series: YearCount[] = []
  for (let year = Math.min(...years); year <= Math.max(...years); year++) {
    series.push({ year, count: byYear.get(year) ?? 0 })
  }
  return series
}

function normalizeAuthors(raw: unknown): RecordAuthor[] {
  if (!Array.isArray(raw)) return []
  const authors: RecordAuthor[] = []
  for (const entry of raw) {
    const authorship = asRecord(entry)
    const author = asRecord(authorship?.author)
    const name = asNonEmptyString(author?.display_name)
    if (!name) continue
    const institutions = Array.isArray(authorship?.institutions)
      ? authorship.institutions
          .map((inst) => asRecord(inst))
          .map((inst) => ({
            name: asNonEmptyString(inst?.display_name) ?? '',
            ror: asNonEmptyString(inst?.ror),
          }))
          .filter((inst) => inst.name !== '')
      : []
    authors.push({ name, orcid: asNonEmptyString(author?.orcid), institutions })
  }
  return authors
}

function normalizeFunding(work: Record<string, unknown>): RecordFunding[] {
  // OpenAlex has carried this under `grants` historically and `funders`/`awards`
  // more recently; records in the wild have either. Read both.
  const out: RecordFunding[] = []
  const seen = new Set<string>()
  const push = (funder: string | null, awardId: string | null) => {
    if (!funder) return
    const key = `${funder} ${awardId ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ funder, awardId })
  }

  for (const source of [work.grants, work.awards, work.funders]) {
    if (!Array.isArray(source)) continue
    for (const entry of source) {
      const record = asRecord(entry)
      if (!record) continue
      push(
        asNonEmptyString(record.funder_display_name) ?? asNonEmptyString(record.display_name),
        asNonEmptyString(record.award_id) ?? asNonEmptyString(record.id),
      )
    }
  }
  return out
}

function normalizeApc(work: Record<string, unknown>): { value: number; currency: string } | null {
  // What was actually paid beats what is listed, when both are present.
  for (const key of ['apc_paid', 'apc_list']) {
    const apc = asRecord(work[key])
    const value = asFiniteNumber(apc?.value)
    if (value === null) continue
    return { value, currency: asNonEmptyString(apc?.currency) ?? 'USD' }
  }
  return null
}

export function normalizeWork(json: unknown): ScholarlyRecord | null {
  const work = asRecord(json)
  if (!work) return null

  const openAccess = asRecord(work.open_access)
  const bestOa = asRecord(work.best_oa_location)
  const primarySource = asRecord(asRecord(work.primary_location)?.source)
  const percentileRaw = asRecord(work.cited_by_percentile_year)
  const percentileMin = asFiniteNumber(percentileRaw?.min)
  const percentileMax = asFiniteNumber(percentileRaw?.max)

  return {
    openAlexId: asNonEmptyString(work.id),
    title: asNonEmptyString(work.display_name) ?? asNonEmptyString(work.title),
    publicationYear: asFiniteNumber(work.publication_year),
    isRetracted: work.is_retracted === true,
    citedByCount: asFiniteNumber(work.cited_by_count),
    countsByYear: toChronologicalSeries(work.counts_by_year),
    fwci: asFiniteNumber(work.fwci),
    percentile: percentileMin !== null && percentileMax !== null ? { min: percentileMin, max: percentileMax } : null,
    openAccess: {
      isOa: openAccess?.is_oa === true,
      status: asNonEmptyString(openAccess?.oa_status),
      // `oa_url` is the canonical field; the best location's PDF is the fallback.
      url:
        asNonEmptyString(openAccess?.oa_url) ??
        asNonEmptyString(bestOa?.pdf_url) ??
        asNonEmptyString(bestOa?.landing_page_url),
    },
    apc: normalizeApc(work),
    sourceId: asNonEmptyString(primarySource?.id),
    sourceName: asNonEmptyString(primarySource?.display_name),
    sourceIsInDoaj: primarySource?.is_in_doaj === true,
    authors: normalizeAuthors(work.authorships),
    funding: normalizeFunding(work),
    referencedWorks: Array.isArray(work.referenced_works)
      ? work.referenced_works.filter((id): id is string => typeof id === 'string')
      : [],
    referencedWorksCount: asFiniteNumber(work.referenced_works_count),
    updatedDate: asNonEmptyString(work.updated_date),
  }
}

export function normalizeSource(json: unknown): JournalMetrics | null {
  const source = asRecord(json)
  const id = asNonEmptyString(source?.id)
  if (!source || !id) return null
  const stats = asRecord(source.summary_stats)
  return {
    sourceId: id,
    name: asNonEmptyString(source.display_name),
    issnL: asNonEmptyString(source.issn_l),
    isInDoaj: source.is_in_doaj === true,
    isOa: source.is_oa === true,
    apcUsd: asFiniteNumber(source.apc_usd),
    twoYearMeanCitedness: asFiniteNumber(stats?.['2yr_mean_citedness']),
    hIndex: asFiniteNumber(stats?.h_index),
    i10Index: asFiniteNumber(stats?.i10_index),
  }
}
