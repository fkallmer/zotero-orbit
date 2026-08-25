/**
 * Render the item pane section outside Zotero, for the README screenshot.
 *
 * The pane is Zotero chrome, so it cannot be captured from anywhere but a
 * running Zotero -- except that the render path is deliberately free of Zotero
 * dependencies, which is what `test/paneRender.test.ts` exercises. This walks
 * the same path with the real en-US strings and real OpenAlex data and writes a
 * standalone HTML file, which a headless browser can then photograph.
 *
 * What comes out is the plugin's own markup: the pane styles itself inline and
 * uses no Zotero classes. Only the surrounding font, colours and width are
 * supplied here, standing in for the chrome around it.
 *
 * Usage, from the repository root. `LANG` matters: number formatting follows
 * the runtime locale, and a German shell turns 12,690 into 12.690 in an
 * otherwise English screenshot.
 *
 *   LANG=en_US.UTF-8 node --import ./test/register.mjs \
 *     utils/screenshot-pane.mjs 10.1257/aer.101.7.3221
 *
 * Then size the capture to the content rather than guessing: the page reports
 * its own height in the title, so read it back with --dump-dom first.
 *
 *   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 *   H=$("$CHROME" --headless --dump-dom "file://$PWD/.scaffold/pane.html" \
 *       | grep -o 'h=[0-9][0-9]*' | head -1 | cut -d= -f2)
 *   "$CHROME" --headless --disable-gpu --hide-scrollbars \
 *     --force-device-scale-factor=2 --window-size=384,$H \
 *     --screenshot=docs/assets/readme/item-pane.png \
 *     "file://$PWD/.scaffold/pane.html"
 *
 * Pick a paper with few authors and check the affiliations before publishing
 * the result. The pane lists every author and institution OpenAlex reports, a
 * thirty-author record makes an image nobody reads, and OpenAlex affiliations
 * are wrong often enough to matter in a README -- it puts Yann LeCun at a
 * medical centre.
 */

import console from 'node:console'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import process from 'node:process'

import { parseHTML } from 'linkedom'

// Node has had a global fetch since 18; the lint config's globals for this
// directory have not caught up, and the repository carries no eslint-disable.
const { fetch } = globalThis

const DOI = process.argv[2] ?? '10.1038/nature14539'
const OUT = process.argv[3] ?? '.scaffold/pane.html'
const CONTACT = 'orbit@fkallmer.dev'

const FULL_SELECT = [
  'id,doi,display_name,publication_year,type,is_retracted,cited_by_count,counts_by_year,fwci',
  'cited_by_percentile_year,open_access,best_oa_location,primary_location,apc_list,apc_paid',
  'authorships,funders,awards,referenced_works,referenced_works_count,updated_date',
].join(',')
const REFERENCE_SELECT = 'id,doi,display_name,publication_year,cited_by_count,referenced_works_count,authorships'

async function openAlex(path) {
  const url = `https://api.openalex.org/${path}${path.includes('?') ? '&' : '?'}mailto=${encodeURIComponent(CONTACT)}`
  const response = await fetch(url, { headers: { 'User-Agent': 'orbit-screenshot/1.0' } })
  if (!response.ok) throw new Error(`OpenAlex ${response.status} for ${path}`)
  return response.json()
}

/**
 * The real strings, parsed straight out of the FTL.
 *
 * Enough Fluent for this file: `id = value`, `.attribute = value`, indented
 * continuations, and `{ $arg }` substitution. The pane uses no select
 * expressions -- if it ever does, this has to grow.
 */
function loadMessages(path) {
  const messages = new Map()
  let current = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    let match = /^([a-zA-Z][\w-]*)\s*=\s*(.*)$/.exec(line)
    if (match) {
      current = match[1]
      messages.set(current, match[2])
      continue
    }
    match = /^\s+\.([\w-]+)\s*=\s*(.*)$/.exec(line)
    if (match && current) {
      messages.set(`${current}.${match[1]}`, match[2])
      continue
    }
    match = /^\s{4,}(\S.*)$/.exec(line)
    if (match && current) messages.set(current, `${messages.get(current) ?? ''} ${match[1]}`.trim())
  }
  return messages
}

const messages = loadMessages('addon/locale/en-US/addon.ftl')
function format(id, args) {
  const value = messages.get(id)
  if (value === undefined) return id
  return value.replace(/\{\s*\$([\w-]+)\s*\}/g, (_, key) => String(args?.[key] ?? ''))
}

const { window, document, DOMParser } = parseHTML('<html><body></body></html>')
const noop = () => {}
const anything = new Proxy(noop, { get: () => noop, apply: () => undefined })

