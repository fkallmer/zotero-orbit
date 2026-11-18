/**
 * What is left of today's OpenAlex budget, as OpenAlex last said.
 *
 * Every OpenAlex response carries the budget in its headers, in dollars as
 * well as in requests (checked 18 Nov 2026):
 *
 *     x-ratelimit-limit-usd: 0.1
 *     x-ratelimit-remaining-usd: 0.0914
 *     x-ratelimit-reset: 51107        (seconds until the daily reset)
 *
 * The request pacing already reads the request count to slow down when the
 * budget runs short. This keeps the dollar figures too, so the graph can say
 * what an analysis leaves, not only what it costs. Held in memory only: it is
 * whatever the latest response said, and stale after the reset.
 */

export interface OpenAlexBudget {
  remainingUsd: number
  limitUsd: number
  /** Epoch ms of the next reset, or null when OpenAlex did not say. */
  resetAt: number | null
  /** Epoch ms of the response this was read from. */
  observedAt: number
}

let latest: OpenAlexBudget | null = null

function number(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** The budget in a response's headers, or null when they do not carry it. */
export function parseOpenAlexBudget(header: (name: string) => string | null, now: number): OpenAlexBudget | null {
  const remainingUsd = number(header('x-ratelimit-remaining-usd'))
  const limitUsd = number(header('x-ratelimit-limit-usd'))
  if (remainingUsd === null || limitUsd === null || limitUsd === 0) return null
  const reset = number(header('x-ratelimit-reset'))
  return { remainingUsd, limitUsd, resetAt: reset === null ? null : now + reset * 1000, observedAt: now }
}

export function recordOpenAlexBudget(budget: OpenAlexBudget | null): void {
  if (budget) latest = budget
}

/**
 * The latest budget, or null when no response has said, or the reset it
 * named has passed -- after which the figure describes a day that is over.
 */
export function latestOpenAlexBudget(now: number): OpenAlexBudget | null {
  if (!latest) return null
  if (latest.resetAt !== null && now >= latest.resetAt) return null
  return latest
}

/** The figures a sentence about the budget needs. */
export function describeOpenAlexBudget(
  budget: OpenAlexBudget,
  now: number,
): { remaining: string; limit: string; percent: number; hours: number | null } {
  const usd = (value: number): string => (value < 0.1 ? value.toFixed(3) : value.toFixed(2))
  return {
    remaining: usd(budget.remainingUsd),
    limit: usd(budget.limitUsd),
    percent: Math.round((budget.remainingUsd / budget.limitUsd) * 100),
    hours: budget.resetAt === null ? null : Math.max(0, Math.ceil((budget.resetAt - now) / 3_600_000)),
  }
}
