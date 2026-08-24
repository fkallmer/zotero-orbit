import { version } from '../../package.json'
import { fetchWithDeadline } from '../utils/abort'
import { isErrorNamed } from '../utils/errors'
import {
  CITATION_KEY_PATTERN,
  escapeRegExp,
  formatCitationLine,
  insertBeforeMatch,
  stripCitationLines,
} from '../utils/extraField'
import { classifyHttpStatus, classifyThrown, parseCitationCount } from '../utils/httpOutcome'
import {
  encodeIdentifierPath,
  extractArxivId,
  extractArxivIdFromUrl,
  normalizeDoi,
  stripArxivVersion,
} from '../utils/identifiers'
import {
  IGNORE_STORE_VERSION,
  parseIgnoreStore,
  serializeIgnoreStore,
  shouldRetryIgnoredItem,
} from '../utils/ignoreStore'
import { getLocaleID, getString } from '../utils/locale'
import { debugLog } from '../utils/log'
import { reserveSlot } from '../utils/pacing'
import { getPref, setPref } from '../utils/prefs'
import { readCache, writeCache } from '../utils/recordCache'

import { effectiveDatabases, semanticScholarUnavailableResult } from './citationTypes'
import { notifySemanticScholarUnavailable } from './degradedNotice'
import {
  buildScholarUrl,
  extractResultTitle,
  GOOGLE_SCHOLAR_DATABASE,
  hasRecaptcha,
  parseScholarCount,
  TITLE_MATCH_THRESHOLD,
  titleSimilarity,
} from './googleScholarClient.core'
import { getIgnorePolicy } from './ignorePolicy'
import {
  buildWorkUrl,
  normalizeWork,
  OPENALEX_DATABASE,
  openAlexRecordCacheKey,
  toLookupDoi,
  WORK_FULL_SELECT,
} from './openAlexClient.core'
import { getSemanticScholarClient, isSemanticScholarAvailable } from './semanticScholarClient'

import type { ItemIdentifier, LookupResult, LookupStatus } from './citationTypes'
import type { ScholarlyRecord } from './openAlexClient.core'
import type { IgnoreEntries, IgnoreRecord } from '../utils/ignoreStore'

// Semantic Scholar uses its own scheduler and has no entry in this millisecond table.
const DEFAULT_RATE_LIMITS: Record<string, number> = {
  crossref: 1000,
  inspire: 1000,
  openalex: 200,
  // Scholar has no published limit; it just starts serving CAPTCHAs. This is
  // the midpoint of the random 1-5s wait the standalone GSCC plugin settled on.
  googlescholar: 3000,
}

const MAX_RATE_LIMIT_MULTIPLIER = 10

/** Engage budget pacing only below this share of a provider's allowance. */
const BUDGET_PACING_THRESHOLD = 0.2

/** Fallback when the provider reports a remaining count but no total. */
const BUDGET_PACING_MIN_REMAINING = 100

/** Ceiling on budget-derived spacing. Beyond this the cure is worse. */
const MAX_BUDGET_SPACING_MS = 5000

/** Deadline for a single Crossref or INSPIRE request. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Identifies the client to Crossref and INSPIRE, matching the Semantic Scholar
 * client's format. Crossref routes requests carrying a contact address into its
 * "polite pool", which is better resourced than the anonymous one; the project
 * URL serves as that contact.
 */
const USER_AGENT = `Orbit/${version} (+https://github.com/daeh/zotero-zotero-orbit; mailto:dev@daeh.info)`

/** Headers every provider request sends. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = { 'User-Agent': USER_AGENT }

/**
 * Floors on request spacing, in milliseconds.
 *
 * `rateLimits` is a user-editable JSON pref, so a value below the provider's
 * documented limit is clamped rather than honored. INSPIRE documents 15
 * requests per 5 seconds, and asks for at least a 5s pause after a 429 -- the
 * adaptive multiplier alone could retry sooner than that.
 */
const MIN_RATE_LIMITS: Record<string, number> = {
  crossref: 1000,
  inspire: 350,
  // OpenAlex documents 10 requests/second for the polite pool. Its responses
  // also carry an x-ratelimit-remaining budget (1000 per window at the time of
  // writing), so pacing matters even though the per-second ceiling is high.
  openalex: 100,
  // Below roughly a second, Scholar reliably trips its bot detection.
  googlescholar: 1000,
}

/** Minimum backoff after a 429, per provider. */
const MIN_BACKOFF_AFTER_429_MS: Record<string, number> = {
  inspire: 5000,
  openalex: 5000,
  // A CAPTCHA is not a timed rate limit -- backing off briefly and retrying
  // just burns the next request too.
  googlescholar: 60_000,
}

/**
 * Aborted when the plugin shuts down, so an in-flight lookup does not outlive
 * it. Only constructed when the runtime actually has working abort primitives:
 * in degraded mode `AbortController` is a throwing tripwire stub, and Crossref
 * and INSPIRE must keep working there.
 */
let shutdownController: AbortController | null = null

function requestCanAbort(): boolean {
  // The bridge verifies AbortController and DOMException together and reports
  // the result as `semanticScholarAvailable`; that flag is really "the abort
  // primitives are real", which is what matters here too.
  return isSemanticScholarAvailable()
}

function requestShutdownSignal(): AbortSignal | undefined {
  if (!requestCanAbort()) return undefined
  shutdownController ??= new AbortController()
  return shutdownController.signal
}

/**
 * Cancel every in-flight provider request.
 *
 * Safe in degraded mode: the controller is only ever constructed when the
 * runtime has real abort primitives, so if it is null there is nothing to
 * cancel *and* `DOMException` must not be constructed -- it is a throwing
 * tripwire stub there. The early return makes that explicit rather than leaving
 * it to optional-chaining argument-evaluation order.
 */
export function abortInFlightLookups(): void {
  const controller = shutdownController
  if (controller === null) return
  shutdownController = null
  controller.abort(new DOMException('Plugin shutting down', 'AbortError'))
}

function lookupFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetchWithDeadline(url, init, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    shutdownSignal: requestShutdownSignal(),
    canAbort: requestCanAbort(),
  })
}

/** Process-wide item-notifier registration. */
let notifierID: string | null = null

// Adaptive rate limiting state
class RateLimitManager {
  private static multipliers: Record<string, number> = {}
  /** Earliest monotonic time the next request to each service may depart. */
  private static nextAvailable: Record<string, number | undefined> = {}
  /** Spacing derived from a provider-reported budget; see `noteBudget`. */
  private static budgetFloors: Record<string, number> = {}

  static getDelay(database: string): number {
    const baseLimits = getPref('rateLimits')
    let baseDelay: number

    if (baseLimits && typeof baseLimits === 'string') {
      try {
        const parsed = JSON.parse(baseLimits) as Record<string, number>
        baseDelay = parsed[database] || DEFAULT_RATE_LIMITS[database] || 1000
      } catch {
        baseDelay = DEFAULT_RATE_LIMITS[database] || 1000
      }
    } else {
      baseDelay = DEFAULT_RATE_LIMITS[database] || 1000
    }

    const multiplier = this.multipliers[database] || 1
    // A user-set `rateLimits` value below the provider's documented limit is
    // clamped, not honored.
    const floor = MIN_RATE_LIMITS[database] ?? 0
    const budgetFloor = this.budgetFloors[database] ?? 0
    return Math.max(baseDelay * multiplier, floor, budgetFloor)
  }

  static handleRateLimit(database: string): void {
    const currentMultiplier = this.multipliers[database] || 1
    const newMultiplier = Math.min(currentMultiplier * 1.5, MAX_RATE_LIMIT_MULTIPLIER)
    this.multipliers[database] = newMultiplier

    // Some providers document a minimum pause after a 429 that the multiplier
    // alone would not reach. Push the next departure out to satisfy it.
    const minPause = MIN_BACKOFF_AFTER_429_MS[database]
    if (minPause !== undefined) {
      const now = performance ? performance.now() : Temporal.Now.instant().epochMilliseconds
      const current = this.nextAvailable[database] ?? now
      this.nextAvailable[database] = Math.max(current, now + minPause)
    }

    ztoolkit.log(`Rate limit detected for ${database}: increasing multiplier to ${newMultiplier.toFixed(1)}x`)
  }

