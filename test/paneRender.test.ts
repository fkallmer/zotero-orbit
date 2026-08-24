/**
 * The item pane section, rendered into a real DOM.
 *
 * Same reasoning as the graph's render test: everything else here works on
 * strings and objects, and the pane's job is to put elements in a container.
 * It had no coverage at all until the README needed a screenshot of it, which
 * is a poor reason to find that out.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { parseHTML } from 'linkedom'

import { normalizeSource, normalizeWork } from '../src/modules/openAlexClient.core.ts'

const { window, document, DOMParser } = parseHTML('<html><body></body></html>')
const noop = (): void => {}
const anything = new Proxy(noop, { get: () => noop, apply: () => undefined })
/** The names the Extra field is written with, from addon.ftl. */
const DATABASE_NAMES: Record<string, string> = {
  'orbit-database-crossref': 'Crossref',
  'orbit-database-openalex': 'OpenAlex',
  'orbit-database-semanticscholar': 'SemanticScholar',
  'orbit-database-googlescholar': 'Google Scholar',
  'orbit-database-inspire': 'INSPIRE',
}

const globals = globalThis as unknown as Record<string, unknown>
globals.Zotero = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === 'debug' || key === 'launchURL' || key === 'logError') return noop
      if (key === 'getActiveZoteroPane') return () => null
      if (key === 'Prefs')
        return { get: (name: string) => (name.endsWith('useColors') ? 'color' : undefined), set: noop }
      return anything
    },
  },
)
globals.window = window
globals.document = document
globals.DOMParser = DOMParser
globals.addon = {
  data: {
    config: { addonID: 'orbit@fkallmer.dev', addonRef: 'orbit', addonInstance: 'Orbit' },
    /**
     * Message ids come back as themselves, which is enough to assert
     * structure -- except for the source names, which the Extra field is
     * written with and parsed against. Those have to be the real ones or the
     * counts never match.
     */
    locale: {
      current: {
        formatMessagesSync: (reqs: { id: string }[]) =>
          reqs.map(({ id }) => ({ value: DATABASE_NAMES[id] ?? id, attributes: null })),
      },
    },
  },
}
globals.ztoolkit = new Proxy({}, { get: () => noop })

const { renderInto } = await import('../src/modules/citationPane.ts')

const work = normalizeWork(JSON.parse(readFileSync(new URL('./fixtures/openalex-work.json', import.meta.url), 'utf8')))
const journal = normalizeSource(
  JSON.parse(readFileSync(new URL('./fixtures/openalex-source.json', import.meta.url), 'utf8')),
)

/** An item whose Extra field carries counts, as a tallied item's does. */
function itemWith(extra: string): unknown {
  return { id: 1, isRegularItem: () => true, libraryID: 1, getField: (f: string) => (f === 'extra' ? extra : '') }
}

function render(extra = '', data: Record<string, unknown> = {}): Element {
  const body = document.createElement('div')
  document.body.append(body)
  renderInto(
    document as never,
    body as never,
    itemWith(extra) as never,
    {
      record: work,
      journal,
      s2: null,
      references: [],
      inLibrary: new Map(),
      ...data,
    } as never,
  )
  return body as never
}

describe('the item pane section', () => {
  it('puts something in the body', () => {
    assert.ok((render().textContent ?? '').length > 0)
  })

  it('reads the counts out of the Extra field, one row per source', () => {
    // The disagreement between sources is the reason the section exists, so
    // every stored count has to reach the page.
    const body = render('Citations: 19 (Crossref)\nCitations: 41 (Google Scholar)')
    const text = body.textContent ?? ''
    assert.ok(text.includes('19'), 'the Crossref count is missing')
    assert.ok(text.includes('41'), 'the Google Scholar count is missing')
  })

  it('ignores an Extra line that is not a citation count', () => {
    const body = render('Citations: 19 (Crossref)\nGSCC: 0000014\ntex.ids: someKey')
    assert.ok(!(body.textContent ?? '').includes('0000014'))
  })

  it('says so rather than rendering an empty box when OpenAlex knows nothing', () => {
    const body = render('', { record: null, journal: null })
    assert.ok((body.textContent ?? '').includes('pane-no-openalex'))
  })

  it('puts a retraction above everything else', () => {
    const body = render('', { record: { ...work, isRetracted: true } })
    const text = body.textContent ?? ''
    assert.ok(text.includes('pane-retracted'))
    assert.ok(text.indexOf('pane-retracted') < text.indexOf('pane-heading-citations'), 'the warning is not first')
  })

  it('emits well-formed markup for the chart it draws', () => {
    // The chart is parsed with DOMParser as XML in the pane, as the graph is.
    const svg = render().querySelector('svg')
    assert.ok(svg, 'no chart')
  })

  it('starts from an empty body, so a re-render cannot double up', () => {
    const body = document.createElement('div')
    document.body.append(body)
    const args = [
      document,
      body,
      itemWith('Citations: 19 (Crossref)'),
      { record: work, journal, s2: null, references: [], inLibrary: new Map() },
    ]
    renderInto(...(args as never))
    const once = body.childNodes.length
    renderInto(...(args as never))
    assert.equal(body.childNodes.length, once)
  })
})
