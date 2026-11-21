import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildWorkByIdUrl,
  openAlexIdRecordCacheKey,
  openAlexRecordCacheKey,
} from '../src/modules/openAlexClient.core.ts'

test('a work is fetched by its bare id, from either form', () => {
  const url = new URL(buildWorkByIdUrl('https://openalex.org/W1565680857', 'id,cited_by_count'))
  assert.equal(url.pathname, '/works/W1565680857')
  assert.equal(url.searchParams.get('select'), 'id,cited_by_count')
  assert.equal(new URL(buildWorkByIdUrl('W1', 'id')).pathname, '/works/W1')
})

test('the id cache key cannot collide with a DOI key', () => {
  assert.equal(openAlexIdRecordCacheKey('https://openalex.org/W12'), 'work:openalex:w12')
  assert.notEqual(openAlexIdRecordCacheKey('W12'), openAlexRecordCacheKey('W12'))
})