  /**
   * Pace against a provider-reported request budget.
   *
   * OpenAlex returns `x-ratelimit-remaining` and `x-ratelimit-reset` (seconds)
   * on every response. Ignoring them means running full speed into a 429 and
   * only then backing off. Spreading what is left over the time until reset
   * keeps a large library scan inside the budget instead.
   *
   * Only ever slows down: the computed spacing is applied as a floor, never as
   * permission to go faster than the configured limit.
   */
  static noteBudget(database: string, response: Response): void {
    const remainingHeader = response.headers.get('x-ratelimit-remaining')
    const resetHeader = response.headers.get('x-ratelimit-reset')
    if (remainingHeader === null || resetHeader === null) return

    const remaining = Number.parseInt(remainingHeader, 10)
    const resetSeconds = Number.parseInt(resetHeader, 10)
    if (!Number.isFinite(remaining) || !Number.isFinite(resetSeconds) || resetSeconds <= 0) return

    if (remaining <= 0) {
      // Budget spent. Nothing to do but wait out the window.
      const now = performance ? performance.now() : Temporal.Now.instant().epochMilliseconds
      const current = this.nextAvailable[database] ?? now
      this.nextAvailable[database] = Math.max(current, now + resetSeconds * 1000)
      ztoolkit.log(`Budget exhausted for ${database}: pausing ${resetSeconds}s until reset`)
      return
    }

    // Only step in once the budget is genuinely tight. Spreading the remaining
    // allowance evenly across the whole reset window sounds fair and is
    // useless: with 956 of 1000 credits left and hours until reset it computed
    // a 10-second gap between requests, which makes the item pane unusable
    // while nothing is actually scarce. Below the threshold the arithmetic is
    // worth having; above it the configured spacing already governs.
    const limitHeader = response.headers.get('x-ratelimit-limit')
    const limit = limitHeader === null ? null : Number.parseInt(limitHeader, 10)
    const tight =
      Number.isFinite(limit) && limit !== null && limit > 0
        ? remaining / limit <= BUDGET_PACING_THRESHOLD
        : remaining <= BUDGET_PACING_MIN_REMAINING
    if (!tight) {
      delete this.budgetFloors[database]
      return
    }

    const fairShareMs = (resetSeconds * 1000) / remaining
    // Compare against the configured spacing without the budget floor folded
    // in, or each call would ratchet against its own previous result.
    const previousFloor = this.budgetFloors[database]
    delete this.budgetFloors[database]
    const configured = this.getDelay(database)
    if (previousFloor !== undefined) this.budgetFloors[database] = previousFloor
    if (fairShareMs > configured) {
      // Capped: past this point the pacing is worse for the user than the 429
      // it avoids.
      this.budgetFloors[database] = Math.min(fairShareMs, MAX_BUDGET_SPACING_MS)
      ztoolkit.log(
        `Budget pacing for ${database}: ${remaining} left before reset, spacing to ${Math.round(fairShareMs)}ms`,
      )
    } else {
      delete this.budgetFloors[database]
    }
  }

  static handleSuccess(database: string): void {
    const currentMultiplier = this.multipliers[database] || 1
    if (currentMultiplier > 1) {
      // Gradually decrease multiplier on success
      const newMultiplier = Math.max(currentMultiplier * 0.9, 1)
      this.multipliers[database] = newMultiplier

      if (newMultiplier < currentMultiplier) {
        ztoolkit.log(`Success for ${database}: decreasing multiplier to ${newMultiplier.toFixed(1)}x`)
      }
    }
  }

