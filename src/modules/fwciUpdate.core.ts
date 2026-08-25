/**
 * Pure planning for a field-weighted impact refresh.
 *
 * Free of Zotero and of network access, so `node --test` can exercise the parts
 * that decide what gets asked and what gets written -- the two places where a
 * mistake is silent rather than loud. Asking too much is a slow refresh; writing
 * a value against the wrong DOI is a wrong number in a column people sort by.
 */

import type { WorkFwci } from './openAlexClient.core.ts'

/** Split a list into fixed-size batches, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) return [[...items]]
  const out: T[][] = []
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size))
  return out
}

/**
 * The DOIs a run should ask about, in order, without repeats.
 *
 * One item can offer several identifiers -- a publisher DOI and the DOI arXiv
 * mints for the same paper -- and several items can share one, in a library that
 * holds both the preprint and the published version. Both directions collapse
 * here, so a batch of fifty is fifty distinct questions.
 *
 * `shouldAsk` carries the staleness decision, which lives with the store; this
 * only applies it.
 */
export function planFwciLookups(
  perItemDois: readonly (readonly string[])[],
  shouldAsk: (lookupDoi: string) => boolean,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dois of perItemDois) {
    for (const doi of dois) {
      const key = doi.toLowerCase()
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      if (shouldAsk(key)) out.push(key)
    }
  }
  return out
}

export interface FwciWrite {
  lookupDoi: string
  fwci: number | null
}

/**
 * What to store after one batch answers.
 *
 * Every DOI asked gets a write, including the ones the response did not mention.
 * A DOI OpenAlex does not hold is a real answer -- "no value" -- and recording
 * it is what stops a library-wide refresh from re-asking the same few hundred
 * unindexed works on every run. Without this, the misses are the only thing a
 * second run would do.
 *
 * A result whose DOI was not asked for is ignored rather than stored: OpenAlex
 * matching something unexpected is not a reason to attribute a number to it.
 */
export function fwciWritesForChunk(asked: readonly string[], found: readonly WorkFwci[]): FwciWrite[] {
  const byDoi = new Map<string, number | null>()
  for (const work of found) byDoi.set(work.doi.toLowerCase(), work.fwci)
  return asked.map((doi) => {
    const key = doi.toLowerCase()
    return { lookupDoi: key, fwci: byDoi.has(key) ? (byDoi.get(key) as number | null) : null }
  })
}

/** How many of a batch's answers carried an actual number. */
export function countValues(writes: readonly FwciWrite[]): number {
  return writes.reduce((total, write) => total + (write.fwci === null ? 0 : 1), 0)
}
