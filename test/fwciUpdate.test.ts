import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chunk, countValues, fwciWritesForChunk, planFwciLookups } from '../src/modules/fwciUpdate.core.ts'

const always = () => true

test('chunk splits in order and keeps the remainder', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([], 2), [])
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]])
  // A nonsensical size must not loop forever.
  assert.deepEqual(chunk([1, 2], 0), [[1, 2]])
})

test('planFwciLookups collapses the DOIs one item offers', () => {
  // A preprint carries both the publisher DOI and the one arXiv mints.
  const plan = planFwciLookups([['10.1/published', '10.48550/arxiv.2401.00001']], always)
  assert.deepEqual(plan, ['10.1/published', '10.48550/arxiv.2401.00001'])
})

test('planFwciLookups asks once when two items share a DOI', () => {
  const plan = planFwciLookups([['10.1/same'], ['10.1/SAME'], ['10.1/other']], always)
  assert.deepEqual(plan, ['10.1/same', '10.1/other'])
})

test('planFwciLookups drops blanks and preserves order', () => {
  assert.deepEqual(planFwciLookups([['', '10.1/b'], [], ['10.1/a']], always), ['10.1/b', '10.1/a'])
})

test('planFwciLookups applies the staleness predicate', () => {
  const fresh = new Set(['10.1/fresh'])
  const plan = planFwciLookups([['10.1/fresh'], ['10.1/stale']], (doi) => !fresh.has(doi))
  assert.deepEqual(plan, ['10.1/stale'])
})

test('planFwciLookups consults the predicate once per distinct DOI', () => {
  const asked: string[] = []
  planFwciLookups([['10.1/a'], ['10.1/A'], ['10.1/a']], (doi) => {
    asked.push(doi)
    return true
  })
  assert.deepEqual(asked, ['10.1/a'])
})

test('every DOI asked gets a write, including the ones not answered', () => {
  // The unanswered ones are the point: without a record, a library-wide refresh
  // would re-ask the same unindexed works on every run.
  const writes = fwciWritesForChunk(['10.1/has', '10.1/missing'], [{ doi: '10.1/has', fwci: 1.75 }])
  assert.deepEqual(writes, [
    { lookupDoi: '10.1/has', fwci: 1.75 },
    { lookupDoi: '10.1/missing', fwci: null },
  ])
})

test('a null in the response is stored as a null, not as an absence', () => {
  const writes = fwciWritesForChunk(['10.1/recent'], [{ doi: '10.1/recent', fwci: null }])
  assert.deepEqual(writes, [{ lookupDoi: '10.1/recent', fwci: null }])
})

test('matching is case-insensitive in both directions', () => {
  const writes = fwciWritesForChunk(['10.1/MixedCase'], [{ doi: '10.1/mixedcase', fwci: 2 }])
  assert.deepEqual(writes, [{ lookupDoi: '10.1/mixedcase', fwci: 2 }])
})

test('a result nobody asked about is ignored', () => {
  const writes = fwciWritesForChunk(['10.1/asked'], [{ doi: '10.1/surprise', fwci: 9 }])
  assert.deepEqual(writes, [{ lookupDoi: '10.1/asked', fwci: null }])
})

test('countValues counts only the answers carrying a number', () => {
  assert.equal(
    countValues([
      { lookupDoi: 'a', fwci: 1 },
      { lookupDoi: 'b', fwci: null },
      { lookupDoi: 'c', fwci: 0 },
    ]),
    2,
  )
  assert.equal(countValues([]), 0)
})