  static async waitForRateLimit(database: string): Promise<void> {
    const delay = this.getDelay(database)
    // A separate sentinel avoids delaying the first request when the monotonic clock is near zero.
    const monotonicNow = () => (performance ? performance.now() : Temporal.Now.instant().epochMilliseconds)

    // The slot is reserved *before* awaiting. Reading a timestamp, sleeping,
    // then writing it let two concurrent callers observe the same value and
    // depart together -- which the manual and automatic queues can both do.
    const { waitMs, nextAvailableMs } = reserveSlot(this.nextAvailable[database], monotonicNow(), delay)
    this.nextAvailable[database] = nextAvailableMs

    if (waitMs > 0) {
      debugLog(`Rate limiting ${database}: waiting ${waitMs}ms (${this.multipliers[database] || 1}x multiplier)`)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
}

// Citation source operations

// Ignored items tracking. The on-disk shape, its migration, and the retry rule
// all live in `utils/ignoreStore`, shared with `citationAutoupdate`.
class IgnoredItemsManager {
  private static memoryCache = new Map<number, { databases: string[] }>() // Session-only cache for no_identifier

  private static loadPersistentData(): IgnoreEntries {
    return parseIgnoreStore(getPref('ignoredItems')).entries
  }

  private static savePersistentData(entries: IgnoreEntries): void {
    setPref('ignoredItems', serializeIgnoreStore({ version: IGNORE_STORE_VERSION, entries }))
  }

  private static shouldRetryItem(record: IgnoreRecord): boolean {
    return shouldRetryIgnoredItem(record, Temporal.Now.instant())
  }

  static markAsIgnored(
    itemId: number,
    database: string,
    // `api_error` used to be accepted here and written persistently. It no
    // longer reaches this call (see `getIgnorePolicy`), so it is gone from the
    // type rather than left as a dead branch.
    reason: 'not_found' | 'no_identifier',
    persistent = true,
  ): void {
    if (reason === 'no_identifier') {
      // Store in memory cache only for missing identifiers
      const memoryInfo = this.memoryCache.get(itemId) || { databases: [] }
      if (!memoryInfo.databases.includes(database)) {
        memoryInfo.databases.push(database)
      }
      this.memoryCache.set(itemId, memoryInfo)
      return
    }

    // Only an authoritative not-found is stored persistently.
    if (persistent && reason === 'not_found') {
      const data = this.loadPersistentData()
      const itemKey = itemId.toString()

      // Initialize database if not exists
      if (!data[database]) {
        data[database] = {}
      }

      // Initialize or update item data
      if (!data[database][itemKey]) {
        data[database][itemKey] = {
          count: 1,
          lastChecked: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
        }
      } else {
        data[database][itemKey].count++
        data[database][itemKey].lastChecked = Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
      }

      this.savePersistentData(data)
    }
  }

  static isIgnored(itemId: number, database: string, autoUpdateOnly = false): boolean {
    // If this is manual update, never skip
    if (!autoUpdateOnly) {
      return false
    }

    // Check memory cache first (for no_identifier items)
    if (this.memoryCache.has(itemId)) {
      return this.memoryCache.get(itemId)!.databases.includes(database)
    }

    // Check persistent storage for not_found items
    const data = this.loadPersistentData()
    const itemKey = itemId.toString()

    if (data[database]?.[itemKey]) {
      const itemData = data[database][itemKey]
      // Check if enough time has passed to retry based on failure count
      return !this.shouldRetryItem(itemData)
    }

    return false
  }

  static clearIgnoredItem(itemId: number, database?: string): void {
    // Clear from memory cache
    if (database) {
      const memoryInfo = this.memoryCache.get(itemId)
      if (memoryInfo) {
        memoryInfo.databases = memoryInfo.databases.filter((db) => db !== database)
        if (memoryInfo.databases.length === 0) {
          this.memoryCache.delete(itemId)
        }
      }
    } else {
      this.memoryCache.delete(itemId)
    }

    // Clear from persistent storage
    const data = this.loadPersistentData()
    const itemKey = itemId.toString()

    if (database) {
      // Clear specific database-item combination
      if (data[database]?.[itemKey]) {
        delete data[database][itemKey]
        // Clean up empty database objects
        if (Object.keys(data[database]).length === 0) {
          delete data[database]
        }
        this.savePersistentData(data)
      }
    } else {
      // Clear item from all databases
      let modified = false
      for (const dbKey of Object.keys(data)) {
        if (data[dbKey][itemKey]) {
          delete data[dbKey][itemKey]
          modified = true
          // Clean up empty database objects
          if (Object.keys(data[dbKey]).length === 0) {
            delete data[dbKey]
          }
        }
      }
      if (modified) {
        this.savePersistentData(data)
      }
    }
  }

  static cleanupNonExistentItems(): void {
    const data = this.loadPersistentData()
    let modified = false

    for (const database of Object.keys(data)) {
      for (const itemKey of Object.keys(data[database])) {
        const itemId = parseInt(itemKey)
        try {
          const item = Zotero.Items.get(itemId)
          if (!item || item.deleted) {
            delete data[database][itemKey]
            modified = true
          }
        } catch (e) {
          // Item doesn't exist, remove it
          delete data[database][itemKey]
          modified = true
        }
      }

      // Clean up empty database objects
      if (Object.keys(data[database]).length === 0) {
        delete data[database]
        modified = true
      }
    }

    if (modified) {
      this.savePersistentData(data)
      debugLog('Citation debug - Cleaned up ignored items for non-existent library items')
    }
  }
}

// Schedule monthly cleanup
let cleanupTimer: NodeJS.Timeout | null = null
let cleanupStartupTimer: NodeJS.Timeout | null = null

function scheduleMonthlyCleanup() {
  cancelMonthlyCleanup()

  // Run cleanup every 30 days (30 * 24 * 60 * 60 * 1000 ms)
  cleanupTimer = setInterval(
    () => {
      void IgnoredItemsManager.cleanupNonExistentItems()
    },
    30 * 24 * 60 * 60 * 1000,
  )

  // Also run cleanup on startup
  cleanupStartupTimer = setTimeout(() => {
    cleanupStartupTimer = null
    void IgnoredItemsManager.cleanupNonExistentItems()
  }, 5000) // Delay 5 seconds after startup
}

/** Without this, the timers survive a disable and go on mutating the ignore cache. */
function cancelMonthlyCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
  if (cleanupStartupTimer) {
    clearTimeout(cleanupStartupTimer)
    cleanupStartupTimer = null
  }
}

// Operation display names (lazy-loaded to avoid startup issues)
export function getOperationName(key: string): string {
  const nameMap = {
    crossref: 'database-crossref',
    googlescholar: 'database-googlescholar',
    inspire: 'database-inspire',
    openalex: 'database-openalex',
    semanticscholar: 'database-semanticscholar',
  } as const
  const fluentId = nameMap[key as keyof typeof nameMap]
  return fluentId ? getString(fluentId) : key
}

/**
 * Database colors, dark theme.
 *
 * Not chosen by eye. The previous set failed the `dataviz` validator: in light
 * mode Semantic Scholar's red and OpenAlex's amber sat at CVD deltaE 3.2
 * (deutan) and 12.7 for normal vision -- below the floor of 15, so even
 * full-colour readers could not reliably separate them -- and Crossref's black
 * had no chroma, reading as grey. These are stepped from that skill's
 * reference ramps and pass every check in both modes on the adjacent pairlist.
 *
 * No five-colour set passes the *all-pairs* list, the reference palette
 * included. Two things make that acceptable here: DATABASE_DISPLAY_ORDER fixes
 * the on-screen adjacency to the one that was validated, and every source is
 * always rendered with its name. Colour is a secondary cue, never the sole
 * carrier of identity.
 */
const databaseColorsDark: Record<string, string> = {
  crossref: '#3987e5', // Blue
  inspire: '#199e70', // Aqua
  openalex: '#c98500', // Yellow
  googlescholar: '#9085e9', // Violet
  semanticscholar: '#e66767', // Red
}

/** Database colors, light theme. Separately stepped -- see the dark set above. */
const databaseColorsLight: Record<string, string> = {
  crossref: '#2a78d6', // Blue
  inspire: '#1baf7a', // Aqua
  openalex: '#eda100', // Yellow
  googlescholar: '#4a3aa7', // Violet
  semanticscholar: '#e34948', // Red
}

/**
 * The order sources are drawn in, everywhere the plugin shows more than one.
 *
 * Fixed on purpose: the palette above was validated for *these* neighbours.
 * `databaseOrder` is a user preference and governs which sources are queried
 * and in what sequence, but not how they are painted next to each other.
 */
export const DATABASE_DISPLAY_ORDER = ['crossref', 'inspire', 'openalex', 'googlescholar', 'semanticscholar'] as const

/**
 * Detect if Zotero is using a light color scheme
 * @returns true if light mode, false if dark mode
 */
function isLightMode(): boolean {
  try {
    // Try Zotero's theme preference first (Zotero 7+)
    const zoteroTheme = Zotero.Prefs.get('theme', true) as string | undefined

    if (zoteroTheme === 'light') {
      return true
    }
    if (zoteroTheme === 'dark') {
      return false
    }

    // If theme is 'system' or undefined, check system preference
    const win = Zotero.getMainWindow()
    if (win) {
      const mediaQuery = win.matchMedia?.('(prefers-color-scheme: dark)')
      if (mediaQuery) {
        return !mediaQuery.matches
      }

      // Fallback: check document background color
      const docEl = win.document?.documentElement
      if (docEl) {
        const bgColor = win.getComputedStyle?.(docEl)?.backgroundColor
        if (bgColor) {
          // Parse RGB and check if it's dark (low luminance)
          const rgb = bgColor.match(/\d+/g)
          if (rgb && rgb.length >= 3) {
            const luminance = (0.299 * parseInt(rgb[0]) + 0.587 * parseInt(rgb[1]) + 0.114 * parseInt(rgb[2])) / 255
            return luminance > 0.5 // Light if luminance > 0.5
          }
        }
      }
    }
  } catch (e) {
    ztoolkit.log(`Theme detection error: ${String(e)}`)
  }

  // Default to dark mode colors if detection fails
  return false
}

/**
 * Get the appropriate database colors based on current theme
 * @returns Database color mapping for current theme
 */
function getDatabaseColors(): Record<string, string> {
  return isLightMode() ? databaseColorsLight : databaseColorsDark
}

/**
 * Refresh the items tree to update column colors
 */
function refreshItemsTree(): void {
  try {
    // Refresh all item tree columns to pick up new colors
    Zotero.ItemTreeManager.refreshColumns()
    debugLog('Refreshed columns')
  } catch (e) {
    ztoolkit.log(`Failed to refresh columns: ${String(e)}`)
  }
}

// Process-wide observer ids. Registered once, not once per window.
let themePrefObserverId: symbol | null = null
let colorPrefObserverId: symbol | null = null

/**
 * Per-window system-theme listeners.
 *
 * The `change` callback used to be an anonymous function on a
 * `MediaQueryList` from `Zotero.getMainWindow()`, stored in a single module
 * global. With two windows the second registration overwrote the first, and the
 * listener could never be removed because nothing held a reference to it. The
 * teardown comment claimed the window's own closure handled it, which is only
 * true for the window that closes.
 */
const windowThemeListeners = new Map<Window, { mql: MediaQueryList; onChange: () => void }>()

/**
 * Register the process-wide preference observers. Idempotent, so a second call
 * cannot orphan the first registration's ids.
 */
function registerThemeObservers(): void {
  try {
    themePrefObserverId ??= Zotero.Prefs.registerObserver(
      'theme',
      () => {
        debugLog('Zotero theme preference changed')
        refreshItemsTree()
      },
      true,
    )

    colorPrefObserverId ??= Zotero.Prefs.registerObserver(
      `${addon.data.config.prefsPrefix}.useColors`,
      () => {
        debugLog('Plugin color preference changed')
        refreshItemsTree()
      },
      true,
    )

    debugLog('Theme and color observers registered')
  } catch (e) {
    ztoolkit.log(`Failed to register theme observers: ${String(e)}`)
  }
}

/** Unregister the process-wide preference observers, and every window listener. */
function unregisterThemeObservers(): void {
  try {
    if (themePrefObserverId) {
      Zotero.Prefs.unregisterObserver(themePrefObserverId)
      themePrefObserverId = null
    }
    if (colorPrefObserverId) {
      Zotero.Prefs.unregisterObserver(colorPrefObserverId)
      colorPrefObserverId = null
    }
    for (const win of [...windowThemeListeners.keys()]) {
      unregisterWindowThemeListener(win)
    }
    debugLog('Theme observers unregistered')
  } catch (e) {
    ztoolkit.log(`Failed to unregister theme observers: ${String(e)}`)
  }
}

/** Start listening for system theme changes in one window. */
function registerWindowThemeListener(win: Window): void {
  try {
    if (windowThemeListeners.has(win) || typeof win.matchMedia !== 'function') return
    const mql = win.matchMedia('(prefers-color-scheme: dark)')
    if (!mql) return
    // Named, and retained per window, so it can actually be removed.
    const onChange = () => {
      debugLog('System theme changed')
      refreshItemsTree()
    }
    mql.addEventListener('change', onChange)
    windowThemeListeners.set(win, { mql, onChange })
  } catch (e) {
    ztoolkit.log(`Failed to register window theme listener: ${String(e)}`)
  }
}

/** Stop listening in one window, leaving any other window untouched. */
function unregisterWindowThemeListener(win: Window): void {
  const entry = windowThemeListeners.get(win)
  if (!entry) return
  windowThemeListeners.delete(win)
  try {
    entry.mql.removeEventListener('change', entry.onChange)
  } catch (e) {
    ztoolkit.log(`Failed to remove window theme listener: ${String(e)}`)
  }
}

class Helpers {
  /**
   * Get all possible identifiers from item (for fallback when primary fails)
   * @param item Zotero item
   * @returns Array of objects with type and id, ordered by preference
   */
  static getAllItemIdentifiers(item: Zotero.Item): ItemIdentifier[] {
    const identifiers: ItemIdentifier[] = []

    // Check DOI field first (highest priority). Normalization strips `doi:`
    // prefixes and resolver URLs that users paste into the field, and rejects
    // values that are not DOIs at all -- previously the raw field content went
    // straight into a provider URL.
    const doi = normalizeDoi(item.getField('DOI') || '')
    if (doi) {
      identifiers.push({ type: 'doi', id: doi, source: 'DOI' })
    }

    // arXiv IDs appear in several fields, in no consistent format. The order
    // here is the documented resolution order (see README).
    const pushArxiv = (raw: string | undefined, source: string, extract: (text: string) => string | null): void => {
      if (!raw) return
      const id = extract(raw)
      if (id) {
        identifiers.push({ type: 'arxiv', id, source })
      }
    }

    pushArxiv(item.getField('archiveID'), 'archiveID', extractArxivId)
    pushArxiv(item.getField('reportNumber'), 'reportNumber', extractArxivId)
    pushArxiv(item.getField('extra'), 'extra', extractArxivId)
    pushArxiv(item.getField('url'), 'url', extractArxivIdFromUrl)
    pushArxiv(item.getField('callNumber'), 'callNumber', extractArxivId)

    return identifiers
  }

