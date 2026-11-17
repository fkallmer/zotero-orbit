/**
 * Starting the record cache on a file an older Orbit wrote. Entries of an
 * earlier shape once crashed the graph (it read `.length` off a field v1 did
 * not have), so a mismatched file is discarded rather than read. Its own
 * process, because the cache loads once; see recordCacheFakes.ts.
 */

import assert from 'node:assert/strict'
import { it } from 'node:test'

import { CACHE_PATH, CACHE_VERSION, cacheFile, disk } from './recordCacheFakes.ts'

const { loadCache, readCache } = await import('../src/utils/recordCache.ts')

it('discards a file written under another cache version', async () => {
  disk.reset()
  disk.files.set(CACHE_PATH, cacheFile({ 'work:10.1/a': { storedAt: Date.now(), value: {} } }, CACHE_VERSION - 1))
  await loadCache()
  assert.equal(readCache('work:10.1/a'), null)
})
