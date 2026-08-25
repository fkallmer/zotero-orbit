/**
 * The loaded FWCI store, and the only place that touches its file.
 *
 * Split from `fwciUpdate` on purpose. The column and the citation-count path
 * both need to read and write these values, and both live in `citationTally`;
 * the fetching lives in `fwciUpdate`, which needs `citationTally`'s rate
 * limiter and fetch wrapper. Putting the store here -- depending on `utils` and
 * nothing else -- is what keeps `citationTally -> fwciUpdate -> citationTally`
 * from being a cycle.
 *
 * Writes are debounced, like `recordCache`: a library-wide refresh writes a few
 * thousand records in a burst, and each one is not worth a disk round trip.
 */

import {
  emptyFwciStore,
  fwciStoreSize,
  getFwciRecord,
  needsFwciRefresh,
  parseFwciStore,
  putFwciRecord,
  serializeFwciStore,
} from '../utils/fwciStore.ts'
import { debugLog } from '../utils/log'
import { getPref } from '../utils/prefs'

import type { FwciStore } from '../utils/fwciStore.ts'

const STORE_FILE = 'orbit-fwci.json'
/** How long writes are batched before hitting disk. Matches recordCache. */
const FLUSH_DELAY_MS = 5000
/** Used when the preference is missing or unreadable; the shipped default. */
const DEFAULT_CUTOFF_MONTHS = 6

let store: FwciStore = emptyFwciStore()
let loaded = false
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function storePath(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, STORE_FILE)
}

export async function loadFwciStore(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const path = storePath()
    if (!(await IOUtils.exists(path))) return
    // The typings widen this to string | Uint8Array | void; with a path and a
    // charset it is always a string.
    const raw = (await Zotero.File.getContentsAsync(path, 'UTF-8')) as string
    store = parseFwciStore(raw)
    debugLog(`Citation debug - FWCI store loaded: ${fwciStoreSize(store)} records`)
  } catch (err) {
    // Display-only values; an unreadable file must not hold up startup.
    debugLog('Citation debug - FWCI store unreadable, starting empty:', err)
    store = emptyFwciStore()
  }
}

async function flush(): Promise<void> {
  flushTimer = null
  if (!dirty) return
  dirty = false
  try {
    await Zotero.File.putContentsAsync(storePath(), serializeFwciStore(store))
  } catch (err) {
    // Losing the file costs one refresh run. Do not surface it.
    debugLog('Citation debug - Could not write FWCI store:', err)
  }
}

function scheduleFlush(): void {
  dirty = true
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS)
}

/** Write pending changes immediately. Called on shutdown. */
export async function flushFwciStore(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flush()
}

/**
 * The value for a DOI, or null when there is none stored.
 *
 * Read per visible row while the item tree redraws, so it stays a map lookup:
 * no dating, no eviction, no logging. Staleness is a question for a refresh
 * run, not for drawing a cell.
 */
export function readFwci(lookupDoi: string): number | null {
  const record = getFwciRecord(store, lookupDoi)
  return record?.fwci ?? null
}

/** Record an answer, including the absence of a value. */
export function recordFwci(lookupDoi: string, fwci: number | null): void {
  putFwciRecord(store, lookupDoi, fwci, Temporal.Now.instant())
  scheduleFlush()
}

/** How old a record may be before a refresh run picks it up again. */
function cutoffMonths(): number {
  const raw = Number(getPref('autoUpdateCutoff'))
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CUTOFF_MONTHS
}

/** Whether a refresh run should ask OpenAlex about this DOI. */
export function shouldRefreshFwci(lookupDoi: string, now: Temporal.Instant): boolean {
  return needsFwciRefresh(getFwciRecord(store, lookupDoi), now, cutoffMonths())
}

/** Records held. For progress lines and the log. */
export function storedFwciCount(): number {
  return fwciStoreSize(store)
}
