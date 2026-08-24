/**
 * Raise the patch version before every build.
 *
 * Zotero keys an installed plugin by version. Two different builds carrying
 * the same one are, to it, the same plugin: reinstalling can leave the old
 * code in place, and the chrome cache can go on serving files the new XPI has
 * replaced. Every build here exists to be installed, so every build has to be
 * distinguishable from the last.
 *
 * This runs unconditionally rather than trying to detect a real change. The
 * version is baked into the artefact, so "did anything change" cannot be
 * answered by comparing artefacts, and a spent number costs nothing next to a
 * build that silently does not take.
 */
import console from 'node:console'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const path = resolve(import.meta.dirname, '..', 'package.json')
const raw = readFileSync(path, 'utf8')
const pkg = JSON.parse(raw)

const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(pkg.version)
if (!match) {
  console.error(`Cannot bump "${pkg.version}": expected major.minor.patch`)
  process.exit(1)
}
const [, major, minor, patch, suffix] = match
const next = `${major}.${minor}.${Number(patch) + 1}${suffix}`

// Rewritten in place rather than re-serialised: JSON.stringify would reorder
// nothing but would drop the file's own formatting, and this file is edited by
// hand far more often than by this script.
writeFileSync(path, raw.replace(`"version": "${pkg.version}"`, `"version": "${next}"`))
console.log(`Version ${pkg.version} -> ${next}`)