  /**
   * Get DOI or arXiv ID from item
   * @param item Zotero item
   * @returns Object with type and id, or null if neither found
   */
  static getItemIdentifier(item: Zotero.Item): ItemIdentifier | null {
    const identifiers = this.getAllItemIdentifiers(item)
    return identifiers.length > 0 ? identifiers[0] : null
  }

  static getDatabasePrefArray(): string[] {
    const databaseOrder = getPref('databaseOrder') || 'crossref'
    const databaseArray = databaseOrder.split(',').map((db: string) => db.trim())
    if (databaseArray.length === 0) {
      debugLog('Citation debug - No databases configured in preferences')
    }
    return databaseArray
  }

  static getDatabaseArray(operations: string[] | string | undefined): string[] {
    let configured: string[]
    if (operations === undefined) {
      configured = Helpers.getDatabasePrefArray()
    } else if (typeof operations === 'string') {
      configured = operations.split(',').map((db: string) => db.trim())
    } else if (Array.isArray(operations)) {
      configured = operations.map((db: string) => db.trim())
    } else {
      debugLog('Citation debug - No databases found')
      return []
    }
    // Drop databases this runtime can't support (see effectiveDatabases).
    return effectiveDatabases(configured, isSemanticScholarAvailable())
  }
}
interface CountInfo {
  title: string // Database tag (e.g., 'crossref')
  count: number // Citation count
}
type CountArray = CountInfo[]

class Core {
  /**
   * Store citation count in the Extra field
   * @param item Zotero item
   * @param tag Citation source tag
   * @param count Citation count number
   */
  static async setCitationCount(item: Zotero.Item, data: CountArray) {
    let extra = item.getField('extra')
    if (!extra) {
      extra = ''
    }

    debugLog('Citation debug - Setting citation count for item:', item.id, 'count:', data)
    debugLog('Citation debug - Original Extra field:', extra)

    const extras = extra.split('\n')

    const dbTitles: string[] = data.map((d) => d.title.trim())

    const { kept: filteredExtras, removed } = stripCitationLines(extras, dbTitles)
    for (const line of removed) {
      debugLog('Citation debug - Removing old entry:', line)
    }

    // Citation stamps are stored as YYYY-MM-DD and parsed by citationAutoupdate.
    const date = Temporal.Now.plainDateISO().toString()

    // Add new counts
    for (const { title, count } of data) {
      const newEntry = formatCitationLine(title, count, date)

      // Insert as low as possible but before the BBT citation key
      insertBeforeMatch(filteredExtras, CITATION_KEY_PATTERN, newEntry)
      debugLog('Citation debug - Added new entry:', newEntry)
    }

    // Join and set
    const newExtra = filteredExtras.join('\n')
    item.setField('extra', newExtra)
    await item.saveTx()
    debugLog('Citation debug - New Extra field:', newExtra)
  }

  /**
   * Extract citation count from the Extra field for display in custom column
   * @param item Zotero item
   * @returns Object with counts and databases for rendering
   */
  static getCitationCountForColumn(item: Zotero.Item): { counts: string[]; databases: string[] } | null {
    // Get user's preferred database order
    const databaseOrder = getPref('databaseOrder') || 'crossref'
    const operationsIncluded = databaseOrder.split(',').map((db: string) => db.trim())

    const extra = item.getField('extra')
    if (!extra) {
      return null
    }

    const extras = extra.split('\n')
    const found: Record<string, number> = {}

    for (const tag_ of operationsIncluded) {
      found[tag_] = -1 // Initialize with -1 to indicate not found
    }

    for (const tag_ of operationsIncluded) {
      const tagName = getOperationName(tag_)
      // Escaped: display names come from FTL. This runs in the column paint
      // path, where an unbalanced paren would throw once per rendered cell.
      const safeTag = escapeRegExp(tagName)
      const patt0 = new RegExp(`^Citations: *(\\d+) *\\(${safeTag}\\) *\\[\\d{4}-\\d{1,2}-\\d{1,2}\\]`, 'i') ///REGEXP
      const patt1 = new RegExp(`^Citations: *(\\d+) *\\(${safeTag}\\)`, 'i') ///REGEXP

      for (const ex of extras) {
        let match = patt0.exec(ex)
        if (!match) {
          match = patt1.exec(ex)
        }

        if (match?.[1]) {
          found[tag_] = parseInt(match[1])
          break
        }
      }
    }

    // Format output
    const counts: string[] = []
    const databases: string[] = []

    for (const tag of operationsIncluded) {
      const count = found[tag]
      counts.push(count >= 0 ? count.toString() : '-')
      databases.push(tag)
    }

    // Only return if at least one count was found
    const hasAnyCount = counts.some((count) => count !== '-')
    return hasAnyCount ? { counts, databases } : null
  }

  /**
   * Stored counts keyed by database, in DATABASE_DISPLAY_ORDER.
   *
   * `getCitationCountForColumn` answers the same question for the column, but
   * it follows the user's `databaseOrder` and flattens everything to display
   * strings. The item pane needs the values and a fixed order -- fixed because
   * the palette was validated for those neighbours.
   */
  static getStoredCountsByDatabase(item: Zotero.Item): { database: string; count: number }[] {
    const extra = item.getField('extra')
    if (!extra) return []
    const lines = extra.split('\n')

    const found: { database: string; count: number }[] = []
    for (const database of DATABASE_DISPLAY_ORDER) {
      const safeTag = escapeRegExp(getOperationName(database))
      const withDate = new RegExp(`^Citations: *(\\d+) *\\(${safeTag}\\) *\\[\\d{4}-\\d{1,2}-\\d{1,2}\\]`, 'i')
      const withoutDate = new RegExp(`^Citations: *(\\d+) *\\(${safeTag}\\)`, 'i')
      for (const line of lines) {
        const match = withDate.exec(line) ?? withoutDate.exec(line)
        if (match?.[1]) {
          found.push({ database, count: Number.parseInt(match[1], 10) })
          break
        }
      }
    }
    return found
  }

