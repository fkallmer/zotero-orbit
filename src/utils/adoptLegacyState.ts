/**
 * Carry the fork's settings and cache over from the name it used to have.
 *
 * The plugin was called Citation Tally when it was installed, so its
 * preferences live under `extensions.zotero.citationtally` and its cache under
 * `citationtally-cache.json`. Renaming without this leaves a fresh install:
 * the Semantic Scholar key gone, the database order back to default, the
 * ignore list forgotten, and a few hundred records that cost real API credits
 * dropped on the floor.
 *
 * Runs once. Nothing is deleted -- a rename should not be able to lose data
 * even if this is wrong about something, so the old prefs and the old file are
 * left where they are.
 */

import { config } from '../../package.json'

import { debugLog } from './log'
import { getPref, setPref } from './prefs'

const LEGACY_PREFIX = 'extensions.zotero.citationtally'
const LEGACY_CACHE = 'citationtally-cache.json'
const CACHE = 'orbit-cache.json'

/** Values Zotero's pref branch can hold, and which getter reads each. */
const PREF_STRING = 32
const PREF_INT = 64
const PREF_BOOL = 128

/**
 * The subset of nsIPrefBranch this needs.
 *
 * Read through `Zotero.Prefs.rootBranch` rather than `Services.prefs`: the
 * plugin's scope resolves `Zotero` for certain, while `Services` reaches the
 * bootstrap global only through a fall-through this code has no business
 * depending on.
 */
interface PrefBranch {
  getChildList: (prefix: string) => string[]
  prefHasUserValue: (name: string) => boolean
  getPrefType: (name: string) => number
  getBoolPref: (name: string) => boolean
  getIntPref: (name: string) => number
  getStringPref: (name: string) => string
}

function readLegacyPrefs(): Map<string, string | number | boolean> {
  const found = new Map<string, string | number | boolean>()
  const branch = (Zotero.Prefs as unknown as { rootBranch: PrefBranch }).rootBranch
  for (const full of branch.getChildList(`${LEGACY_PREFIX}.`)) {
    // Only what the user actually set: a default-valued pref carries no
    // decision, and copying it would pin today's default forever.
    if (!branch.prefHasUserValue(full)) continue
    const name = full.slice(LEGACY_PREFIX.length + 1)
    switch (branch.getPrefType(full)) {
      case PREF_BOOL:
        found.set(name, branch.getBoolPref(full))
        break
      case PREF_INT:
        found.set(name, branch.getIntPref(full))
        break
      case PREF_STRING:
        found.set(name, branch.getStringPref(full))
        break
      default:
        break
    }
  }
  return found
}

async function adoptCacheFile(): Promise<boolean> {
  const dir = Zotero.DataDirectory.dir
  const legacy = PathUtils.join(dir, LEGACY_CACHE)
  const current = PathUtils.join(dir, CACHE)
  // Copied rather than moved: if this turns out to be the wrong file, the
  // records are still where the old plugin left them.
  if (!(await IOUtils.exists(legacy)) || (await IOUtils.exists(current))) return false
  await IOUtils.copy(legacy, current)
  return true
}

export async function adoptLegacyState(): Promise<void> {
  if (getPref('adoptedLegacyState')) return

  try {
    const legacy = readLegacyPrefs()
    for (const [name, value] of legacy) {
      const key = `${config.prefsPrefix}.${name}`
      // Never overwrite a decision made under the new name.
      if (Zotero.Prefs.get(key, true) !== undefined) continue
      Zotero.Prefs.set(key, value, true)
    }

    const cache = await adoptCacheFile()
    debugLog(`Orbit debug - adopted ${legacy.size} prefs and ${cache ? 'the' : 'no'} cache from Citation Tally`)
  } catch (err) {
    // A failed adoption is a plugin that starts with defaults, not one that
    // does not start. The old values are untouched either way.
    Zotero.debug(`Orbit: could not adopt the previous configuration: ${String(err)}`)
  }

  setPref('adoptedLegacyState', true)
}
