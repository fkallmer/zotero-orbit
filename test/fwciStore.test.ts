import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  emptyFwciStore,
  FWCI_STORE_VERSION,
  fwciStoreSize,
  getFwciRecord,
  needsFwciRefresh,
  parseFwciStore,
  putFwciRecord,
  serializeFwciStore,
} from '../src/utils/fwciStore.ts'

const NOW = Temporal.Instant.from('2026-08-25T00:00:00Z')
const monthsAgo = (n: number): Temporal.Instant => NOW.subtract({ hours: 24 * 30 * n })

function storeJson(entries: unknown, version: unknown = FWCI_STORE_VERSION): string {
  return JSON.stringify({ version, entries })
}

test('an absent, empty or unparseable file reads as an empty store', () => {
  assert.deepEqual(parseFwciStore(undefined), emptyFwciStore())
  assert.deepEqual(parseFwciStore(null), emptyFwciStore())
  assert.deepEqual(parseFwciStore(''), emptyFwciStore())
  assert.deepEqual(parseFwciStore('{'), emptyFwciStore())
  assert.deepEqual(parseFwciStore('[]'), emptyFwciStore())
  assert.deepEqual(parseFwciStore('"a string"'), emptyFwciStore())
})

test('a foreign version is discarded rather than reinterpreted', () => {
  const raw = storeJson({ '10.1/a': { fwci: 1.5, checkedAt: NOW.toString() } }, FWCI_STORE_VERSION + 1)
  assert.deepEqual(parseFwciStore(raw), emptyFwciStore())
  assert.deepEqual(parseFwciStore(storeJson({}, undefined)), emptyFwciStore())
})

test('entries round-trip, and DOIs are matched case-insensitively', () => {
  const raw = storeJson({ '10.1038/NATURE12373': { fwci: 2.25, checkedAt: NOW.toString() } })
  const store = parseFwciStore(raw)
  assert.equal(fwciStoreSize(store), 1)
  assert.deepEqual(getFwciRecord(store, '10.1038/nature12373'), { fwci: 2.25, checkedAt: NOW.toString() })
  assert.deepEqual(getFwciRecord(store, '10.1038/Nature12373')?.fwci, 2.25)
  assert.deepEqual(parseFwciStore(serializeFwciStore(store)), store)
})

test('a stored null survives parsing -- it records that OpenAlex has no value', () => {
  const store = parseFwciStore(storeJson({ '10.1/new': { fwci: null, checkedAt: NOW.toString() } }))
  const record = getFwciRecord(store, '10.1/new')
  assert.ok(record, 'the record should be kept')
  assert.equal(record.fwci, null)
})

test('malformed entries are dropped without taking the rest with them', () => {
  const store = parseFwciStore(
    storeJson({
      '10.1/good': { fwci: 1, checkedAt: NOW.toString() },
      '10.1/no-date': { fwci: 1 },
      '10.1/empty-date': { fwci: 1, checkedAt: '' },
      '10.1/nan': { fwci: Number.NaN, checkedAt: NOW.toString() }, // serializes to null...
      '10.1/text': { fwci: 'high', checkedAt: NOW.toString() },
      '10.1/not-an-object': 3,
      '': { fwci: 1, checkedAt: NOW.toString() },
    }),
  )
  // ...so NaN arrives as null and is kept as "no value", which is correct: the
  // alternative is dropping an entry whose JSON is indistinguishable from a
  // legitimate null.
  assert.deepEqual(Object.keys(store.entries).sort(), ['10.1/good', '10.1/nan'])
  assert.equal(getFwciRecord(store, '10.1/nan')?.fwci, null)
})

test('putFwciRecord writes in place and stamps the time', () => {
  const store = emptyFwciStore()
  putFwciRecord(store, '10.1/A', 3.5, NOW)
  putFwciRecord(store, '10.1/b', null, NOW)
  assert.deepEqual(getFwciRecord(store, '10.1/a'), { fwci: 3.5, checkedAt: NOW.toString() })
  assert.equal(getFwciRecord(store, '10.1/b')?.fwci, null)
  assert.equal(fwciStoreSize(store), 2)
})

test('a missing record is always due', () => {
  assert.equal(needsFwciRefresh(undefined, NOW, 6), true)
})

test('the cutoff is measured in months of thirty days', () => {
  const fresh = { fwci: 1, checkedAt: monthsAgo(5).toString() }
  const stale = { fwci: 1, checkedAt: monthsAgo(7).toString() }
  assert.equal(needsFwciRefresh(fresh, NOW, 6), false)
  assert.equal(needsFwciRefresh(stale, NOW, 6), true)
  // The same record against the other offered cutoffs.
  assert.equal(needsFwciRefresh(stale, NOW, 12), false)
  assert.equal(needsFwciRefresh(fresh, NOW, 3), true)
})

test('a null value ages on the same clock as a real one', () => {
  // Recent papers have no FWCI yet, and they are exactly what a user re-runs a
  // refresh for. They come due, but not on every run.
  const recentMiss = { fwci: null, checkedAt: monthsAgo(1).toString() }
  const oldMiss = { fwci: null, checkedAt: monthsAgo(7).toString() }
  assert.equal(needsFwciRefresh(recentMiss, NOW, 6), false)
  assert.equal(needsFwciRefresh(oldMiss, NOW, 6), true)
})

test('an undateable record is due rather than assumed fresh', () => {
  assert.equal(needsFwciRefresh({ fwci: 1, checkedAt: 'not-a-date' }, NOW, 6), true)
})
