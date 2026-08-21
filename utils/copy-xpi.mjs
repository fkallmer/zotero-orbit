// Post-processes the built XPI and copies it somewhere reachable.
//
// Two things happen here that the scaffold will not do:
//
//  1. `update_url` is stripped. The scaffold injects one derived from the git
//     remote, which for this fork still points at the upstream repository. An
//     update manifest that does not list this addon's id is not something to
//     hand Zotero -- the fork has no release channel of its own, so it should
//     not advertise one.
//  2. The XPI is copied out of the hidden `.scaffold` directory, so it can be
//     picked in Finder and in Zotero's install dialog.
import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const xpi = resolve('.scaffold/build/citation-tally.xpi')
const target = resolve('..', 'citation-tally.xpi')

const work = mkdtempSync(join(tmpdir(), 'xpi-manifest-'))
try {
  execFileSync('unzip', ['-o', '-q', xpi, 'manifest.json', '-d', work])
  const manifestPath = join(work, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  const zotero = manifest.applications?.zotero
  if (zotero && 'update_url' in zotero) {
    delete zotero.update_url
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    // `zip` replaces the entry in place, keeping the rest of the archive.
    execFileSync('zip', ['-q', '-j', xpi, manifestPath])
    console.log('Stripped upstream update_url from manifest.json')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

copyFileSync(xpi, target)
console.log(`XPI -> ${target}`)
