/**
 * The shapes the collection analysis is built from, in one place.
 *
 * Several modules are written against these at the same time -- the network
 * builder, the clustering, the gaps panel, the exports, the graph -- so they
 * are fixed here first and changed only on purpose. Types only; nothing here
 * runs.
 *
 * Every field that can sit in the on-disk cache is either present from the
 * first version of its shape or optional, so an older cache entry reads as
 * "not known yet" rather than as a crash. See utils/recordCache.
 */

/** A bare OpenAlex work id: 'W2741809807', without the https://openalex.org/ prefix. */
export type OpenAlexId = string

/** How sure the library match is: by identifier, or by Cita's guarded title rule. */
export type MatchConfidence = 'exact' | 'probable'

export interface MatchResult {
  itemID: number
  confidence: MatchConfidence
  via: 'doi' | 'arxiv' | 'pmid' | 'title'
}

/** Anything that can be matched against the library. Every field optional for cache compatibility. */
export interface MatchableWork {
  doi?: string | null
  arxiv?: string | null
  pmid?: string | null
  title?: string | null
  year?: number | null
  /** Display names as delivered ("Given Family" or "Family, Given"). */
  authors?: readonly string[] | null
}

export type NetworkScope =
  | { kind: 'collection'; collectionID: number; libraryID: number; name: string }
  | { kind: 'library'; libraryID: number; name: string }

/**
 * What to do when a scope holds more items than `networkSeedLimit`.
 *
 * - `cap`: analyse the first N (items with an identifier first, then the most
 *   recently added) and say so.
 * - `warn`: ask first, with the request estimate; analyse all on yes.
 * - `all`: analyse all without asking.
 */
export type SeedPolicy = 'cap' | 'warn' | 'all'

/** A seed item as OpenAlex knows it. */
export interface SeedWork {
  itemID: number
  openAlexId: OpenAlexId
  doi: string | null
  title: string
  year: number | null
  citedByCount: number | null
  referenceCount: number | null
  authors: string[]
  referencedWorks: OpenAlexId[]
  primaryTopic: { id: string; name: string } | null
}

/** A non-seed work connected to at least MIN_SHARED seeds. */
export interface NetworkWork {
  openAlexId: OpenAlexId
  doi: string | null
  title: string
  year: number | null
  citedByCount: number | null
  referenceCount: number | null
  authors: string[]
  /** 'reference': cited by these seeds. 'citing': cites these seeds. */
  direction: 'reference' | 'citing'
  seeds: OpenAlexId[]
  match: MatchResult | null
}

/** A work the library does not hold, ranked by how much the seeds lean on it. */
export interface Gap extends NetworkWork {
  match: null
  score: number
  /** 1-based, within its direction. */
  rank: number
}

/** Bibliographic coupling between two seeds. Undirected; `a < b` lexically. */
export interface CouplingEdge {
  a: OpenAlexId
  b: OpenAlexId
  shared: number
}

/** A citation, citer -> cited, with both ends present in the network. */
export interface CitationEdge {
  from: OpenAlexId
  to: OpenAlexId
}

export interface Cluster {
  /** 0-based, ordered by size, largest first. */
  id: number
  label: string
  /** Share of members carrying the label topic, 0..1. */
  topicShare: number
  members: OpenAlexId[]
}

export interface RequestEstimate {
  listRequests: number
  /** Single-entity GETs, which OpenAlex does not charge for. */
  singleRequests: number
  usd: number
  /** 0.10 without an API key, 1.00 with one. */
  dailyBudgetUsd: number
  shareOfDailyBudget: number
}

export interface NetworkCoverage {
  itemsInScope: number
  analysed: number
  capped: boolean
  resolved: number
  unresolved: { itemID: number; reason: 'no-identifier' | 'not-found' }[]
  citingIncluded: boolean
  citingTruncated: boolean
  requestsMade: number
}

export interface CollectionNetwork {
  version: 1
  scope: NetworkScope
  builtAt: number
  seeds: SeedWork[]
  works: NetworkWork[]
  coupling: CouplingEdge[]
  citations: CitationEdge[]
  clusters: Cluster[]
  clusterOf: Record<OpenAlexId, number | null>
  gaps: Gap[]
  probable: NetworkWork[]
  coverage: NetworkCoverage
}

export type NetworkStep = 'seeds' | 'lookup' | 'references' | 'citing' | 'library' | 'clusters'

export interface BuildProgress {
  step: NetworkStep
  done: number
  total: number
}

export interface BuildOptions {
  force?: boolean
  includeCiting: boolean
  signal?: AbortSignal
  onProgress?: (progress: BuildProgress) => void
}