  /**
   * Extract citation count from Extra field
   * @param item Zotero item
   * @param tag Citation source tag
   * @returns Citation count or -1 if not found
   */
}

class DBInterface {
  /**
   * Get citation count from Crossref with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getCrossrefCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifier = Helpers.getItemIdentifier(item)
    if (identifier?.type !== 'doi') {
      debugLog('Citation debug - No DOI found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI found' }
    }
    const edoi = encodeIdentifierPath(identifier.id)
    debugLog('Citation debug - Encoded DOI:', edoi)

    // Apply adaptive rate limiting
    await RateLimitManager.waitForRateLimit('crossref')

    const style = 'vnd.citationstyles.csl+json'

    /**
     * Fetch one endpoint and classify the outcome.
     *
     * Response status is checked *before* the body is parsed. Previously this
     * was `fetch(url).then((r) => r.json())` with no `r.ok` check, so a 5xx
     * carrying a JSON error body parsed cleanly, produced `undefined` for the
     * count field, and was reported as `not_found` -- which the ignore cache
     * then persisted for up to 180 days.
     */
    const attempt = async (
      url: string,
      init?: RequestInit,
    ): Promise<{ ok: true; body: unknown } | { ok: false; status: LookupStatus; message: string }> => {
      let response: Response
      try {
        response = await lookupFetch(url, init)
      } catch (err) {
        debugLog('Citation debug - Crossref request failed:', err)
        return { ok: false, status: classifyThrown(), message: 'Network request failed' }
      }

      debugLog('Citation debug - Crossref response status:', response.status)

      if (!response.ok) {
        const status = classifyHttpStatus(response.status)
        // 429 handling used to exist only on the DOI.org fallback, so the
        // primary endpoint never backed off.
        if (status === 'rate_limited') {
          RateLimitManager.handleRateLimit('crossref')
        }
        return { ok: false, status, message: `HTTP ${response.status}` }
      }

      try {
        return { ok: true, body: await response.json() }
      } catch (err) {
        debugLog('Citation debug - Crossref body parse failed:', err)
        return { ok: false, status: classifyThrown(), message: 'Malformed response body' }
      }
    }

    const primary = await attempt(`https://api.crossref.org/works/${edoi}/transform/application/${style}`, {
      headers: REQUEST_HEADERS,
    })

    let outcome = primary
    if (!outcome.ok && outcome.status !== 'not_found') {
      // A definite 404 is the provider's answer; anything else is worth a
      // second opinion from the DOI resolver.
      debugLog('Citation debug - Crossref API unavailable, trying DOI.org')
      await RateLimitManager.waitForRateLimit('crossref')
      outcome = await attempt(`https://doi.org/${edoi}`, {
        headers: { ...REQUEST_HEADERS, Accept: `application/${style}` },
      })
    }

    if (!outcome.ok) {
      return { count: outcome.status === 'not_found' ? 0 : -1, status: outcome.status, message: outcome.message }
    }

    const body = outcome.body
    if (typeof body !== 'object' || body === null) {
      return { count: -1, status: 'transient_error', message: 'Unexpected response shape' }
    }

    const raw = (body as Record<string, unknown>)['is-referenced-by-count']
    if (raw === undefined) {
      // The DOI resolved but carries no count. That is a genuine statement
      // about the item, unlike a transport failure.
      debugLog('Citation debug - No is-referenced-by-count field in response')
      return { count: 0, status: 'not_found', message: 'No citation count field in response' }
    }

    const count = parseCitationCount(raw)
    if (count === null) {
      debugLog('Citation debug - Unusable is-referenced-by-count:', raw)
      return { count: -1, status: 'api_error', message: 'Invalid citation count in response' }
    }

    debugLog('Citation debug - is-referenced-by-count:', count)
    RateLimitManager.handleSuccess('crossref')
    return { count, status: 'success' }
  }

