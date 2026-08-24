// Copies the built XPI out of the hidden `.scaffold` directory, so it can be
// picked in Finder and in Zotero's install dialog.
//
// It is copied byte for byte on purpose. An earlier version unpacked the
// archive, edited manifest.json to drop the upstream `update_url`, and repacked
// it -- and Zotero then refused the result with "may be incompatible with this
// version", while the untouched archive from the same build installed fine.
// Whatever the installer objected to, post-processing the package is not worth
// it: the fork's addon id does not appear in upstream's update manifest, so the
// update check finds nothing to offer.
import console from 'node:console'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = resolve('.scaffold/build/orbit.xpi')
const target = resolve('..', 'orbit.xpi')

copyFileSync(source, target)
console.log(`XPI -> ${target}`)
