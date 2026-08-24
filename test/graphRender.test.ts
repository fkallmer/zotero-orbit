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
  // linkedom lays nothing out, and the wheel handler divides by the viewport
  // width. Without a box every anchor becomes NaN and the transform with it.
  // A tab-sized plot. Too small a one leaves the pointed-at mark's wrapped
  // label nowhere to go, and the test would be measuring the fallback.
  const box = { left: 0, top: 0, right: 900, bottom: 500, width: 900, height: 500, x: 0, y: 0 }
  window.Element.prototype.getBoundingClientRect = () => box
  // And a size. Without one the layout is built on NaN and every assertion
  // below counts elements that are drawn at nowhere.
  Object.defineProperty(window.Element.prototype, 'clientWidth', { get: () => box.width, configurable: true })
  Object.defineProperty(window.Element.prototype, 'clientHeight', { get: () => box.height, configurable: true })
  globals.addon = { data: { config: { addonID: 'test', addonRef: 'citationtally', addonInstance: 'test' } } }
  globals.ztoolkit = new Proxy({}, { get: () => noop })
}
// Imported after the globals exist: the module graph touches Zotero on load.
const { renderGraph } = await import('../src/modules/graphTab.ts')

let containers = 0

function render(nodes: readonly GraphNode[]): Rendered {
  const container = document.createElement('div')
  // Zotero gives every tab-content the tab's id, and the graph namespaces its
  // SVG defs with it. Rendering without one here would let two graphs share
  // the ids and hide exactly the bug this guards against.
  container.id = `tab-${++containers}`
  document.body.append(container)
  renderGraph(window as any, container as any, { kind: 'items', itemIDs: [1], name: 'A work' } as any, nodes as any)
  return { container, plot: container.querySelector('[data-role="content"]')?.ownerSVGElement ?? container }
}

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

  it('places every mark at a real coordinate', () => {
    // The layout is arithmetic on a measured width. When the measurement is
    // missing that arithmetic yields NaN, nothing throws, and every mark is
    // drawn at nowhere -- which looks exactly like the plot never rendered.
    const { container } = render(nodes)
    for (const mark of container.querySelectorAll('[data-mark]')) {
      const at = mark.getAttribute('data-at') ?? ''
      assert.ok(
        at.split(',').every((value: string) => Number.isFinite(Number(value))),
        `a mark sits at "${at}"`,
      )
    }
  })

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
    // Scale toggle, four rail buttons, and one filter switch per group.
    assert.equal(container.querySelectorAll('button').length, 5 + container.querySelectorAll('[data-filter]').length)
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

  it('zooms one axis alone when the wheel carries a modifier', () => {
    const { container } = render(nodes)
    const marks = () =>
      [...container.querySelectorAll('[data-mark]')].map((mark: any) =>
        (mark.getAttribute('transform') ?? '')
          .match(/translate\(([-\d.]+),([-\d.]+)\)/)
          ?.slice(1, 3)
          .map(Number),
      )
    const before = marks()
    const svg = container.querySelector('svg[role="img"]') ?? container.querySelector('svg')
    // A firm scroll up, with Shift: horizontal only.
    fire(svg, 'wheel', { deltaY: -400, deltaMode: 0, shiftKey: true, clientX: 300, clientY: 150 })
    const after = marks()

    const movedX = before.some((point: any, index: number) => Math.abs(point[0] - after[index][0]) > 1)
    const movedY = before.some((point: any, index: number) => Math.abs(point[1] - after[index][1]) > 0.01)
    assert.ok(movedX, 'the horizontal did not move')
    assert.ok(!movedY, 'the vertical moved, and should not have')
  })

  describe('pointing at a mark', () => {
    const hover = (container: any, key: string) => {
      const mark = container.querySelector(`[data-mark][data-key="${key}"]`)
      assert.ok(mark, `no mark for ${key}`)
      fire(mark, 'mouseover')
      return mark
    }
    const opacityOf = (container: any, key: string): number =>
      Number(container.querySelector(`[data-mark][data-key="${key}"]`)?.getAttribute('opacity') ?? '1')

    it('pushes the other marks back rather than lighting one up', () => {
      // Brighten-the-one does not read on a plot already full of saturated
      // marks. Nothing is hidden: the dimmed ones keep their tooltip and stay
      // clickable.
      const { container } = render(nodes)
      hover(container, 'ref')
      assert.equal(opacityOf(container, 'ref'), 1)
      assert.ok(opacityOf(container, 'cite') < 0.5, 'the others were not dimmed')
      assert.ok(opacityOf(container, 'seed') < 0.5)
    })

    it('adds the title to that mark, on its own lines, and to nothing else', () => {
      const { container } = render(nodes)
      const showing = () =>
        [...container.querySelectorAll('[data-label]')].filter((slot: any) => slot.getAttribute('opacity') !== '0')

      // At rest every label is a single line of author and year.
      for (const slot of showing()) assert.equal(slot.querySelectorAll('tspan').length, 0)

      hover(container, 'ref')
      const wrapped = showing().filter((slot: any) => slot.querySelectorAll('tspan').length > 0)
      assert.equal(wrapped.length, 1, 'exactly one label should be wrapped')
      const lines = [...wrapped[0].querySelectorAll('tspan')].map((line: any) => line.textContent)
      assert.ok(lines.length >= 2, `expected a title line and a detail line, got ${lines.length}`)
      // The title in full, and the details beneath it.
      assert.ok(lines.join(' ').includes('ref'))
      assert.ok(lines.at(-1)?.includes('·'), `no detail line: ${lines.join(' / ')}`)
    })

    it('names it in the strip above the plot, and gives the strip back on leaving', () => {
      const { container } = render(nodes)
      const strip = container.querySelector('[data-role="strip"]')
      const hint = strip.textContent
      hover(container, 'ref')
      assert.notEqual(strip.textContent, hint)
      assert.ok((strip.textContent ?? '').includes('ref'), 'the strip does not name the work')
      fire(container.querySelector('svg[role="img"]'), 'mouseleave')
      assert.equal(strip.textContent, hint)
    })

    it('keeps the plot from jumping: the strip replaces the hint, it does not join it', () => {
      // A row that appeared on hover would shift every mark out from under the
      // pointer that summoned it.
      const { container } = render(nodes)
      const before = container.querySelectorAll('div').length
      hover(container, 'ref')
      assert.equal(container.querySelectorAll('div').length, before)
    })
  })

  it('draws both graphs when two tabs are open at once', () => {
    // The reported bug: the second tab stayed empty until the first was
    // closed. Both defined `plot-area`, `url(#plot-area)` resolved to the
    // first, and the second plot was clipped by a rectangle sitting in a
    // hidden deck panel that had collapsed to nothing.
    const first = render(nodes)
    const second = render(nodes)
    for (const { container } of [first, second]) {
      const content = container.querySelector('[data-role="content"]')
      assert.ok(content, 'no content group')
      const clip = (content.getAttribute('clip-path') ?? '').replace(/^url\(#|\)$/g, '')
      // The clip it names must be its own, not one from the other tab.
      assert.ok(container.querySelector(`#${clip}`), `${clip} is not in this tab`)
      assert.ok(container.querySelectorAll('[data-mark]').length > 0)
    }
    const clipOf = (rendered: typeof first) =>
      rendered.container.querySelector('[data-role="content"]')?.getAttribute('clip-path')
    assert.notEqual(clipOf(first), clipOf(second))
  })

  describe('the legend as the filter', () => {
    const filtered = [
      makeNode({ key: 'seed', role: 'seed', year: 2019 }),
      makeNode({ key: 'ref', year: 2005 }),
      makeNode({ key: 'cite', role: 'citing', year: 2022 }),
      makeNode({ key: 'filed', year: 2008, itemID: 7 }),
    ]
    const click = (container: any, which: string) => {
      const button = container.querySelector(`[data-filter="${which}"]`)
      assert.ok(button, `no ${which} switch`)
      fire(button, 'click')
    }
    const keys = (container: any) =>
      [...container.querySelectorAll('[data-mark]')].map((mark: any) => mark.getAttribute('data-key'))

    it('offers one switch per group and none for the seed', () => {
      const { container } = render(filtered)
      const switches = [...container.querySelectorAll('[data-filter]')].map((b: any) => b.getAttribute('data-filter'))
      assert.deepEqual(switches.sort(), ['citing', 'inLibrary', 'reference'])
    })

    it('takes a group out and leaves the seed', () => {
      const { container } = render(filtered)
      click(container, 'reference')
      const left = keys(container)
      assert.ok(left.includes('seed'), 'the seed must survive every filter')
      assert.ok(!left.includes('ref'), 'the reference is still drawn')
      assert.ok(left.includes('cite'), 'the wrong group went out')
    })

    it('hides what is already on the shelf, which is how you ask what is missing', () => {
      const { container } = render(filtered)
      click(container, 'inLibrary')
      assert.ok(!keys(container).includes('filed'))
      assert.ok(keys(container).includes('ref'))
    })

    it('puts the group back on a second click', () => {
      const { container } = render(filtered)
      click(container, 'citing')
      assert.ok(!keys(container).includes('cite'))
      click(container, 'citing')
      assert.ok(keys(container).includes('cite'))
    })
  })

  it('says so rather than drawing nothing when no work can be placed', () => {
    const unplaceable = [makeNode({ key: 'a', year: null }), makeNode({ key: 'b', year: null })]
    const { container } = render(unplaceable)
    assert.equal(container.querySelectorAll('[data-mark]').length, 0)
    assert.ok((container.textContent ?? '').length > 0, 'an empty plot with no explanation')
  })
})