  /**
   * Get citation count from INSPIRE with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getInspireCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifiers = Helpers.getAllItemIdentifiers(item)
    if (identifiers.length === 0) {
      debugLog('Citation debug - No DOI or arXiv ID found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI or arXiv ID found' }
    }

    // Track *why* the identifiers failed. Previously every failure -- 404,
    // network error, malformed body -- did the same `continue`, and the loop
    // then returned `not_found` unconditionally. So an INSPIRE outage was
    // recorded as "this item has no citations" and persisted for months.
    let sawTransient = false
    let sawApiError = false

    for (const identifier of identifiers) {
      debugLog(`Citation debug - Trying INSPIRE with ${identifier.type} ID: ${identifier.id} from ${identifier.source}`)

      // Apply adaptive rate limiting
      await RateLimitManager.waitForRateLimit('inspire')

      // INSPIRE's external-identifier endpoints are singular. This read `dois`
      // for years, so every DOI lookup 404'd and success was only ever
      // reachable through an arXiv identifier.
      const type = identifier.type === 'doi' ? 'doi' : 'arxiv'
      // INSPIRE 404s versioned arXiv ids, so the version is dropped here rather
      // than at extraction. Only on the arXiv branch: a DOI suffix is opaque and
      // may legitimately end in something shaped like `v2`.
      const lookupId = identifier.type === 'arxiv' ? stripArxivVersion(identifier.id) : identifier.id
      const url = `https://inspirehep.net/api/${type}/${encodeIdentifierPath(lookupId)}`
      debugLog('Citation debug - Fetching from INSPIRE API:', url)

      let response: Response
      try {
        response = await lookupFetch(url, { headers: REQUEST_HEADERS })
      } catch (err) {
        debugLog(`Citation debug - INSPIRE request failed for ${identifier.id}:`, err)
        sawTransient = true
        continue
      }

      if (!response.ok) {
        const status = classifyHttpStatus(response.status)
        if (status === 'rate_limited') {
          RateLimitManager.handleRateLimit('inspire')
          return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
        }
        if (status === 'transient_error') sawTransient = true
        else if (status === 'api_error') sawApiError = true
        debugLog(`Citation debug - INSPIRE HTTP ${response.status} for ${identifier.id} (${status})`)
        continue
      }

      let body: unknown
      try {
        body = await response.json()
      } catch (err) {
        debugLog(`Citation debug - INSPIRE body parse failed for ${identifier.id}:`, err)
        sawTransient = true
        continue
      }

      const metadata = (body as { metadata?: Record<string, unknown> } | null)?.metadata
      const count = parseCitationCount(metadata?.citation_count)
      if (count === null) {
        debugLog(`Citation debug - No usable citation_count for ${identifier.id}, trying next identifier`)
        // The record resolved but carries no count: authoritative for this
        // identifier, so it does not set a failure flag.
        continue
      }

      debugLog(
        `Citation debug - INSPIRE citation count: ${count} (via ${identifier.type} ${identifier.id} from ${identifier.source})`,
      )
      RateLimitManager.handleSuccess('inspire')
      return { count, status: 'success' }
    }

    // Precedence mirrors semanticScholarClient.core: a transient failure
    // anywhere outranks a 404 elsewhere, because the item might well be present
    // behind the identifier that could not be checked. Only when *every* usable
    // identifier gave an authoritative answer is `not_found` justified -- and
    // only that answer is allowed to persist.
    if (sawTransient) {
      return { count: -1, status: 'transient_error', message: 'INSPIRE lookup failed for every identifier' }
    }
    if (sawApiError) {
      return { count: -1, status: 'api_error', message: 'INSPIRE rejected every identifier' }
    }
    return { count: 0, status: 'not_found', message: 'No valid identifiers found in INSPIRE' }
  }

  /**
   * Get citation count from OpenAlex with enhanced status information.
   *
   * OpenAlex has no arXiv identifier: its only usable id filters are `doi`,
   * `ids.mag`, `ids.openalex`, `ids.pmcid` and `ids.pmid`. arXiv items are
   * therefore looked up through the DOI arXiv itself mints,
   * `10.48550/arxiv.<id>`, of which OpenAlex indexes ~1.9M. That resolves for
   * preprints without a journal version; once a work is published, the
   * publisher DOI is the one that carries the count, and the arXiv DOI may
   * 404. Trying every identifier the item offers covers both directions.
   *
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getOpenAlexCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifiers = Helpers.getAllItemIdentifiers(item)
    if (identifiers.length === 0) {
      debugLog('Citation debug - No DOI or arXiv ID found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI or arXiv ID found' }
    }

    // Status precedence mirrors INSPIRE: a transient failure anywhere outranks
    // a 404 elsewhere, so an outage is never persisted as "no citations".
    let sawTransient = false
    let sawApiError = false

    for (const identifier of identifiers) {
      const lookupDoi = toLookupDoi(identifier)
      debugLog(`Citation debug - Trying OpenAlex with DOI: ${lookupDoi} (from ${identifier.source})`)

      await RateLimitManager.waitForRateLimit(OPENALEX_DATABASE)

      // The full record rather than the single field this path reads. It is
      // the same request either way -- only the payload grows -- and caching it
      // here is what lets the item pane open without a fetch and the
      // field-weighted column have a value for items never opened.
      const url = buildWorkUrl(lookupDoi, WORK_FULL_SELECT)

      let response: Response
      try {
        response = await lookupFetch(url, { headers: REQUEST_HEADERS })
      } catch (err) {
        debugLog(`Citation debug - OpenAlex request failed for ${lookupDoi}:`, err)
        sawTransient = true
        continue
      }

      RateLimitManager.noteBudget(OPENALEX_DATABASE, response)

      if (!response.ok) {
        const status = classifyHttpStatus(response.status)
        if (status === 'rate_limited') {
          RateLimitManager.handleRateLimit(OPENALEX_DATABASE)
          return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
        }
        if (status === 'transient_error') sawTransient = true
        else if (status === 'api_error') sawApiError = true
        debugLog(`Citation debug - OpenAlex HTTP ${response.status} for ${lookupDoi} (${status})`)
        continue
      }

      let body: unknown
      try {
        body = await response.json()
      } catch (err) {
        debugLog(`Citation debug - OpenAlex body parse failed for ${lookupDoi}:`, err)
        sawTransient = true
        continue
      }

      const record = normalizeWork(body)
      if (record) writeCache(openAlexRecordCacheKey(lookupDoi), record)

      const raw = (body as Record<string, unknown> | null)?.cited_by_count
      const count = parseCitationCount(raw)
      if (count === null) {
        debugLog(`Citation debug - No usable cited_by_count for ${lookupDoi}, trying next identifier`)
        continue
      }

      debugLog(
        `Citation debug - OpenAlex citation count: ${count} (via ${identifier.type} ${identifier.id} from ${identifier.source})`,
      )
      RateLimitManager.handleSuccess(OPENALEX_DATABASE)
      return { count, status: 'success' }
    }

    if (sawTransient) {
      return { count: -1, status: 'transient_error', message: 'OpenAlex lookup failed for every identifier' }
    }
    if (sawApiError) {
      return { count: -1, status: 'api_error', message: 'OpenAlex rejected every identifier' }
    }
    return { count: 0, status: 'not_found', message: 'No valid identifiers found in OpenAlex' }
  }

  /**
   * Get citation count from Google Scholar with enhanced status information.
   *
   * Unlike every other provider here, Scholar takes no identifier: it is
   * searched by title and author. That is the whole point of including it --
   * books, chapters, theses, reports and non-English work carry no DOI and are
   * invisible to Crossref, OpenAlex, INSPIRE and Semantic Scholar alike. The
   * price is a scraped results page and Scholar's CAPTCHA.
   *
   * `Zotero.HTTP.request` is used rather than the shared `lookupFetch`, because
   * Scholar's bot detection reacts to `fetch()` and because the cookie the user
   * earns by solving a CAPTCHA only carries over on Zotero's own HTTP stack.
   *
   * @param item Zotero item
   * @param interactive Whether a CAPTCHA may be surfaced to the user. False on
   *   automatic runs, where a browser window opening unprompted is hostile.
   * @returns LookupResult with count and status
   */
  static async getGoogleScholarCountEnhanced(item: Zotero.Item, interactive: boolean): Promise<LookupResult> {
    const rawTitle = item.getField('title')
    if (!rawTitle) {
      debugLog('Citation debug - No title, cannot search Google Scholar for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No title to search with' }
    }

    // Zotero stores markup in titles; a DOMParser is available in the client,
    // and the core module falls back to a regex when it is not.
    const parseMarkup = (html: string): string =>
      new DOMParser().parseFromString(html, 'text/html').body?.textContent || ''

    const authors = (item.getCreators() || []).map((creator) => creator.lastName).filter(Boolean)
    const year = Number.parseInt(item.getField('year'), 10)

    let url: string
    try {
      url = buildScholarUrl({
        endpoint: getPref('googleScholarEndpoint') || 'https://scholar.google.com',
        title: parseMarkup(rawTitle),
        authors,
        year: Number.isNaN(year) ? undefined : year,
        matchAuthors: true,
      })
    } catch (err) {
      debugLog('Citation debug - Could not build Google Scholar URL:', err)
      return { count: -1, status: 'no_identifier', message: 'No usable title to search with' }
    }

    await RateLimitManager.waitForRateLimit(GOOGLE_SCHOLAR_DATABASE)
    debugLog('Citation debug - Fetching from Google Scholar:', url)

    let html: string
    try {
      const response = await Zotero.HTTP.request('GET', url, {
        responseType: 'text',
        timeout: REQUEST_TIMEOUT_MS,
      })
      html = (response as { responseText?: string }).responseText ?? ''
    } catch (err) {
      // Zotero.HTTP throws on non-2xx, carrying the status on the error.
      const status = (err as { status?: number })?.status
      if (typeof status === 'number') {
        const classified = classifyHttpStatus(status)
        if (classified === 'rate_limited') RateLimitManager.handleRateLimit(GOOGLE_SCHOLAR_DATABASE)
        debugLog(`Citation debug - Google Scholar HTTP ${status} (${classified})`)
        return { count: -1, status: classified, message: `HTTP ${status}` }
      }
      debugLog('Citation debug - Google Scholar request failed:', err)
      return { count: -1, status: classifyThrown(), message: 'Network request failed' }
    }

    if (hasRecaptcha(html)) {
      // Scholar is not rate limiting us on a timer; it wants a human. Backing
      // off and retrying spends the next request for nothing, so the run stops
      // here and -- when a person is actually present -- the page is opened so
      // the challenge can be solved.
      RateLimitManager.handleRateLimit(GOOGLE_SCHOLAR_DATABASE)
      debugLog('Citation debug - Google Scholar returned a CAPTCHA')
      if (interactive) {
        try {
          Zotero.openInViewer(url)
        } catch (err) {
          debugLog('Citation debug - Could not open the CAPTCHA page:', err)
        }
      }
      return { count: -1, status: 'rate_limited', message: 'Google Scholar is asking for a CAPTCHA' }
    }

    const count = parseScholarCount(html)
    if (count === null) {
      // No result block: the search matched nothing. That is a statement about
      // this title, not a transport failure, so it is allowed to persist.
      debugLog('Citation debug - No Google Scholar result for item:', item.id)
      return { count: 0, status: 'not_found', message: 'No matching Google Scholar result' }
    }

    // Scholar always answers with *something*. Without checking what came back,
    // an unrelated paper's count gets written to this item and nothing ever
    // flags it. Three near-identical textbook titles in one library returned
    // 626, 2 and 0 citations; at most one of those was right.
    const searchedTitle = parseMarkup(rawTitle)
    const resultTitle = extractResultTitle(html)
    if (!resultTitle) {
      debugLog('Citation debug - Google Scholar result carries no readable title')
      return { count: 0, status: 'not_found', message: 'Google Scholar result had no readable title' }
    }
    const similarity = titleSimilarity(searchedTitle, resultTitle)
    if (similarity < TITLE_MATCH_THRESHOLD) {
      debugLog(
        `Citation debug - Google Scholar hit rejected (${similarity.toFixed(2)} < ${TITLE_MATCH_THRESHOLD}): ` +
          `wanted "${searchedTitle}", got "${resultTitle}"`,
      )
      // Authoritative for this title: the top hit is not this work, and
      // repeating the same query will not change that.
      return {
        count: 0,
        status: 'not_found',
        message: `Google Scholar returned a different work ("${resultTitle}")`,
      }
    }

    debugLog(`Citation debug - Google Scholar citation count: ${count} (title match ${similarity.toFixed(2)})`)
    RateLimitManager.handleSuccess(GOOGLE_SCHOLAR_DATABASE)
    return { count, status: 'success' }
  }

