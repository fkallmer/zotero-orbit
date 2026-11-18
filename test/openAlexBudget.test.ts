/**
 * Reading what is left of the OpenAlex budget from response headers.
 *
 * The header names and shapes are OpenAlex's own, taken from a live response
 * on 18 Nov 2026 (no key): limit-usd 0.1, remaining-usd 0.0914, reset 51107.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  describeOpenAlexBudget,
  latestOpenAlexBudget,
  parseOpenAlexBudget,
  recordOpenAlexBudget,
} from '../src/modules/openAlexBudget.core.ts'

const NOW = 1_800_000_000_000

function headers(values: Record<string, string>): (name: string) => string | null {
  return (name) => values[name] ?? null
}

describe('parseOpenAlexBudget', () => {
  it('reads the dollar figures and turns the reset into a time', () => {
    const budget = parseOpenAlexBudget(
      headers({ 'x-ratelimit-limit-usd': '0.1', 'x-ratelimit-remaining-usd': '0.0914', 'x-ratelimit-reset': '51107' }),
      NOW,
    )
    assert.deepEqual(budget, { remainingUsd: 0.0914, limitUsd: 0.1, resetAt: NOW + 51107 * 1000, observedAt: NOW })
  })

  it('is null without the dollar figures, or with nonsense in them', () => {
    assert.equal(parseOpenAlexBudget(headers({}), NOW), null)
    assert.equal(parseOpenAlexBudget(headers({ 'x-ratelimit-remaining-usd': '0.5' }), NOW), null)
    assert.equal(
      parseOpenAlexBudget(headers({ 'x-ratelimit-limit-usd': 'x', 'x-ratelimit-remaining-usd': '0.5' }), NOW),
      null,
    )
    assert.equal(
      parseOpenAlexBudget(headers({ 'x-ratelimit-limit-usd': '0', 'x-ratelimit-remaining-usd': '0' }), NOW),
      null,
    )
  })

  it('keeps the budget without a reset when none is given', () => {
    const budget = parseOpenAlexBudget(
      headers({ 'x-ratelimit-limit-usd': '1', 'x-ratelimit-remaining-usd': '0.5' }),
      NOW,
    )
    assert.equal(budget?.resetAt, null)
  })
})

describe('the latest budget', () => {
  it('is what the last response said, until its reset has passed', () => {
    recordOpenAlexBudget(
      parseOpenAlexBudget(
        headers({ 'x-ratelimit-limit-usd': '1', 'x-ratelimit-remaining-usd': '0.91', 'x-ratelimit-reset': '3600' }),
        NOW,
      ),
    )
    assert.equal(latestOpenAlexBudget(NOW + 1000)?.remainingUsd, 0.91)
    // A response without the figures does not wipe what is known.
    recordOpenAlexBudget(null)
    assert.equal(latestOpenAlexBudget(NOW + 1000)?.remainingUsd, 0.91)
    assert.equal(latestOpenAlexBudget(NOW + 3600 * 1000), null)
  })
})

describe('describeOpenAlexBudget', () => {
  it('gives dollars, the share left and whole hours to the reset', () => {
    const figures = describeOpenAlexBudget(
      { remainingUsd: 0.91, limitUsd: 1, resetAt: NOW + 13.2 * 3_600_000, observedAt: NOW },
      NOW,
    )
    assert.deepEqual(figures, { remaining: '0.91', limit: '1.00', percent: 91, hours: 14 })
  })

  it('shows the small keyless budget to a tenth of a cent', () => {
    const figures = describeOpenAlexBudget({ remainingUsd: 0.0914, limitUsd: 0.1, resetAt: null, observedAt: NOW }, NOW)
    assert.deepEqual(figures, { remaining: '0.091', limit: '0.10', percent: 91, hours: null })
  })
})
