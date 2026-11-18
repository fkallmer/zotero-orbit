/**
 * Render a collection graph outside Zotero, for the README screenshot.
 *
 * Like screenshot-pane.mjs: the graph tab's render path runs under linkedom
 * (test/graphRender.test.ts does the same), so this feeds it a network Orbit
 * has already built and cached in the test profile, and writes the resulting
 * markup as a standalone HTML file for a headless browser to photograph. No
 * request is made; everything comes from the cache.
 *
 * Usage, from the repository root, after analysing a collection of public
 * papers in the test profile (`yarn start`):
 *
 *   LANG=en_US.UTF-8 node --import ./test/register.mjs \
 *     utils/screenshot-graph.mjs Orbit-300
 *
 *   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 *   "$CHROME" --headless --disable-gpu --hide-scrollbars \
 *     --force-device-scale-factor=2 --window-size=1440,860 \
 *     --screenshot=docs/assets/readme/collection.png \
 *     "file://$PWD/.scaffold/graph.html"
 *
 * The first argument picks the cached network by its scope's name. Only ever
 * point this at the test profile: the cache holds titles from the library.
 */

import console from 'node:console'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

import { parseHTML } from 'linkedom'

const NAME = process.argv[2] ?? 'Orbit-300'
const OUT = process.argv[3] ?? '.scaffold/graph.html'
const CACHE = '.scaffold/data/orbit-cache.json'
const WIDTH = 1440
const HEIGHT = 860

// --- The cached network ----------------------------------------------------

const entries = JSON.parse(readFileSync(CACHE, 'utf8')).entries
const found = Object.entries(entries)
  .filter(([key, entry]) => key.startsWith('collnet:') && entry.value?.scope?.name === NAME)
  .sort((a, b) => b[1].value.builtAt - a[1].value.builtAt)[0]
if (!found) {
  console.error(`No cached network named "${NAME}" in ${CACHE}`)
  process.exit(1)
}
const cached = found[1].value

// --- Enough Fluent for the graph's strings --------------------------------------

/**
 * `id = value` with indented continuations, `{ $arg }`, and the one select
 * expression the graph uses, on a number: `[one]`, an exact value, or the
 * `*[default]`. Attributes are skipped; the graph asks for none.
 */
function loadMessages(path) {
  const messages = new Map()
  let current = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue
    const head = /^([a-zA-Z][\w-]*)\s*=\s*(.*)$/.exec(line)
    if (head) {
      current = head[1]
      messages.set(current, head[2])
    } else if (/^\s+\./.test(line)) current = null
    else if (current && /^\s+\S/.test(line)) messages.set(current, `${messages.get(current)}\n${line.trim()}`)
  }
  return messages
}

const messages = loadMessages('addon/locale/en-US/addon.ftl')

function select(body, value) {
  const variants = []
  for (const line of body.split('\n')) {
    const match = /^(\*?)\[([^\]]+)\]\s*(.*)$/.exec(line.trim())
    if (match) variants.push({ fallback: match[1] === '*', key: match[2], text: match[3] })
  }
  const exact = variants.find((variant) => variant.key === String(value))
  const plural = value === 1 ? variants.find((variant) => variant.key === 'one') : undefined
  return (exact ?? plural ?? variants.find((variant) => variant.fallback) ?? variants[0])?.text ?? ''
}

function format(id, args = {}) {
  let text = messages.get(id)
  if (text === undefined) return id
  // Resolve select expressions first, innermost braces counted by hand.
  for (let start = text.search(/\{\s*\$[\w-]+\s*->/); start !== -1; start = text.search(/\{\s*\$[\w-]+\s*->/)) {
    let depth = 0
    let end = start
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++
      else if (text[end] === '}' && --depth === 0) break
    }
    const inner = text.slice(start + 1, end)
    const name = /\$([\w-]+)/.exec(inner)[1]
    text = text.slice(0, start) + select(inner.slice(inner.indexOf('->') + 2), args[name]) + text.slice(end + 1)
  }
  return text
    .replace(/\{\s*\$([\w-]+)\s*\}/g, (_, key) => String(args[key] ?? ''))
    .replace(/\{\s*"([^"]*)"\s*\}/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
}

// --- A DOM and the few Zotero members the render path touches ---------------

const { window, document, DOMParser } = parseHTML('<html><body></body></html>')
const noop = () => {}
const anything = new Proxy(noop, { get: () => noop, apply: () => undefined })
globalThis.Zotero = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === 'getActiveZoteroPane') return () => null
      if (key === 'getMainWindow') return () => window
      return anything
    },
  },
)
globalThis.window = window
globalThis.document = document
globalThis.DOMParser = DOMParser
globalThis.requestAnimationFrame = (fn) => {
  fn()
  return 1
}
window.requestAnimationFrame = globalThis.requestAnimationFrame
// The plot sizes itself to its box; here the box is the screenshot, less the
// gaps list beside it and the rows above and below.
const box = { left: 0, top: 0, right: WIDTH - 420, bottom: HEIGHT - 200, width: WIDTH - 420, height: HEIGHT - 200 }
window.Element.prototype.getBoundingClientRect = () => ({ ...box, x: 0, y: 0 })
Object.defineProperty(window.Element.prototype, 'clientWidth', { get: () => box.width, configurable: true })
Object.defineProperty(window.Element.prototype, 'clientHeight', { get: () => box.height, configurable: true })
globalThis.addon = {
  data: {
    config: { addonID: 'screenshot', addonRef: 'orbit', addonInstance: 'screenshot' },
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

const { rematch } = await import('../src/modules/collectionNetwork.core.ts')
const { labelClusters } = await import('../src/modules/clustering.core.ts')
const { renderNetworkGraph } = await import('../src/modules/graphTab.ts')

// --- Revive it the way a cache hit does --------------------------------------

// The stored matches stand in for the library, which is not here to ask.
const matchOf = new Map(cached.works.map((work) => [`${work.title}|${work.year}`, work.match]))
const topicOf = new Map(cached.seeds.map((seed) => [seed.openAlexId, seed.primaryTopic]))
const fallbacks = new Map(cached.clusters.map((cluster) => [cluster.id, cluster.label]))
let net = rematch(cached, (work) => matchOf.get(`${work.title}|${work.year}`) ?? null)
// Names as the current code gives them, in case the cache predates a change.
net = {
  ...net,
  clusters: labelClusters(
    new Map(Object.entries(net.clusterOf)),
    (id) => topicOf.get(id) ?? null,
    (id) => fallbacks.get(id) ?? `Cluster ${id + 1}`,
  ),
}

// --- Render and write ---------------------------------------------------------

const container = document.createElement('div')
document.body.append(container)
renderNetworkGraph(window, container, { kind: 'collection', name: NAME }, net)

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${NAME}</title>
<style>
  html, body { margin: 0; background: #fff; color: #1c1c1e; }
  body {
    font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
  }
  body > div { display: flex; height: 100%; }
</style></head>
<body>${container.outerHTML}</body></html>`
writeFileSync(OUT, html)
console.log(`Wrote ${OUT}: ${net.seeds.length} items, ${net.gaps.length} gaps, ${net.clusters.length} clusters`)
