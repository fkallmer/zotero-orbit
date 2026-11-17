/**
 * Starting the record cache on a first run, before it has ever written a file.
 * Its own process, because the cache loads once; see recordCacheFakes.ts.
 */

import assert from 'node:assert/strict'
import { it } from 'node:test'

import { disk } from './recordCacheFakes.ts'

const { loadCache, readCache, writeCache } = await import('../src/utils/recordCache.ts')

it('starts empty and usable when there is no cache file', async () => {
  disk.reset()
  await loadCache()
  assert.equal(readCache('work:10.1/a'), null)
  writeCache('work:10.1/a', 1)
  assert.equal(readCache('work:10.1/a'), 1)
})