  /**
   * Get citation count from Semantic Scholar with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getSemanticScholarCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    // The scheduling filters should already keep this off the degraded path. If
    // one is missed, return a result that never persists an item ignore.
    if (!isSemanticScholarAvailable()) return semanticScholarUnavailableResult()
    // The dedicated client handles authentication, pacing, retries, and identifier fallback.
    const identifiers = Helpers.getAllItemIdentifiers(item)
    return getSemanticScholarClient().lookupCitationCount(identifiers)
  }
}

// Notifier callback to detect newly added items
const notifierCallback = {
  notify: function (event: string, type: string, ids: number[] | string[], extraData: any) {
    if (event === 'add' && type === 'item') {
      // Check if fetching on add is enabled
      const fetchOnAdd = getPref('fetchOnAdd')
      if (fetchOnAdd !== 'true') {
        ztoolkit.log('Fetch on add disabled, skipping citation fetch for new items')
        return
      }

      // Items.get() returns false for an ID that no longer resolves.
      const items = ids
        .map((id) => Zotero.Items.get(id as number))
        .filter((item): item is Zotero.Item => item !== false && !item.isFeedItem && item.isRegularItem())
      if (items.length > 0) {
        ztoolkit.log(
          'New regular items added with IDs:',
          items.map((item) => item.id),
        )
        updateItems(items)
      }
    }
  },
}

// Progress window tracking
let progressWindow: any
let currentIndex = -1
let totalItems = 0
let itemsToUpdate: Zotero.Item[] = []
let updatedCount = 0

/** Close the manual update progress window and drop queue state (shutdown path). */
function cancelManualUpdate() {
  resetState()
}

/**
 * Reset the state of the citation count update process
 */
function resetState() {
  if (progressWindow) {
    progressWindow.close()
    progressWindow = null
  }
  currentIndex = -1
  totalItems = 0
  itemsToUpdate = []
  updatedCount = 0
}

/**
 * Update citation counts for an array of items
 * @param items Array of Zotero items to update
 * @param operation Citation source to use (e.g., 'crossref')
 */
function updateItems(items: Zotero.Item[], operations?: string[] | string, silent: boolean = false) {
  // Filter out non-regular items
  const regularItems = items.filter((item) => item.isRegularItem())

  if (regularItems.length === 0) {
    if (!silent) {
      // Show message if no regular items are selected
      new ztoolkit.ProgressWindow('Citation Counts', {
        closeOnClick: true,
      })
        .createLine({
          text: getString('progress-no-valid-items'),
          type: 'error',
        })
        .show()
        .startCloseTimer(3000)
    }
    return
  }

  const databases = Helpers.getDatabaseArray(operations)
  if (databases.length === 0) {
    // Nothing configured, or nothing this runtime supports. Bail out before the
    // progress window opens; the user entry points show the degraded notice.
    debugLog('Citation debug - No effective databases; skipping update queue')
    return
  }

  resetState()
  totalItems = regularItems.length
  itemsToUpdate = regularItems

  if (!silent) {
    // Create progress window
    progressWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName)

    progressWindow.createLine({
      text: getString('progress-getting-citation-tallies'),
      type: 'default',
      progress: 0,
    })
  }

  void runUpdateQueue(operations, silent)
}

/** Process manual updates sequentially until the queue completes or is cancelled. */
async function runUpdateQueue(operations?: string[] | string, silent: boolean = false): Promise<void> {
  for (currentIndex = 0; currentIndex < totalItems; currentIndex++) {
    if (!addon.data.alive) break

    if (!silent && progressWindow) {
      const percent = Math.round((currentIndex / totalItems) * 100)
      progressWindow.changeLine({
        text: getString('progress-item-counter', { args: { current: currentIndex + 1, total: totalItems } }),
        progress: percent,
      })
      progressWindow.show()
    }

    try {
      // Manual updates bypass the ignored-item cache.
      if (await updateItem(itemsToUpdate[currentIndex], operations, false)) updatedCount++
    } catch (e) {
      if (isErrorNamed(e, 'AbortError')) break
      ztoolkit.log('Error updating citation count for item', e)
    }
  }

  if (progressWindow) {
    progressWindow.close()
    progressWindow = null
  }
  if (!silent && addon.data.alive) {
    const successWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName)
    successWindow.createLine({
      text: getString('progress-items-updated', { args: { count: updatedCount } }),
      type: 'success',
      progress: 100,
    })
    successWindow.show()
    successWindow.startCloseTimer(4000)
  }
}

/**
 * Update a single item's citation count.
 *
 * Returns true only once a count has been written to the item, so each queue can
 * keep its own success tally rather than sharing one across concurrent runs.
 *
 * @param item Zotero item to update
 * @param operation Citation source to use
 * @param isAutoUpdate Whether this is called from auto-update (to respect unlisted cache)
 */
async function updateItem(
  item: Zotero.Item,
  operations?: string[] | string,
  isAutoUpdate: boolean = false,
): Promise<boolean> {
  try {
    debugLog('Citation debug - Updating item:', item.id, 'title:', item.getField('title'))

    const databases = Helpers.getDatabaseArray(operations)
    if (databases.length === 0) {
      debugLog('Citation debug - No databases configured, skipping item:', item.id)
      return false
    }

    const data: CountArray = []
    for (const operation of databases) {
      if (isAutoUpdate && IgnoredItemsManager.isIgnored(item.id, operation, true)) {
        debugLog(`Citation debug - Skipping ${operation} for item ${item.id} (marked as ignored)`)
        continue
      }

      let result: LookupResult
      let displayName = ''
      if (operation === 'crossref') {
        result = await DBInterface.getCrossrefCountEnhanced(item)
        displayName = getOperationName(operation)
      } else if (operation === OPENALEX_DATABASE) {
        result = await DBInterface.getOpenAlexCountEnhanced(item)
        displayName = getOperationName(operation)
      } else if (operation === GOOGLE_SCHOLAR_DATABASE) {
        // Automatic runs never surface a CAPTCHA window unprompted.
        result = await DBInterface.getGoogleScholarCountEnhanced(item, !isAutoUpdate)
        displayName = getOperationName(operation)
      } else if (operation === 'inspire') {
        result = await DBInterface.getInspireCountEnhanced(item)
        displayName = getOperationName(operation)
      } else if (operation === 'semanticscholar') {
        result = await DBInterface.getSemanticScholarCountEnhanced(item)
        displayName = getOperationName(operation)
      } else {
        continue
      }

      // Once the plugin is shut down, don't write to the ignore cache or the item.
      if (!addon.data.alive) return false

      if (result.status === 'success' && result.count >= 0) {
        IgnoredItemsManager.clearIgnoredItem(item.id, operation)
        data.push({ title: displayName, count: result.count })
      } else {
        // Only an authoritative not-found is persistent; a missing identifier is
        // cached for the session. Provider failures record nothing -- see
        // `getIgnorePolicy`.
        const policy = getIgnorePolicy(result.status, isAutoUpdate)
        if (policy === 'session') {
          IgnoredItemsManager.markAsIgnored(item.id, operation, 'no_identifier', false)
        } else if (policy === 'persistent') {
          IgnoredItemsManager.markAsIgnored(item.id, operation, 'not_found', true)
        }
        debugLog(`Citation debug - ${operation} for item ${item.id}: ${result.status} (${result.message ?? ''})`)
      }
    }

    if (!addon.data.alive) return false
    if (data.length > 0) {
      await Core.setCitationCount(item, data)
      return true
    }
  } catch (e) {
    if (isErrorNamed(e, 'AbortError')) throw e
    ztoolkit.log('Error updating citation count for item', e)
  }
  return false
}

