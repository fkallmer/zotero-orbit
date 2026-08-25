/**
 * Checks the Temporal behaviour the Node suite can only check by proxy.
 *
 * `test/register.mjs` gives Node a `Temporal` global from `temporal-polyfill`,
 * because Zotero's Gecko runtime has one and Node 26 does not. That makes the
 * unit tests run, but it also means they assert against an implementation the
 * plugin never executes on. A green `temporalParse.test.ts` says the polyfill
 * agrees, not that Zotero does.
 *
 * So the cases where two conforming implementations could still plausibly part
 * ways are repeated here, against the real global: `overflow: 'reject'`, the
 * leap-second normalization, the two-digit-year rollover, `Duration.total`, and
 * the exact `toString()` forms the parsers hand back. The bare threshold
 * arithmetic is not repeated -- it is ordinary comparison, and the Node suite
 * covers it.
 *
 * Runs inside the scaffold's Zotero test window (mocha), same conventions as
 * `startup.spec.ts`: dependency-free throws, bundled by the scaffold rather
 * than the Node test runner, and excluded from tsconfig.test.json.
 */

import { retryAgeExceeded } from '../../src/utils/retryAge'
import {
  parseCitationStampDate,
  parseDateAddedInstant,
  parseLastCheckedInstant,
  parseRetryAfterMs,
} from '../../src/utils/temporalParse'

declare const Zotero: any
declare function describe(title: string, fn: (this: { timeout: (ms: number) => void }) => void): void
declare function it(title: string, fn: () => void | Promise<void>): void

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
}

describe('Temporal in the Zotero runtime', function () {
  this.timeout(30000)

  it('is a global here, and a built-in rather than a bundled polyfill', () => {
    ok(typeof Temporal !== 'undefined', 'Temporal is missing from this runtime')
    // Everything below is only worth running against the real implementation,
    // so establish that it is one. A built-in prints `[native code]`; a
    // polyfill prints its own source. If this ever fails, a polyfill has been
    // pulled into the plugin bundle and the rest of this file proves nothing.
    ok(
      Temporal.Instant.from.toString().includes('native code'),
      'Temporal appears to be a polyfill, not a built-in -- the assertions below would test the polyfill',
    )
    Zotero.debug(
      `[temporal] zotero=${String(Zotero.version)} platform=${String(Zotero.platformVersion)} ` +
        `instant=${Temporal.Instant.from('2026-07-21T00:00:00Z').toString()}`,
    )
  })

  it('rejects out-of-range dates rather than clamping them', () => {
    // `overflow: 'reject'` is the whole reason these return null. An
    // implementation that clamped instead would hand back 2026-12-01 and
    // 2026-02-28, and a wrong citation stamp would look like a valid one.
    equal(parseCitationStampDate('2026-13-01'), null, 'month 13 was not rejected')
    equal(parseCitationStampDate('2026-02-30'), null, '30 February was not rejected')
    equal(parseCitationStampDate('garbage'), null, 'garbage was not rejected')
  })

  it('zero-pads PlainDate.toString() for non-padded input', () => {
    equal(parseCitationStampDate('2026-07-21')?.toString(), '2026-07-21', 'padded date round-trip')
    equal(parseCitationStampDate('2025-2-3')?.toString(), '2025-02-03', 'non-padded date was not zero-padded')
  })

  it('formats Instant.toString() without a fractional part when there is none', () => {
    // Zotero writes this string into the item's Extra field, so the exact form
    // is not cosmetic -- a trailing `.000` would change what is stored.
    equal(parseDateAddedInstant('2026-07-21 08:30:00')?.toString(), '2026-07-21T08:30:00Z', 'dateAdded round-trip')
    equal(parseDateAddedInstant(''), null, 'empty string')
    equal(parseDateAddedInstant('bad'), null, 'unparseable dateAdded')
  })

  it('parses an ISO instant and returns null on garbage', () => {
    ok(parseLastCheckedInstant('2026-07-21T00:00:00.123Z') instanceof Temporal.Instant, 'ISO instant not parsed')
    equal(parseLastCheckedInstant('not-a-date'), null, 'garbage lastChecked')
  })

  it('normalizes a leap second instead of rejecting it', () => {
    // RFC 9110 permits `:60`; Temporal with `overflow: 'reject'` does not. The
    // parser rewrites it to :59 + 1s, so a server sending a leap second still
    // gets its Retry-After honoured rather than dropped to computed backoff.
    const now = Temporal.Instant.from('2026-07-21T00:00:00Z').epochMilliseconds
    equal(parseRetryAfterMs('Tue, 21 Jul 2026 00:00:60 GMT', now), 60_000, 'leap second not normalized')
  })

  it('applies the RFC 9110 two-digit-year rollover', () => {
    const now = Temporal.Instant.from('2026-07-21T00:00:00Z').epochMilliseconds
    equal(parseRetryAfterMs('Tuesday, 21-Jul-26 01:00:00 GMT', now), 3_600_000, 'RFC-850 rollover')
  })

  it('reads asctime with a space-padded single-digit day', () => {
    const now = Temporal.Instant.from('2026-07-21T00:00:00Z').epochMilliseconds
    equal(parseRetryAfterMs('Thu Jul 30 00:00:00 2026', now), 9 * 86_400_000, 'asctime, two-digit day')
    equal(parseRetryAfterMs('Sat Aug  1 00:00:00 2026', now), 11 * 86_400_000, 'asctime, space-padded day')
  })

  it('clamps a past HTTP-date to zero and refuses a malformed one', () => {
    const now = Temporal.Instant.from('2026-07-21T00:00:00Z').epochMilliseconds
    equal(parseRetryAfterMs('Mon, 20 Jul 2026 00:00:00 GMT', now), 0, 'past date should clamp to 0')
    equal(parseRetryAfterMs('Xyz, 99 Zzz 2026 99:99:99 GMT', now), null, 'malformed date should be null')
  })

  it('measures elapsed days through Duration.total across a month boundary', () => {
    // `retryAgeExceeded` compares whole days off `since().total({unit: 'day'})`.
    // Crossing a month boundary is where a rounding difference would show up.
    const now = Temporal.Instant.from('2026-07-21T00:00:00Z')
    const daysAgo = (n: number): Temporal.Instant => now.subtract({ hours: 24 * n })
    equal(retryAgeExceeded(2, daysAgo(31), now), true, '31 days on count 2 should be due')
    equal(retryAgeExceeded(2, daysAgo(29), now), false, '29 days on count 2 should not be due')
    equal(retryAgeExceeded(1, null, now), true, 'a missing timestamp should retry now')
  })
})
