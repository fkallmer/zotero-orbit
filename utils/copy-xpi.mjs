// Copies the built XPI out of the hidden .scaffold directory, so it can be
// found in Finder and in Zotero's install dialog without unhiding anything.
import console from 'node:console'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const source = resolve('.scaffold/build/citation-tally.xpi')
const target = resolve('..', 'citation-tally.xpi')

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`XPI -> ${target}`)
