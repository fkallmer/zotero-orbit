/**
 * Starting the record cache on a file that is not valid JSON -- a write cut
 * off by a crash, say. Its own process, because the cache loads once; see
 * recordCacheFakes.ts.
 */

import assert from 'node:assert/strict'
import { it } from 'node:test'

import { CACHE_PATH, disk } from './recordCacheFakes.ts'

const { loadCache, readCache, writeCache } = await import('../src/utils/recordCache.ts')

it('survives a truncated file and starts empty', async () => {
  disk.reset()
  disk.files.set(CACHE_PATH, '{"version": 3, "entries": {"work:10.1/a": {"storedAt": 1, "val')
  await loadCache()
  assert.equal(readCache('work:10.1/a'), null)
  writeCache('work:10.1/b', 1)
  assert.equal(readCache('work:10.1/b'), 1)
})
