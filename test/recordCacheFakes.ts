/**
 * A fake disk and data directory for the record cache tests.
 *
 * The cache loads once per process, by design, so each start-up scenario
 * lives in its own test file -- `node --test` gives every file a process of
 * its own. Importing the module twice under different URLs would give fresh
 * state too, but the coverage report then lists each copy as a separate file
 * and the totals stop meaning anything.
 */

import assert from 'node:assert/strict'

export const DAY = 24 * 60 * 60 * 1000
export const TTL = 14 * DAY
export const FLUSH_DELAY = 5000
export const CACHE_PATH = '/data/orbit-cache.json'
export const CACHE_VERSION = 3

export interface Entry {
  storedAt: number
  value: unknown
}

/** The fake disk: path -> contents. */
export const disk = {
  files: new Map<string, string>(),
  writes: [] as string[],
  failWrites: false,
  reset(): void {
    this.files.clear()
    this.writes.length = 0
    this.failWrites = false
  },
}

const globals = globalThis as unknown as Record<string, unknown>
globals.PathUtils = { join: (...parts: string[]) => parts.join('/') }
globals.IOUtils = { exists: async (path: string) => disk.files.has(path) }
globals.Zotero = {
  DataDirectory: { dir: '/data' },
  File: {
    getContentsAsync: async (path: string) => {
      const contents = disk.files.get(path)
      if (contents === undefined) throw new Error(`no such file: ${path}`)
      return contents
    },
    putContentsAsync: async (path: string, contents: string) => {
      if (disk.failWrites) throw new Error('disk full')
      disk.writes.push(contents)
      disk.files.set(path, contents)
    },
  },
  // debugLog reads this; off keeps ztoolkit out of the picture.
  Prefs: { get: () => undefined },
}

export function cacheFile(entries: Record<string, Entry>, version = CACHE_VERSION): string {
  return JSON.stringify({ version, entries })
}

/** What the last write put on disk. */
export function lastWritten(): { version: number; entries: Record<string, Entry> } {
  const last = disk.writes.at(-1)
  assert.ok(last !== undefined, 'nothing was written')
  return JSON.parse(last)
}

/** Let a timer's fire-and-forget flush finish its await. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}
