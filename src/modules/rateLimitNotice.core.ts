/**
 * What to tell the user while a provider is making us wait.
 *
 * Without an API key, Semantic Scholar answers 429 often, and the scheduler
 * then sleeps for seconds at a time -- up to half a minute once the failures
 * stack up. A bulk update simply stopped moving while that happened, and
 * looked hung. The schedulers report each rate-limit wait here, and the
 * progress windows ask, once a second, what (if anything) to say about it.
 *
 * Every time is a monotonic millisecond reading, the same clock the
 * schedulers sleep against. Keep this module free of runtime Zotero
 * dependencies.
 */

/** A rate-limit wait in progress for one source. */
export interface SourceWait {
  /** Monotonic ms at which the source may be asked again. */
  readonly untilMs: number
}

/** Waits by source key (`crossref`, `semanticscholar`, ...). */
export type WaitBoard = Readonly<Record<string, SourceWait>>

export type RateLimitMessageId =
  'rate-limit-waiting' | 'rate-limit-waiting-semanticscholar' | 'rate-limit-waiting-semanticscholar-no-key'

/** A notice ready for `getString(id, { args })`, less the source's display name. */
export interface RateLimitNotice {
  readonly id: RateLimitMessageId
  /** The source key, for the caller to turn into a display name. */
  readonly source: string
  readonly amount: number
  readonly unit: 'seconds' | 'minutes'
}

export const SEMANTIC_SCHOLAR_SOURCE = 'semanticscholar'

/**
 * Waits shorter than this are not worth announcing. The ordinary anonymous
 * Semantic Scholar spacing is 3 s, and a notice that appears and vanishes
 * within one tick of the window's refresh is noise.
 */
export const MIN_NOTICE_MS = 1500

/** From this long on, the wait reads in minutes rather than seconds. */
const MINUTES_FROM_MS = 120_000

/**
 * Record that `source` is rate-limited until `untilMs`, or that it no longer
 * is (`null`). The newest report wins: a scheduler that has just re-planned
 * its departure knows better than its own earlier estimate.
 */
export function noteWait(board: WaitBoard, source: string, untilMs: number | null): WaitBoard {
  const next: Record<string, SourceWait> = { ...board }
  if (untilMs === null || !Number.isFinite(untilMs)) delete next[source]
  else next[source] = { untilMs }
  return next
}

/** Drop the waits that have run out, so the board does not grow stale entries. */
export function pruneWaits(board: WaitBoard, nowMs: number): WaitBoard {
  const next: Record<string, SourceWait> = {}
  for (const [source, wait] of Object.entries(board)) {
    if (wait.untilMs > nowMs) next[source] = wait
  }
  return next
}

/** Round a remaining wait up, so the notice never claims less than is left. */
export function formatWait(remainingMs: number): { amount: number; unit: 'seconds' | 'minutes' } {
  if (remainingMs >= MINUTES_FROM_MS) return { amount: Math.ceil(remainingMs / 60_000), unit: 'minutes' }
  return { amount: Math.max(1, Math.ceil(remainingMs / 1000)), unit: 'seconds' }
}

/**
 * The notice to show now, or `null` when nothing is worth saying.
 *
 * With several sources waiting at once, the longest wait is the one holding
 * the queue up, so that is the one named.
 *
 * @param semanticScholarKeySet whether the user has a usable Semantic Scholar
 *   key. The hint to add one is offered only when they have none: a user whose
 *   key is merely paused should not be told to go and get one.
 */
export function pickNotice(board: WaitBoard, nowMs: number, semanticScholarKeySet: boolean): RateLimitNotice | null {
  let longest: { source: string; remainingMs: number } | null = null
  for (const [source, wait] of Object.entries(board)) {
    const remainingMs = wait.untilMs - nowMs
    if (remainingMs < MIN_NOTICE_MS) continue
    if (longest === null || remainingMs > longest.remainingMs) longest = { source, remainingMs }
  }
  if (longest === null) return null

  const { amount, unit } = formatWait(longest.remainingMs)
  let id: RateLimitMessageId = 'rate-limit-waiting'
  if (longest.source === SEMANTIC_SCHOLAR_SOURCE) {
    id = semanticScholarKeySet ? 'rate-limit-waiting-semanticscholar' : 'rate-limit-waiting-semanticscholar-no-key'
  }
  return { id, source: longest.source, amount, unit }
}

/** A stable key for a notice, so a window is only redrawn when the text would change. */
export function noticeKey(notice: RateLimitNotice | null): string {
  return notice === null ? '' : `${notice.id}|${notice.source}|${notice.amount}|${notice.unit}`
}
