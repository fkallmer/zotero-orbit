/**
 * Rewrite the coverage badges in README.md from a real run.
 *
 * Badges with hand-pasted numbers rot: they keep claiming a figure that was
 * true once, which is worse than claiming nothing. `yarn test:coverage` runs
 * the suite with coverage and pipes it here, so the numbers in the README are
 * only ever the numbers the suite last produced.
 */
import console from 'node:console'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

/**
 * Read the whole report from stdin.
 *
 * As a stream, not readFileSync(0): a pipe is non-blocking here and the
 * synchronous read fails with EAGAIN before the producer has written a byte.
 */
let report = ''
for await (const chunk of process.stdin) report += chunk
// node --test prints "all files | 70.47 | 87.90 | 59.86 |"
const line = /all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(report)
if (!line) {
  console.error('No coverage summary found on stdin. Did the run include --experimental-test-coverage?')
  process.exit(1)
}
const [, lines, branches, functions] = line

/** Green above 80, amber above 60, red below -- the usual reading. */
const colour = (value) => (Number(value) >= 80 ? 'brightgreen' : Number(value) >= 60 ? 'yellow' : 'red')

const path = resolve(import.meta.dirname, '..', 'README.md')
let readme = readFileSync(path, 'utf8')
for (const [name, value] of [
  ['lines', lines],
  ['branches', branches],
  ['functions', functions],
]) {
  const pattern = new RegExp(`badge/${name}-[\\d.]+%25-\\w+\\.svg`)
  if (!pattern.test(readme)) {
    console.error(`No ${name} badge in README.md`)
    process.exit(1)
  }
  readme = readme.replace(pattern, `badge/${name}-${value}%25-${colour(value)}.svg`)
}
writeFileSync(path, readme)
console.log(`Coverage badges: lines ${lines}%, branches ${branches}%, functions ${functions}%`)