// The few members the render path touches, same as the render test stubs.
globalThis.Zotero = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === 'debug' || key === 'launchURL' || key === 'logError') return noop
      if (key === 'getActiveZoteroPane') return () => null
      if (key === 'Prefs') {
        return { get: (name) => (String(name).endsWith('useColors') ? 'color' : undefined), set: noop }
      }
      return anything
    },
  },
)
globalThis.window = window
globalThis.document = document
globalThis.DOMParser = DOMParser
globalThis.addon = {
  data: {
    config: { addonID: 'orbit@fkallmer.dev', addonRef: 'orbit', addonInstance: 'Orbit' },
    // getLocaleID prefixes every id with the addonRef; strip it back off.
    locale: {
      current: {
        formatMessagesSync: (requests) =>
          requests.map(({ id, args }) => ({
            value: format(String(id).replace(/^orbit-/, ''), args),
            attributes: null,
          })),
      },
    },
  },
}
globalThis.ztoolkit = new Proxy({}, { get: () => noop })

const { normalizeReferences, normalizeSource, normalizeWork } = await import('../src/modules/openAlexClient.core.ts')
const { renderInto } = await import('../src/modules/citationPane.ts')

const workJson = await openAlex(`works/doi:${encodeURIComponent(DOI)}?select=${encodeURIComponent(FULL_SELECT)}`)
const record = normalizeWork(workJson)
if (!record) throw new Error(`OpenAlex has no usable record for ${DOI}`)

const sourceId = (workJson.primary_location?.source?.id ?? '').split('/').pop()
const journal = sourceId ? normalizeSource(await openAlex(`sources/${sourceId}`)) : null

const referenceIds = (workJson.referenced_works ?? []).map((id) => id.split('/').pop()).slice(0, 50)
const references =
  referenceIds.length === 0
    ? []
    : normalizeReferences(
        await openAlex(
          `works?filter=openalex_id:${referenceIds.join('|')}` +
            `&select=${encodeURIComponent(REFERENCE_SELECT)}&per-page=50`,
        ),
      )

/**
 * Counts as a tallied item carries them, one line per source, every number
 * fetched rather than invented.
 *
 * The disagreement between sources is the thing the pane exists to show, so
 * making it up would misrepresent exactly the point -- and the real spread is
 * the better picture anyway: Semantic Scholar often comes in *below* Crossref
 * while OpenAlex sits above both, which no plausible-looking fabrication
 * produces. Google Scholar is absent because there is no API for it, and the
 * pane shows whichever sources are configured.
 *
 * A source that does not answer is left out rather than guessed at.
 */
async function crossrefCount(doi) {
  try {
    const response = await fetch(`https://api.crossref.org/works/${doi}`, {
      headers: { 'User-Agent': `orbit-screenshot/1.0 (mailto:${CONTACT})` },
    })
    if (!response.ok) return null
    const body = await response.json()
    return body.message?.['is-referenced-by-count'] ?? null
  } catch {
    return null
  }
}

async function semanticScholarCount(doi) {
  try {
    const response = await fetch(`https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=citationCount`, {
      headers: { 'User-Agent': 'orbit-screenshot/1.0' },
    })
    if (!response.ok) return null
    const body = await response.json()
    return typeof body.citationCount === 'number' ? body.citationCount : null
  } catch {
    return null
  }
}

const counts = [
  ['Crossref', await crossrefCount(DOI)],
  ['OpenAlex', record.citedByCount],
  ['SemanticScholar', await semanticScholarCount(DOI)],
].filter(([, count]) => typeof count === 'number')
const stamp = (workJson.updated_date ?? '').slice(0, 10) || '2026-01-01'
const extra = counts.map(([name, count]) => `Citations: ${count} (${name}) [${stamp}]`).join('\n')

const item = {
  id: 1,
  isRegularItem: () => true,
  libraryID: 1,
  getField: (field) => (field === 'extra' ? extra : ''),
}

// Two references marked as held, so the ✓ rows appear beside the linked ones.
const inLibrary = new Map()
for (const reference of references.slice(0, 2)) {
  if (reference.doi) inLibrary.set(reference.doi.toLowerCase(), 100 + inLibrary.size)
}

const body = document.createElement('div')
document.body.append(body)
renderInto(document, body, item, { record, journal, s2: null, references, inLibrary })

const page = `<!doctype html>
<meta charset="utf-8" />
<title>${record.title ?? DOI}</title>
<style>
  :root { color-scheme: light }
  body {
    margin: 0;
    background: #fff;
    color: #000;
    font: 13px/1.45 -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* The width Zotero gives the item pane at its default layout. */
  #pane { width: 360px; padding: 8px 12px; box-sizing: border-box; }
  a { color: #2e69c4; text-decoration: none }
  a:hover { text-decoration: underline }
</style>
<div id="pane">${body.innerHTML}</div>
<script>
  // So the caller can size the capture to the content instead of guessing:
  // run Chrome with --dump-dom first and read this back out of the title.
  document.title = 'h=' + document.documentElement.scrollHeight
</script>
`

mkdirSync(OUT.replace(/\/[^/]*$/, ''), { recursive: true })
writeFileSync(OUT, page)
console.log(`${record.title} — fwci ${record.fwci}, ${references.length} references resolved`)
console.log(`wrote ${OUT} (${page.length} bytes, ${body.querySelectorAll('*').length} elements)`)
