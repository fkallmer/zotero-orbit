/**
 * The field-weighted impact column's own store.
 *
 * The column reads a value per visible row and cannot fetch, so whatever it
 * shows has to already be on disk. `recordCache` is the wrong home for that: it
 * expires entries after two weeks and evicts past two thousand, which is right
 * for the large OpenAlex payloads it holds and wrong for a single float that a
 * user sorts a library by. A column that empties itself after a fortnight, or
 * that covers the first two thousand items of a larger library, is a column
 * whose sort order lies.
 *
 * So this keeps only what the column needs -- a DOI and a number -- with no TTL
 * and no ceiling. Ten thousand items cost a few hundred kilobytes. The full
 * records stay in `recordCache`, where expiry is correct.
 *
 * Not the Extra field, for the reason `recordCache` gives: Extra syncs, and a
 * derived number does not belong in everyone else's copy of a group library.
 *
 * Staleness here decides only whether a refresh run *picks an item up*. A value
 * past its cutoff is still displayed -- a slightly old FWCI is worth more to a
 * reader than a blank cell.
 *
 * Keep this module free of runtime Zotero dependencies.
 */

import { parseLastCheckedInstant } from './temporalParse.ts'

/** Bumped whenever stored entries must be discarded rather than reinterpreted. */
export const FWCI_STORE_VERSION = 1

export interface FwciRecord {
  /**
   * The value, or null when OpenAlex holds the work and has no FWCI for it.
   *
   * A null is stored rather than left absent so a refresh does not ask again on
   * every run. Recent papers have no FWCI yet, and they are exactly the ones a
   * user re-runs a refresh hoping to fill.
   */
  fwci: number | null
  /** ISO instant of the answer, whether it carried a value or not. */
  checkedAt: string
}

/** lookup DOI, lower-cased -> record. */
export type FwciEntries = Record<string, FwciRecord>

export interface FwciStore {
  version: number
  entries: FwciEntries
}

export function emptyFwciStore(): FwciStore {
  return { version: FWCI_STORE_VERSION, entries: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceEntries(raw: unknown): FwciEntries {
  if (!isRecord(raw)) return {}
  const entries: FwciEntries = {}
  for (const [doi, record] of Object.entries(raw)) {
    if (doi === '' || !isRecord(record)) continue
    const { fwci, checkedAt } = record
    // `null` is a meaningful value here, so it passes; anything non-numeric does not.
    if (fwci !== null && (typeof fwci !== 'number' || !Number.isFinite(fwci))) continue
    if (typeof checkedAt !== 'string' || checkedAt === '') continue
    entries[doi.toLowerCase()] = { fwci, checkedAt }
  }
  return entries
}

/**
 * Read the stored file.
 *
 * Corrupt or unparseable data reads as empty. Every entry is refetchable, so
 * the cost of failing this way is one refresh run, and the alternative -- a
 * throw on startup over a display-only number -- is worse.
 */
export function parseFwciStore(raw: string | undefined | null): FwciStore {
  if (!raw) return emptyFwciStore()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyFwciStore()
  }

  if (!isRecord(parsed)) return emptyFwciStore()
  if (parsed.version !== FWCI_STORE_VERSION) return emptyFwciStore()
  return { version: FWCI_STORE_VERSION, entries: coerceEntries(parsed.entries) }
}

export function serializeFwciStore(store: FwciStore): string {
  return JSON.stringify({ version: FWCI_STORE_VERSION, entries: store.entries })
}

/** Look up one record, or `undefined`. */
export function getFwciRecord(store: FwciStore, lookupDoi: string): FwciRecord | undefined {
  return store.entries[lookupDoi.toLowerCase()]
}

/** Write one record in place. Mutates: a library-wide refresh writes thousands. */
export function putFwciRecord(store: FwciStore, lookupDoi: string, fwci: number | null, now: Temporal.Instant): void {
  store.entries[lookupDoi.toLowerCase()] = { fwci, checkedAt: now.toString() }
}

/**
 * Whether a refresh run should ask about this DOI.
 *
 * An unparseable or missing timestamp counts as stale rather than fresh: a
 * record we cannot date is one we cannot vouch for, and re-asking costs a
 * fiftieth of a request.
 */
export function needsFwciRefresh(record: FwciRecord | undefined, now: Temporal.Instant, maxAgeMonths: number): boolean {
  if (!record) return true
  const checkedAt = parseLastCheckedInstant(record.checkedAt)
  if (checkedAt === null) return true
  // Months as 30 days. The cutoff is a user-facing coarse choice (3, 6, 12,
  // 24), not a calendar calculation, and calendar months would make the
  // threshold depend on which month the last check happened to fall in.
  return now.since(checkedAt).total({ unit: 'day' }) > maxAgeMonths * 30
}

/** Records held, for the progress line and the log. */
export function fwciStoreSize(store: FwciStore): number {
  return Object.keys(store.entries).length
}