class BasicRegistrar {
  static registerPrefs() {
    void Zotero.PreferencePanes.register({
      pluginID: addon.data.config.addonID,
      src: rootURI + 'content/preferences.xhtml',
      label: getString('prefs-title'),
      image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    })
  }
}

class UIRegistrar {
  /**
   * Register custom column to display citation counts
   */
  /**
   * Field-weighted citation impact, as a sortable column.
   *
   * Read from the local cache, never from the Extra field. Sorting needs a
   * value for every row, and the obvious way to get one -- writing it to Extra
   * -- would sync a derived number into every shared library the user is in.
   * The count lookup fills this cache as a side effect, so any item that has
   * ever been tallied has a value here.
   *
   * The point of the column is that FWCI is the one number in the plugin that
   * compares across disciplines: 50 citations means something different in
   * mathematics than in oncology, and this is what takes that out.
   */
  static registerFwciColumn() {
    debugLog('Citation debug - Registering FWCI column')
    Zotero.ItemTreeManager.registerColumn({
      pluginID: addon.data.config.addonID,
      dataKey: 'openAlexFwci',
      label: getString('column-fwci'),
      width: '70',
      flex: 0,
      zoteroPersist: ['width', 'ordinal', 'hidden', 'sortDirection'],
      dataProvider: (item: Zotero.Item) => {
        // Runs per visible row on every redraw: cache reads only, no fetching
        // and no logging.
        if (!item.isRegularItem()) return ''
        for (const identifier of Helpers.getAllItemIdentifiers(item)) {
          const record = readCache<ScholarlyRecord>(openAlexRecordCacheKey(toLookupDoi(identifier)))
          if (record?.fwci !== null && record?.fwci !== undefined) return record.fwci.toFixed(2)
        }
        return ''
      },
    })
  }

  static registerCitationColumn() {
    debugLog('Citation debug - Registering citation count column')
    Zotero.ItemTreeManager.registerColumn({
      pluginID: addon.data.config.addonID,
      dataKey: 'citationCount',
      label: getString('column-citations'),
      width: '80',
      // staticWidth: true,
      flex: 0,
      zoteroPersist: ['width', 'ordinal', 'hidden', 'sortDirection'],
      dataProvider: (item: Zotero.Item) => {
        // This runs once per visible row on every redraw, so it must stay cheap
        // and silent. It previously logged `Object.keys(item)` and the item type
        // on every call, and fetched the parent item from the database for
        // attachments and notes -- all purely diagnostic.
        const result = Core.getCitationCountForColumn(item)
        // Return JSON string that renderCell will parse
        return result ? JSON.stringify(result) : ''
      },
      // iconPath: 'chrome://zotero/skin/citations.png',
      renderCell(index, data: any, column, isFirstColumn, doc) {
        const span = doc.createElement('span')
        span.className = `cell ${column.className}`
        span.style.textAlign = 'center'

        // Parse JSON data if it's a string
        let parsedData: { counts: string[]; databases: string[] } | null = null
        if (data && typeof data === 'string') {
          try {
            parsedData = JSON.parse(data)
          } catch (e) {
            // Display as text if JSON parsing fails
            span.innerText = data
            return span
          }
        } else if (!data) {
          span.innerText = ''
          return span
        }

        // Create colored spans for each count
        const dataToUse = parsedData || data
        const useColors = getPref('useColors') === 'color' && dataToUse.databases.length > 1

        dataToUse.counts.forEach((count: string, idx: number) => {
          if (idx > 0) {
            const separator = doc.createElement('span')
            separator.innerText = ' | '
            separator.style.opacity = '0.25'
            span.appendChild(separator)
          }

          const countSpan = doc.createElement('span')
          countSpan.innerText = count
          if (useColors) {
            countSpan.style.color = getDatabaseColors()[dataToUse.databases[idx]] || '#000'
            countSpan.style.fontWeight = '500'
          }
          span.appendChild(countSpan)
        })

        // Add tooltip with database names
        const tooltip = dataToUse.databases
          .map((db: string, idx: number) => {
            const displayName = getOperationName(db)
            return getString('tooltip-citation-tallies', { args: { displayName, count: dataToUse.counts[idx] } })
          })
          .join(', ')
        span.title = tooltip

        return span
      },
    })
    debugLog('Citation debug - Column registration complete')
  }

  /**
   * Register the notifier to detect new items
   */
  static registerNotifier() {
    // Registered once for the process, not once per window.
    if (notifierID !== null) return
    notifierID = Zotero.Notifier.registerObserver(notifierCallback, ['item'])
  }

  /**
   * Unregister the item notifier.
   *
   * This used to be driven by a `Zotero.Plugins` observer that watched for this
   * plugin's own shutdown -- an observer that was itself never removed. The
   * shutdown hook already runs on that path, so the indirection only added a
   * leak.
   */
  static unregisterNotifier() {
    if (notifierID === null) return
    Zotero.Notifier.unregisterObserver(notifierID)
    notifierID = null
  }

  /**
   * Register observers for theme changes to update column colors
   */
  static registerThemeObservers() {
    registerThemeObservers()
  }

  /**
   * Unregister theme observers (call on shutdown)
   */
  static unregisterThemeObservers() {
    unregisterThemeObservers()
  }

  /** Per-window system-theme listener, registered on window load. */
  static registerWindowThemeListener(win: Window) {
    registerWindowThemeListener(win)
  }

  /** Per-window system-theme listener, removed on window unload. */
  static unregisterWindowThemeListener(win: Window) {
    unregisterWindowThemeListener(win)
  }

  /**
   * Register a context menu item to update citation counts for selected items
   */
  static registerCitationCountMenuItem() {
    Zotero.MenuManager.registerMenu({
      menuID: `${addon.data.config.addonID}-update-citations`,
      pluginID: addon.data.config.addonID,
      target: 'main/library/item',
      menus: [
        {
          menuType: 'menuitem',
          l10nID: getLocaleID('menuitem-update-citation-tallies'),
          icon: 'chrome://zotero/skin/toolbar-advanced-search.png',
          onShowing: () => {
            try {
              const zoteroPane = Zotero.getActiveZoteroPane()
              if (!zoteroPane) return false
              const selectedItems = zoteroPane.getSelectedItems()
              if (!selectedItems || selectedItems.length === 0) return false
              return selectedItems.some((item) => item.isRegularItem())
            } catch {
              return false
            }
          },
          onCommand: () => addon.hooks.onDialogEvents('updateCitationCounts'),
        },
      ],
    })
  }

  /**
   * Register a menubar item to retally outdated item citations
   */
  static registerRetallyCitationsMenuItem() {
    Zotero.MenuManager.registerMenu({
      menuID: `${addon.data.config.addonID}-retally-citations`,
      pluginID: addon.data.config.addonID,
      target: 'main/menubar/tools',
      menus: [
        {
          menuType: 'menuitem',
          l10nID: getLocaleID('menuitem-retally-outdated-citations'),
          onCommand: () => addon.hooks.onDialogEvents('retallyOutdatedCitations'),
        },
      ],
    })
  }
}

class UX {
  /**
   * Update citation counts for all selected items
   */
  static updateSelectedItemsCitationCounts() {
    // Surface the runtime-degraded state at action time (no-op in full mode).
    notifySemanticScholarUnavailable()

    // Get selected items. No active pane means nothing is selected.
    const zoteroPane = Zotero.getActiveZoteroPane()
    if (!zoteroPane) return
    const items = zoteroPane.getSelectedItems()

    updateItems(items)
  }
}

// Export functions needed by autoupdate module
export { getDatabaseColors }
export {
  // The item pane reuses the provider plumbing rather than opening a second,
  // separately paced channel to OpenAlex.
  lookupFetch,
  RateLimitManager,
  REQUEST_HEADERS,
  REQUEST_TIMEOUT_MS,
  DBInterface,
  Core,
  Helpers,
  UIRegistrar,
  BasicRegistrar,
  UX,
  updateItem,
  scheduleMonthlyCleanup,
  cancelMonthlyCleanup,
  cancelManualUpdate,
}
