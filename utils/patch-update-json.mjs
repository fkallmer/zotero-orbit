/**
 * Add the last compatible Zotero 7, 8, and 9 releases to the scaffold-generated
 * `update.json` or `update-beta.json`.
 *
 * These entries must stay identical to `LEGACY_UPDATE_ENTRIES` in
 * `scripts/release_simple.py`; `scripts/test_release_simple.py` asserts the parity.
 */

import console from 'node:console'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

/**
 * Older Zotero versions get nothing from Orbit.
 *
 * This list used to carry three Citation Tally releases, so a user on Zotero
 * 7, 8 or 9 would be offered the last build that ran there. Those are another
 * project's artefacts under another add-on id: served from Orbit's update
 * feed they would point at files that do not exist in this repository, and
 * with a different id Zotero would never have treated them as an update
 * anyway. Orbit requires Zotero 10 and has no history before it.
 */
export const LEGACY_ENTRIES = []

function patchBuiltManifests() {
  const root = resolve(import.meta.dirname, '..')
  const buildDir = resolve(root, '.scaffold/build')

  const candidates = ['update.json', 'update-beta.json']
  let patched = 0

  for (const filename of candidates) {
    const filepath = resolve(buildDir, filename)
    if (!existsSync(filepath)) continue

    const data = JSON.parse(readFileSync(filepath, 'utf-8'))
    const addonId = Object.keys(data.addons)[0]

    data.addons[addonId].updates.push(...LEGACY_ENTRIES)

    writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    console.log(`Injected ${LEGACY_ENTRIES.length} legacy update entries into ${filename}`)
    patched++
  }

  if (patched === 0) {
    console.error('No update JSON found in .scaffold/build/')
    process.exit(1)
  }
}

// Guarded so `LEGACY_ENTRIES` can be imported (by the parity test) without
// patching anything.
if (import.meta.main) {
  patchBuiltManifests()
}
