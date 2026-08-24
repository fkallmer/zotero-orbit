/**
 * The graph tab, rendered into a real DOM.
 *
 * Every other test here works on strings and objects. That left the one step
 * the tab actually performs -- parse the markup, import it, hang listeners on
 * it, put it in the container -- with no coverage at all, and it shipped blank
 * once: `<g data-mark>` is fine in HTML and fatal in the XML parser the tab
 * uses, so 296 green tests said nothing about a plugin that drew nothing.
 *
 * So this asserts what the reader would see. The Zotero surface is stubbed to
 * the few members the render path touches; anything beyond it would be a test
 * of the stub rather than of the code.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseHTML } from 'linkedom'

import type { GraphNode } from '../src/modules/graphModel.core.ts'

interface Rendered {
  container: Element
  plot: Element
}

function makeNode(partial: Partial<GraphNode> & { key: string }): GraphNode {
  return {
    title: partial.key,
    year: 2020,
    citedByCount: 10,
    role: 'reference',
    doi: null,
    author: 'Author',
    referenceCount: 12,
    itemID: null,
    ...partial,
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
// Top level, not in a hook: the stubs must exist before the module graph is
// imported, and node:test cancels a suite whose async hook outlives it.
const { window, document, DOMParser } = parseHTML('<html><body><div id="tab"></div></body></html>')
{
  const noop = (): void => {}
  const anything = new Proxy(noop, { get: () => noop, apply: () => undefined })
  const globals = globalThis as any
  globals.Zotero = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'debug' || key === 'launchURL') return noop
        if (key === 'getActiveZoteroPane') return () => null
        if (key === 'getMainWindow') return () => window
        return anything
      },
    },
  )
  globals.window = window
  globals.document = document
  globals.DOMParser = DOMParser
  globals.requestAnimationFrame = (fn: () => void) => {
    fn()
    return 1
  }
  window.requestAnimationFrame = globals.requestAnimationFrame
  globals.addon = { data: { config: { addonID: 'test', addonRef: 'citationtally', addonInstance: 'test' } } }
  globals.ztoolkit = new Proxy({}, { get: () => noop })
}
// Imported after the globals exist: the module graph touches Zotero on load.
const { renderGraph } = await import('../src/modules/graphTab.ts')

function render(nodes: readonly GraphNode[]): Rendered {
  const container = document.createElement('div')
  document.body.append(container)
  renderGraph(window as any, container as any, { kind: 'items', itemIDs: [1], name: 'A work' } as any, nodes as any)
  return { container, plot: container.querySelector('[data-role="content"]')?.ownerSVGElement ?? container }
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

/**
 * A click, or a key. linkedom has no MouseEvent or KeyboardEvent, so the few
 * properties the handlers read are hung on a plain Event.
 */
function fire(target: any, type: string, extra: Record<string, unknown> = {}): void {
  const event = new window.Event(type, { bubbles: true }) as any
  Object.assign(event, extra)
  target.dispatchEvent(event)
}

describe('the tab as the reader sees it', () => {
  const nodes = [
    makeNode({ key: 'seed', role: 'seed', year: 2019, citedByCount: 6, doi: '10.1/seed' }),
    makeNode({ key: 'ref', year: 2005, citedByCount: 1822, itemID: 42 }),
    makeNode({ key: 'cite', role: 'citing', year: 2022, citedByCount: 3 }),
  ]

  it('puts an actual drawing in the container', () => {
    // The failure this exists for: a parse error left the plot empty while
    // every string-level assertion still passed.
    const { container } = render(nodes)
    const svgs = container.querySelectorAll('svg')
    assert.ok(svgs.length > 0, 'no svg reached the container at all')
    assert.ok(container.querySelectorAll('[data-mark]').length === nodes.length)
  })

  it('draws one circle per mark, plus the seed halo and the library collar', () => {
    const { container } = render(nodes)
    // three marks + one halo on the seed + one collar on the filed work
    assert.equal(container.querySelectorAll('circle').length, 5)
  })

  it('renders the frame around it: axis, captions, legend and the button rail', () => {
    const { container } = render(nodes)
    assert.ok(container.querySelectorAll('[data-axis="x"]').length > 0)
    assert.ok(container.querySelectorAll('[data-axis="y"]').length > 0)
    assert.equal(container.querySelectorAll('button').length, 5) // scale toggle + four rail buttons
    assert.equal(container.querySelectorAll('select').length, 2) // one per axis
  })

  it('survives a work with no year, no counts and no title', () => {
    const bare = [makeNode({ key: 'seed', role: 'seed' }), makeNode({ key: 'x', year: null, citedByCount: null })]
    const { container } = render(bare)
    assert.ok(container.querySelectorAll('svg').length > 0)
  })

  it('opens a card on a mark rather than leaving with the reader', () => {
    // A click used to open the DOI outright. The card is what it opens now, so
    // a throw in there is a click that does nothing at all.
    const { container } = render(nodes)
    const mark = container.querySelector('circle[data-key="ref"]')
    assert.ok(mark, 'no mark to click')
    fire(mark, 'click', { clientX: 120, clientY: 90 })
    const text = container.textContent ?? ''
    assert.ok(text.includes('ref'), 'the card did not appear')
  })

  it('closes the card again on Escape', () => {
    const { container } = render(nodes)
    const before = container.querySelectorAll('div').length
    fire(container.querySelector('circle[data-key="ref"]'), 'click', { clientX: 120, clientY: 90 })
    assert.ok(container.querySelectorAll('div').length > before, 'nothing was added')
    fire(document, 'keydown', { key: 'Escape' })
    assert.equal(container.querySelectorAll('div').length, before)
  })

  it('says so rather than drawing nothing when no work can be placed', () => {
    const unplaceable = [makeNode({ key: 'a', year: null }), makeNode({ key: 'b', year: null })]
    const { container } = render(unplaceable)
    assert.equal(container.querySelectorAll('[data-mark]').length, 0)
    assert.ok((container.textContent ?? '').length > 0, 'an empty plot with no explanation')
  })
})
