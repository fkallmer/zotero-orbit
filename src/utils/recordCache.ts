/**
 * A small persistent cache for OpenAlex payloads.
 *
 * These are display-only enrichments -- FWCI, open-access status, journal
 * metrics, ORCIDs. They deliberately do *not* go into an item's Extra field:
 * that field syncs, and writing kilobytes of metadata per item into a shared
 * group library would push the churn onto everyone else in the group. A local
 * cache keeps the data where it is useful and nowhere else.
 *
 * `ignoreStore` keeps its state in a preference, but that holds a handful of
 * counters. This holds records, so it lives in a file in the data directory.
 *
 * An in-memory map sits in front, so scrolling the item list never waits on
 * disk, and writes are debounced rather than issued per hit.
 */

import { debugLog } from './log'

const CACHE_FILE = 'citationtally-cache.json'
const CACHE_VERSION = 1

/** Entries older than this are refetched. OpenAlex counts move slowly. */
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** Hard ceiling on entries; the oldest go first once it is reached. */
const MAX_ENTRIES = 2000

/** How long writes are batched before hitting disk. */
const FLUSH_DELAY_MS = 5000

interface CacheEntry<T> {
  /** Epoch milliseconds when this was stored. */
  storedAt: number
  value: T
}

interface CacheFile {
  version: number
  entries: Record<string, CacheEntry<unknown>>
}

let memory = new Map<string, CacheEntry<unknown>>()
let loaded = false
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function cachePath(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, CACHE_FILE)
}

/**
 * Drop expired entries, then the oldest ones if still over the ceiling.
 * Returns the number removed.
 */
function evict(ttlMs: number, now: number): number {
  let removed = 0
  for (const [key, entry] of memory) {
    if (now - entry.storedAt > ttlMs) {
      memory.delete(key)
      removed++
    }
  }
  if (memory.size > MAX_ENTRIES) {
    const byAge = [...memory.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)
    for (const [key] of byAge.slice(0, memory.size - MAX_ENTRIES)) {
      memory.delete(key)
      removed++
    }
  }
  return removed
}

export async function loadCache(ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
  if (loaded) return
  loaded = true
  const path = cachePath()
  try {
    if (!(await IOUtils.exists(path))) return
    // The typings widen this to string | Uint8Array | void; with a path and a
    // charset it is always a string.
    const raw = (await Zotero.File.getContentsAsync(path, 'UTF-8')) as string
    const parsed = JSON.parse(raw) as CacheFile
    if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== 'object') {
      // A format change is not worth migrating for a cache; start clean.
      debugLog('Citation debug - Cache version mismatch, starting empty')
      return
    }
    memory = new Map(Object.entries(parsed.entries))
    const dropped = evict(ttlMs, Date.now())
    debugLog(`Citation debug - Cache loaded: ${memory.size} entries, ${dropped} dropped`)
  } catch (err) {
    // A corrupt cache must never block the plugin; it is all refetchable.
    debugLog('Citation debug - Cache unreadable, starting empty:', err)
    memory = new Map()
  }
}

async function flush(): Promise<void> {
  flushTimer = null
  if (!dirty) return
  dirty = false
  const payload: CacheFile = { version: CACHE_VERSION, entries: Object.fromEntries(memory) }
  try {
    await Zotero.File.putContentsAsync(cachePath(), JSON.stringify(payload))
  } catch (err) {
    // Losing the cache costs a refetch, nothing more. Do not surface it.
    debugLog('Citation debug - Could not write cache:', err)
  }
}

function scheduleFlush(): void {
  dirty = true
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS)
}

export function readCache<T>(key: string, ttlMs: number = DEFAULT_TTL_MS): T | null {
  const entry = memory.get(key)
  if (!entry) return null
  if (Date.now() - entry.storedAt > ttlMs) {
    memory.delete(key)
    scheduleFlush()
    return null
  }
  return entry.value as T
}

export function writeCache<T>(key: string, value: T): void {
  memory.set(key, { storedAt: Date.now(), value })
  if (memory.size > MAX_ENTRIES) evict(DEFAULT_TTL_MS, Date.now())
  scheduleFlush()
}

export function dropCache(key: string): void {
  if (memory.delete(key)) scheduleFlush()
}

/** Write pending changes immediately. Called on shutdown. */
export async function flushCache(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flush()
}

/** Test seam: reset module state without touching disk. */
export function __resetCacheForTests(): void {
  memory = new Map()
  loaded = false
  dirty = false
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

export const CACHE_TUNING = { DEFAULT_TTL_MS, MAX_ENTRIES, FLUSH_DELAY_MS } as const
