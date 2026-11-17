/**
 * The on-disk cache for OpenAlex and Semantic Scholar records.
 *
 * It sits in front of every item pane and graph, so a cache that serves a
 * record past its lifetime, loses writes, or throws on a damaged file shows
 * up as stale numbers or a blank pane. Disk and clock are both fakes: the
 * file is a string in a map, and time only moves when a test moves it.
 *
 * One module instance serves the whole file, as it serves a whole Zotero
 * session, so every test uses keys of its own. Start-ups from a damaged or
 * outdated file are in recordCache.*.test.ts, each in its own process.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

import {
  CACHE_PATH,
  CACHE_VERSION,
  DAY,
  FLUSH_DELAY,
  TTL,
  cacheFile,
  disk,
  lastWritten,
  settle,
} from './recordCacheFakes.ts'

const START = 100 * DAY

const { loadCache, readCache, writeCache, dropCache, flushCache } = await import('../src/utils/recordCache.ts')

beforeEach(() => {
  disk.reset()
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START })
})

afterEach(async () => {
  // A pending flush timer outlives mock.timers.reset() only as a dead handle
  // the module would still wait on; writing now clears it.
  await flushCache()
  mock.timers.reset()
})

describe('loadCache', () => {
  it('serves the entries of a current file and drops the expired ones', async () => {
    disk.files.set(
      CACHE_PATH,
      cacheFile({
        'load:fresh': { storedAt: START - DAY, value: { count: 1 } },
        'load:stale': { storedAt: START - TTL - 1, value: { count: 2 } },
      }),
    )
    await loadCache()
    assert.deepEqual(readCache('load:fresh'), { count: 1 })
    assert.equal(readCache('load:stale'), null)
  })

  it('reads the disk once, however often it is called', async () => {
    disk.files.set(CACHE_PATH, cacheFile({ 'load:late': { storedAt: START, value: 1 } }))
    await loadCache()
    assert.equal(readCache('load:late'), null)
  })
})

describe('readCache and writeCache', () => {
  it('returns what was written until its lifetime is up', () => {
    writeCache('rw:life', { n: 1 })
    assert.deepEqual(readCache('rw:life'), { n: 1 })

    mock.timers.tick(TTL)
    assert.deepEqual(readCache('rw:life'), { n: 1 }, 'exactly at the limit is still fresh')

    mock.timers.tick(1)
    assert.equal(readCache('rw:life'), null)
  })

  it('applies the lifetime the reader asks for', () => {
    writeCache('rw:short', 1)
    mock.timers.tick(2 * DAY)
    assert.equal(readCache('rw:short', DAY), null)
    // Expired on read means gone, even for a more lenient reader.
    assert.equal(readCache('rw:short', 30 * DAY), null)
  })

  it('a later write replaces the value and restarts its lifetime', () => {
    writeCache('rw:again', 1)
    mock.timers.tick(TTL)
    writeCache('rw:again', 2)
    mock.timers.tick(TTL)
    assert.equal(readCache('rw:again'), 2)
  })
})

describe('writing to disk', () => {
  it('batches writes into one after the delay', async () => {
    writeCache('disk:a', 1)
    writeCache('disk:b', 2)
    mock.timers.tick(FLUSH_DELAY - 1)
    await settle()
    assert.equal(disk.writes.length, 0)

    mock.timers.tick(1)
    await settle()
    assert.equal(disk.writes.length, 1)
    const written = lastWritten()
    assert.equal(written.version, CACHE_VERSION)
    assert.deepEqual(written.entries['disk:a'], { storedAt: START, value: 1 })
    assert.deepEqual(written.entries['disk:b'], { storedAt: START, value: 2 })
  })

  it('writes at once on flushCache, and not again when the timer would have fired', async () => {
    writeCache('disk:now', 1)
    await flushCache()
    assert.equal(disk.writes.length, 1)

    mock.timers.tick(FLUSH_DELAY)
    await settle()
    assert.equal(disk.writes.length, 1)
  })

  it('does not write when nothing changed', async () => {
    await flushCache()
    dropCache('disk:never-written')
    mock.timers.tick(FLUSH_DELAY)
    await settle()
    assert.equal(disk.writes.length, 0)
  })

  it('persists a drop', async () => {
    writeCache('disk:dropped', 1)
    await flushCache()
    dropCache('disk:dropped')
    await flushCache()
    assert.equal(disk.writes.length, 2)
    assert.equal(lastWritten().entries['disk:dropped'], undefined)
  })

  it('persists an expiry noticed on read', async () => {
    writeCache('disk:expires', 1)
    await flushCache()
    mock.timers.tick(TTL + 1)
    assert.equal(readCache('disk:expires'), null)
    mock.timers.tick(FLUSH_DELAY)
    await settle()
    assert.equal(disk.writes.length, 2)
    assert.equal(lastWritten().entries['disk:expires'], undefined)
  })

  it('swallows a failed write and keeps serving from memory', async () => {
    disk.failWrites = true
    writeCache('disk:full', 1)
    await flushCache()
    assert.equal(disk.writes.length, 0)
    assert.equal(readCache('disk:full'), 1)
  })
})

describe('the size ceiling', () => {
  // Last, because it fills the cache and pushes out what earlier tests wrote.
  it('drops expired entries first, then the oldest, once past 2000', () => {
    // Everything earlier tests left behind is now expired, and the first
    // eviction clears it before any live entry has to go.
    mock.timers.tick(2 * TTL + 1)
    for (let i = 0; i < 2001; i++) {
      writeCache(`cap:${i}`, i)
      mock.timers.tick(1)
    }
    assert.equal(readCache('cap:0'), null)
    assert.equal(readCache('cap:1'), 1)
    assert.equal(readCache('cap:2000'), 2000)
  })
})
