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

import { rankGaps } from '../src/modules/collectionNetwork.core.ts'
import { setOpenAlexApiKey } from '../src/modules/openAlexClient.core.ts'

import type { CollectionNetwork, NetworkWork, SeedWork } from '../src/modules/collectionTypes.ts'
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
/** parseHTML gives this document a body; its type allows null for documents without one. */
const documentBody = document.body as HTMLElement
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
const { renderGraph, renderNetworkGraph, renderNetworkProgress, renderProgress, renderSeedChoice, LOAD_STEPS } =
  await import('../src/modules/graphTab.ts')

let containers = 0

function render(nodes: readonly GraphNode[]): Rendered {
  const container = document.createElement('div')
  // Zotero gives every tab-content the tab's id, and the graph namespaces its
  // SVG defs with it. Rendering without one here would let two graphs share
  // the ids and hide exactly the bug this guards against.
  container.id = `tab-${++containers}`
  documentBody.append(container)
  renderGraph(window as any, container as any, { kind: 'items', itemIDs: [1], name: 'A work' } as any, nodes as any)
  // querySelector types this as Element; ownerSVGElement lives on SVGElement.
  // The cast back to Element is the linkedom boundary, same as the `as any`
  // above: what this returns is a node the assertions read attributes off, and
  // linkedom's SVG nodes do not line up with the SVG types Zotero's DOM
  // declares.
  const content = container.querySelector('[data-role="content"]') as SVGElement | null
  return { container, plot: (content?.ownerSVGElement ?? container) as Element }
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
    makeNode({ key: 'ref', year: 2005, citedByCount: 1822, itemID: 42, doi: '10.1/ref' }),
    makeNode({ key: 'cite', role: 'citing', year: 2022, citedByCount: 3, doi: '10.1/cite' }),
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
    // One per axis, plus the highlight-depth control.
    // One per axis, plus the two that govern the highlight.
    assert.equal(container.querySelectorAll('select').length, 4)
    assert.ok(container.querySelector('[data-control="hops"]'), 'no highlight control')
    assert.ok(container.querySelector('[data-control="direction"]'), 'no direction control')
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
      // Asserted rather than assumed: a missing strip should say so, not throw
      // a TypeError three lines down.
      assert.ok(strip, 'no strip above the plot')
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

  describe('the chain through a mark', () => {
    // seed, then a -> b -> c as a line of descent, and an unrelated d.
    const chained = [
      makeNode({ key: 'seed', role: 'seed', year: 2019 }),
      makeNode({ key: 'a', year: 2004 }),
      makeNode({ key: 'b', year: 2008 }),
      makeNode({ key: 'c', year: 2012 }),
      makeNode({ key: 'd', year: 2016 }),
    ]
    const links = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]
    const draw = () => {
      const container = document.createElement('div')
      container.id = `chain-${++containers}`
      documentBody.append(container)
      renderGraph(window as any, container as any, { kind: 'items', itemIDs: [1], name: 'x' } as any, chained, links)
      return container
    }
    const lit = (container: any) =>
      [...container.querySelectorAll('[data-link]')].filter((line: any) => line.getAttribute('opacity') !== '0').length

    it('shows nothing until a mark is pointed at', () => {
      assert.equal(lit(draw()), 0)
    })

    const opacityOf = (container: any, key: string) =>
      Number(container.querySelector(`[data-mark][data-key="${key}"]`)?.getAttribute('opacity') ?? '1')

    it('lights only what the mark is directly connected to', () => {
      // a -> b is the connection; b -> c is b's business. Lighting it would
      // answer a question about b while the pointer is on a.
      const container = draw()
      fire(container.querySelector('[data-mark][data-key="a"]'), 'mouseover')
      assert.equal(lit(container), 1)
    })

    it('sets the directly connected work apart from the rest', () => {
      const container = draw()
      fire(container.querySelector('[data-mark][data-key="a"]'), 'mouseover')
      assert.equal(opacityOf(container, 'a'), 1)
      assert.ok(opacityOf(container, 'b') > opacityOf(container, 'd'), 'the connected work reads like an unrelated one')
      assert.ok(opacityOf(container, 'b') < 1, 'only the mark being pointed at should be at full strength')
      assert.equal(opacityOf(container, 'c'), opacityOf(container, 'd'), 'a second hop was lit')
    })

    it('takes the other names off the plot rather than dimming them', () => {
      // Twenty dimmed names around the one being read is exactly the crowding
      // the emphasis exists to clear. The marks stay; the captions do not.
      const container = draw()
      const showing = () =>
        [...container.querySelectorAll('[data-label]')]
          .filter((slot: any) => slot.getAttribute('opacity') !== '0')
          .map((slot: any) => slot.textContent)
      assert.ok(showing().length > 2, 'the resting plot should carry several names')
      fire(container.querySelector('[data-mark][data-key="a"]'), 'mouseover')
      const left = showing()
      // The mark itself and the one it links to; c and d are neither.
      assert.ok(
        left.some((text: string) => text.includes('a')),
        'the pointed-at name went too',
      )
      assert.equal(left.length, 2, `expected the mark and its one link, got: ${left.join(' | ')}`)
    })

    it('brings the names back when the pointer leaves', () => {
      const container = draw()
      const showing = () =>
        [...container.querySelectorAll('[data-label]')].filter((s: any) => s.getAttribute('opacity') !== '0').length
      const atRest = showing()
      fire(container.querySelector('[data-mark][data-key="a"]'), 'mouseover')
      assert.ok(showing() < atRest)
      fire(container.querySelector('svg[role="img"]'), 'mouseleave')
      assert.equal(showing(), atRest)
    })

    it('lights the neighbourhood’s edges to the seed, not just the one it is on', () => {
      // Everything on the plot is here because of its relation to this work.
      // Lighting one work's link to it while its neighbours' links stay faint
      // shows a fragment of the structure being asked about.
      const container = draw()
      const seedEdge = (key: string) =>
        [...container.querySelectorAll('[data-edge]:not([data-link])')].find(
          (line: any) => line.getAttribute('data-key') === key,
        ) as any
      fire(container.querySelector('[data-mark][data-key="a"]'), 'mouseover')
      const lit = Number(seedEdge('a')?.getAttribute('opacity'))
      const neighbour = Number(seedEdge('b')?.getAttribute('opacity'))
      const stranger = Number(seedEdge('d')?.getAttribute('opacity'))
      assert.equal(lit, neighbour, 'the linked neighbour’s edge to the seed stayed faint')
      assert.ok(stranger < neighbour, 'an unrelated work’s edge is as bright as a linked one')
    })

    it('thickens what it lights, heads included', () => {
      const container = draw()
      const edge = (key: string) =>
        [...container.querySelectorAll('[data-edge]:not([data-link])')].find(
          (line: any) => line.getAttribute('data-key') === key,
        ) as any
      const before = edge('a').getAttribute('stroke-width')
      fire(container.querySelector('[data-mark][data-key="a"]'), 'mouseover')
      assert.ok(Number(edge('a').getAttribute('stroke-width')) > Number(before))
      assert.equal(edge('a').getAttribute('marker-end'), edge('a').getAttribute('data-arrow-lit'))
      assert.equal(edge('d').getAttribute('marker-end'), edge('d').getAttribute('data-arrow'))
    })

    it('follows one direction only when the control says so', () => {
      // a -> b: from b, a is a work citing it; from a, b is one it cites.
      const container = draw()
      const select = container.querySelector('[data-control="direction"]') as any
      for (const option of select.querySelectorAll('option')) {
        if (option.getAttribute('value') === 'citations') option.selected = true
      }
      fire(select, 'change')
      // Pointing at a, whose only link runs away from it, lights nothing.
      fire(container.querySelector('[data-mark][data-key="a"]'), 'mouseover')
      assert.equal(lit(container), 0, 'followed a reference while asked for citations only')
      // Pointing at b, which a cites, lights that one.
      fire(container.querySelector('[data-mark][data-key="b"]'), 'mouseover')
      assert.equal(lit(container), 1)
    })

    it('reaches further when the control asks for it', () => {
      const container = draw()
      const select = container.querySelector('[data-control="hops"]') as any
      for (const option of select.querySelectorAll('option')) {
        if (option.getAttribute('value') === '2') option.selected = true
      }
      fire(select, 'change')
      fire(container.querySelector('[data-mark][data-key="a"]'), 'mouseover')
      assert.equal(lit(container), 2)
      assert.ok(opacityOf(container, 'c') > opacityOf(container, 'd'))
    })

    it('puts the paths away again when the pointer leaves', () => {
      const container = draw()
      fire(container.querySelector('[data-mark][data-key="a"]'), 'mouseover')
      fire(container.querySelector('svg[role="img"]'), 'mouseleave')
      assert.equal(lit(container), 0)
    })
  })

  describe('holding a mark with a click', () => {
    const held = [
      makeNode({ key: 'seed', role: 'seed', year: 2019 }),
      makeNode({ key: 'a', year: 2010 }),
      makeNode({ key: 'b', year: 2004 }),
    ]
    const drawHeld = () => {
      const container = document.createElement('div')
      container.id = `pin-${++containers}`
      documentBody.append(container)
      renderGraph(window as any, container as any, { kind: 'items', itemIDs: [1], name: 'x' } as any, held, [
        { from: 'a', to: 'b' },
      ])
      return container
    }
    const mark = (container: any, key: string) => container.querySelector(`[data-mark][data-key="${key}"] circle`)
    const opacityOf = (container: any, key: string) =>
      Number(container.querySelector(`[data-mark][data-key="${key}"]`)?.getAttribute('opacity') ?? '1')

    it('keeps the emphasis when the pointer moves off, once a mark is clicked', () => {
      // The reason for holding it: the reader has to be able to leave the mark
      // to reach the card, or to follow a lit path, without the plot changing
      // under them on the way.
      const container = drawHeld()
      fire(mark(container, 'a'), 'click', { clientX: 20, clientY: 20 })
      fire(container.querySelector('svg[role="img"]'), 'mouseleave')
      assert.equal(opacityOf(container, 'a'), 1, 'the held mark lost its emphasis')
      assert.ok(opacityOf(container, 'seed') < 1)
    })

    it('does not let the pointer take the emphasis off a held mark', () => {
      const container = drawHeld()
      fire(mark(container, 'a'), 'click', { clientX: 20, clientY: 20 })
      fire(container.querySelector('[data-mark][data-key="seed"]'), 'mouseover')
      assert.equal(opacityOf(container, 'a'), 1, 'the pointer overrode the held mark')
    })

    it('lets go on a click into empty space', () => {
      const container = drawHeld()
      fire(mark(container, 'a'), 'click', { clientX: 20, clientY: 20 })
      fire(container.querySelector('svg[role="img"]'), 'click')
      assert.equal(opacityOf(container, 'a'), 1, 'nothing is emphasised, so every mark is at full strength')
      assert.equal(opacityOf(container, 'seed'), 1)
    })

    it('lets go on Escape, together with the card', () => {
      const container = drawHeld()
      fire(mark(container, 'a'), 'click', { clientX: 20, clientY: 20 })
      const withCard = container.querySelectorAll('div').length
      fire(document, 'keydown', { key: 'Escape' })
      assert.ok(container.querySelectorAll('div').length < withCard, 'the card stayed')
      assert.equal(opacityOf(container, 'seed'), 1, 'the emphasis outlived the card')
    })
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
      assert.deepEqual(switches.sort(), ['citing', 'library', 'reference'])
    })

    it('takes a group out and leaves the seed', () => {
      const { container } = render(filtered)
      click(container, 'reference')
      const left = keys(container)
      assert.ok(left.includes('seed'), 'the seed must survive every filter')
      assert.ok(!left.includes('ref'), 'the reference is still drawn')
      assert.ok(left.includes('cite'), 'the wrong group went out')
    })

    it('narrows to the shelf, then to what is missing from it, then back', () => {
      // Two questions, one control: "which of these do I have" and "which am
      // I missing" are asked as often as each other.
      const { container } = render(filtered)
      const state = () => container.querySelector('[data-filter="library"]')?.getAttribute('data-state')
      assert.equal(state(), 'all')
      assert.ok(keys(container).includes('filed') && keys(container).includes('ref'))

      click(container, 'library')
      assert.equal(state(), 'only')
      assert.ok(keys(container).includes('filed'), 'the filed work should be the one left')
      assert.ok(!keys(container).includes('ref'), 'an unfiled work survived "only"')

      click(container, 'library')
      assert.equal(state(), 'missing')
      assert.ok(!keys(container).includes('filed'), 'a filed work survived "missing"')
      assert.ok(keys(container).includes('ref'))

      click(container, 'library')
      assert.equal(state(), 'all')
      assert.ok(keys(container).includes('filed') && keys(container).includes('ref'))
    })

    it('keeps the seed through every state of the library switch', () => {
      const { container } = render(filtered)
      for (const _ of ['only', 'missing', 'all']) {
        click(container, 'library')
        assert.ok(keys(container).includes('seed'), 'the seed must survive every filter')
      }
    })

    it('counts what its label names', () => {
      const { container } = render(filtered)
      const text = () => container.querySelector('[data-filter="library"]')?.textContent ?? ''
      assert.ok(text().includes('(1)'), `one work is filed: ${text()}`)
      click(container, 'library')
      assert.ok(text().includes('(1)'))
      click(container, 'library')
      // Now it names the ones that are not filed, and must count those.
      assert.ok(text().includes('(3)'), `three are not filed: ${text()}`)
    })

    it('puts the group back on a second click', () => {
      const { container } = render(filtered)
      click(container, 'citing')
      assert.ok(!keys(container).includes('cite'))
      click(container, 'citing')
      assert.ok(keys(container).includes('cite'))
    })
  })

  describe('the loading bar', () => {
    // renderGraph is the finished state; the bar belongs to what runs before
    // it, so it is exercised through renderProgress directly.
    const seedArg = { kind: 'items', itemIDs: [1], name: 'x' } as any
    const place = () => {
      const container = document.createElement('div')
      documentBody.append(container)
      return container
    }
    const widthAfter = (done: number, step: any) => {
      const container = place()
      renderProgress(document as any, container as any, seedArg, done, step)
      return (container.querySelector('[data-progress] > div') as any)?.style.width
    }

    it('fills one step at a time and ends full', () => {
      // Named steps, not a timer: the bar is only ever behind or exactly
      // right, never ahead of the work.
      assert.deepEqual(
        LOAD_STEPS.map((step: any, index: number) => widthAfter(index + 1, step)),
        ['20%', '40%', '60%', '80%', '100%'],
      )
    })

    it('shows nothing filled before the first step finishes', () => {
      assert.equal(widthAfter(0, 'record'), '0%')
    })

    it('names the step it is on, so the bar is not the only thing moving', () => {
      const container = place()
      renderProgress(document as any, container as any, seedArg, 2, 'citing')
      assert.ok((container.textContent ?? '').includes('graph-step-citing'))
    })
  })

  describe('reloading', () => {
    it('offers no reload when there is nothing to reload with', () => {
      // renderGraph is handed the callback by the tab that fetched; a caller
      // with no way to fetch again must not be given a button that lies.
      const { container } = render(nodes)
      assert.equal(container.querySelector('[data-control="reload"]'), null)
    })

    it('asks the caller to fetch again, once per press', () => {
      const container = document.createElement('div')
      container.id = `reload-${++containers}`
      documentBody.append(container)
      let asked = 0
      renderGraph(window as any, container as any, { kind: 'items', itemIDs: [1], name: 'x' } as any, nodes, [], () => {
        asked++
      })
      const button = container.querySelector('[data-control="reload"]')
      assert.ok(button, 'no reload button')
      fire(button, 'click')
      assert.equal(asked, 1)
      fire(button, 'click')
      assert.equal(asked, 2)
    })
  })

  describe('what the card offers', () => {
    const labelsIn = (container: any) =>
      [...container.querySelectorAll('button')].map((b: any) => b.textContent).filter(Boolean)

    it('offers a graph from that work, whether or not it is filed', () => {
      // The graph exists to surface work the reader does not have. Requiring
      // it to be in the library first would refuse exactly that case.
      const { container } = render(nodes)
      const unfiled = container.querySelector('[data-mark][data-key="cite"] circle')
      fire(unfiled, 'click', { clientX: 30, clientY: 30 })
      const buttons = labelsIn(container).join(' | ')
      assert.ok(buttons.includes('graph-card-graph'), `no graph action: ${buttons}`)
    })

    it('offers the work at its source as well as at the publisher', () => {
      const { container } = render(nodes)
      fire(container.querySelector('[data-mark][data-key="ref"]'), 'click', { clientX: 30, clientY: 30 })
      const buttons = labelsIn(container).join(' | ')
      assert.ok(buttons.includes('graph-card-source'), `no source link: ${buttons}`)
      assert.ok(buttons.includes('graph-card-doi'))
    })

    it('offers none of the three for a work with no DOI', () => {
      const bare = [makeNode({ key: 'seed', role: 'seed' }), makeNode({ key: 'nodoi', year: 2011 })]
      const { container } = render(bare)
      fire(container.querySelector('[data-mark][data-key="nodoi"]'), 'click', { clientX: 30, clientY: 30 })
      const buttons = labelsIn(container).join(' | ')
      assert.ok(!buttons.includes('graph-card-graph'), `offered a graph with nothing to look up: ${buttons}`)
      assert.ok(!buttons.includes('graph-card-source'))
    })
  })

  it('says so rather than drawing nothing when no work can be placed', () => {
    const unplaceable = [makeNode({ key: 'a', year: null }), makeNode({ key: 'b', year: null })]
    const { container } = render(unplaceable)
    assert.equal(container.querySelectorAll('[data-mark]').length, 0)
    assert.ok((container.textContent ?? '').length > 0, 'an empty plot with no explanation')
  })
})

describe('a collection network on the tab', () => {
  const seedWork = (id: string, itemID: number, year: number): SeedWork => ({
    itemID,
    openAlexId: id,
    doi: `10.1/${id.toLowerCase()}`,
    title: `Seed ${id}`,
    year,
    citedByCount: 20,
    referenceCount: 30,
    authors: ['Ada Lovelace'],
    referencedWorks: [],
    primaryTopic: null,
  })
  const work = (id: string, extra: Partial<NetworkWork> = {}): NetworkWork => ({
    openAlexId: id,
    doi: `10.2/${id.toLowerCase()}`,
    title: `Work ${id}`,
    year: 2010,
    citedByCount: 100,
    referenceCount: 20,
    authors: ['Turing, Alan'],
    direction: 'reference',
    seeds: ['S1', 'S2'],
    match: null,
    ...extra,
  })

  function network(
    extra: Partial<CollectionNetwork> = {},
    coverage: Partial<CollectionNetwork['coverage']> = {},
  ): CollectionNetwork {
    const works = [
      work('GAP'),
      work('HELD', { year: 2012, match: { itemID: 9, confidence: 'exact', via: 'doi' } }),
      work('MAYBE', { year: 2014, match: { itemID: 10, confidence: 'probable', via: 'title' } }),
      work('CITER', { year: 2023, direction: 'citing', seeds: ['S1', 'S3'] }),
    ]
    const { gaps, probable } = rankGaps(works)
    return {
      version: 1,
      scope: { kind: 'collection', collectionID: 7, libraryID: 1, name: 'Mine' },
      builtAt: 0,
      seeds: [seedWork('S1', 101, 2018), seedWork('S2', 102, 2019), seedWork('S3', 103, 2020)],
      works,
      coupling: [],
      citations: [
        { from: 'S1', to: 'GAP' },
        { from: 'S2', to: 'HELD' },
        { from: 'CITER', to: 'S3' },
      ],
      clusters: [{ id: 0, label: 'Topic A', topicShare: 1, members: ['S1', 'S2'] }],
      clusterOf: { S1: 0, S2: 0, S3: null },
      gaps,
      probable,
      coverage: {
        itemsInScope: 3,
        analysed: 3,
        capped: false,
        resolved: 3,
        unresolved: [],
        citingIncluded: true,
        citingTruncated: false,
        requestsMade: 4,
        ...coverage,
      },
      ...extra,
    }
  }

  const draw = (net = network(), handlers: { onReload?: () => void; onIncludeCiting?: () => void } = {}) => {
    const container = document.createElement('div')
    container.id = `net-${++containers}`
    documentBody.append(container)
    renderNetworkGraph(
      window as any,
      container as any,
      { kind: 'collection', collectionID: 7, name: 'Mine' } as any,
      net,
      handlers,
    )
    return container as any
  }
  const markKeys = (container: any): string[] =>
    [...container.querySelectorAll('[data-mark]')].map((mark: any) => mark.getAttribute('data-key')).sort()

  it('names every cluster in the legend, and the seeds in none', () => {
    const container = draw()
    const zero = container.querySelector('[data-cluster="0"]')
    assert.ok(zero, 'no legend entry for the cluster')
    assert.ok(zero.textContent.includes('Topic A (2)'), zero.textContent)
    assert.ok(container.querySelector('[data-cluster="none"]'), 'no entry for the unclustered seed')
  })

  it('shows only the clicked cluster, adds the next one clicked, and shows all once none is picked', () => {
    const container = draw()
    const all = markKeys(container)
    assert.ok(all.includes('S1') && all.includes('S3'))

    // One cluster picked: that one alone (S1, S2), the unclustered S3 gone.
    fire(container.querySelector('[data-cluster="0"]'), 'click')
    const only = markKeys(container)
    assert.ok(only.includes('S1') && only.includes('S2'), only.join(','))
    assert.ok(!only.includes('S3'), only.join(','))

    // A second one added: both shown.
    fire(container.querySelector('[data-cluster="none"]'), 'click')
    const both = markKeys(container)
    assert.ok(both.includes('S1') && both.includes('S3'), both.join(','))

    // Both taken out again: back to everything.
    fire(container.querySelector('[data-cluster="0"]'), 'click')
    fire(container.querySelector('[data-cluster="none"]'), 'click')
    assert.deepEqual(markKeys(container).sort(), all.sort())
  })

  it('draws no star: every line is a citation between two works on the plot', () => {
    const container = draw()
    const lines = [...container.querySelectorAll('[data-edge]')]
    assert.ok(lines.length > 0, 'no citations drawn')
    for (const line of lines) assert.ok((line as any).hasAttribute('data-link'), 'a star edge was drawn')
    // And no halo: no seed is the one the tab is about.
    assert.equal(container.querySelectorAll('[data-mark][data-key="S1"] circle').length, 2, 'mark and collar only')
  })

  it('leaves the citations faintly in view with nothing pointed at', () => {
    const container = draw()
    const resting = [...container.querySelectorAll('[data-link]')].map((line: any) => line.getAttribute('opacity'))
    assert.ok(resting.length > 0)
    for (const opacity of resting) assert.equal(opacity, '0.12')
  })

  it('draws a probable match with a dashed collar and a gap hollow', () => {
    const container = draw()
    assert.ok(
      container.querySelector('[data-mark][data-key="MAYBE"] circle[stroke-dasharray]'),
      'no dashed collar on the probable match',
    )
    assert.equal(container.querySelector('[data-mark][data-key="HELD"] circle[stroke-dasharray]'), null)
    // The top gap: a heavy tinted ring, numbered as in the list.
    const gap = container.querySelector('circle[data-key="GAP"]')
    assert.equal(gap?.getAttribute('fill-opacity'), '0.14', 'top gap not drawn as a tinted ring')
    assert.equal(container.querySelector('[data-mark][data-key="GAP"] text')?.textContent, '1')
  })

  it('draws a crowded collection translucent, and the mark pointed at solid', () => {
    const seeds = Array.from({ length: 300 }, (_, i) => ({
      ...seedWork(`S${i}`, 1000 + i, 2000 + (i % 25)),
      citedByCount: 100 + ((i * 37) % 900),
      referenceCount: 200,
    }))
    const container = draw(network({ seeds, clusterOf: {}, clusters: [] }))
    const disc = (key: string): any => container.querySelector(`circle[data-key="${key}"]`)
    const resting = disc('S1')?.getAttribute('fill-opacity')
    assert.ok(resting && Number(resting) < 1, `S1 rests at ${resting}`)
    fire(container.querySelector('[data-mark][data-key="S1"]'), 'mouseover')
    assert.equal(disc('S1')?.getAttribute('fill-opacity'), '1')
    assert.equal(disc('S2')?.getAttribute('fill-opacity'), resting, 'a mark not pointed at went solid')
    fire(container.querySelector('[data-mark][data-key="S2"]'), 'mouseover')
    assert.equal(disc('S1')?.getAttribute('fill-opacity'), resting, 'the last mark stayed solid')
    assert.equal(disc('S2')?.getAttribute('fill-opacity'), '1')
    // A gap's tint is its own, not a crowded disc's, and pointing leaves it be.
    fire(container.querySelector('[data-mark][data-key="GAP"]'), 'mouseover')
    assert.equal(disc('GAP')?.getAttribute('fill-opacity'), '0.14')
  })

  it('takes the gaps out with their switch', () => {
    const container = draw()
    fire(container.querySelector('[data-filter="gaps"]'), 'click')
    assert.ok(!markKeys(container).includes('GAP'))
    assert.ok(markKeys(container).includes('HELD'))
  })

  it('puts the gaps list beside the plot', () => {
    const container = draw()
    const aside = container.querySelector('[data-role="gaps"]')
    assert.ok(aside, 'no side panel')
    assert.ok(aside.querySelector('.orbit-gaps'), 'no gaps list in it')
    assert.ok(aside.querySelector('.orbit-gap[data-openalex="GAP"]'))
  })

  it('brings a gap forward when it is chosen in the list', () => {
    const container = draw()
    fire(container.querySelector('.orbit-gap[data-openalex="GAP"] .orbit-gap-title'), 'click')
    const strip = container.querySelector('[data-role="strip"]')
    assert.ok((strip?.textContent ?? '').includes('Work GAP'), strip?.textContent)
  })

  it('ignores a gap from the list that has no mark', () => {
    const container = draw()
    fire(container.querySelector('[data-filter="gaps"]'), 'click')
    const strip = container.querySelector('[data-role="strip"]')
    const before = strip?.textContent
    fire(container.querySelector('.orbit-gap[data-openalex="GAP"] .orbit-gap-title'), 'click')
    assert.equal(strip?.textContent, before)
  })

  it('offers the citing works only with an API key, and says why not', () => {
    setOpenAlexApiKey(null)
    const container = draw(network({}, { citingIncluded: false }))
    const citing = container.querySelector('[data-filter="citing"]')
    assert.ok(citing, 'no citing switch')
    assert.equal(citing.disabled, true)
    assert.ok(container.querySelector('[data-role="citing-note"]'), 'no note saying a key is needed')
  })

  it('builds again with the citing works when a key is set and they are switched on', () => {
    setOpenAlexApiKey('test-key')
    try {
      let asked = 0
      const container = draw(network({}, { citingIncluded: false }), { onIncludeCiting: () => asked++ })
      const citing = container.querySelector('[data-filter="citing"]')
      assert.equal(citing.disabled, false)
      assert.equal(container.querySelector('[data-role="citing-note"]'), null)
      fire(citing, 'click')
      assert.equal(asked, 1)
    } finally {
      setOpenAlexApiKey(null)
    }
  })

  it('takes the citing works out with their switch once they are in', () => {
    const container = draw()
    assert.ok(markKeys(container).includes('CITER'))
    fire(container.querySelector('[data-filter="citing"]'), 'click')
    assert.ok(!markKeys(container).includes('CITER'))
  })

  it('lists the exports behind one button', () => {
    const container = draw()
    const button = container.querySelector('[data-control="export"]')
    assert.ok(button, 'no export button')
    fire(button, 'click')
    const ids = [...container.querySelectorAll('[data-export]')].map((entry: any) => entry.getAttribute('data-export'))
    for (const id of ['vosviewer', 'graphml', 'gaps-csv', 'gaps-ris']) assert.ok(ids.includes(id), ids.join(','))
  })

  it('offers the works citing a mark in OpenAlex on its card', () => {
    const container = draw()
    fire(container.querySelector('[data-mark][data-key="GAP"]'), 'click', { clientX: 30, clientY: 30 })
    const labels = [...container.querySelectorAll('button')].map((b: any) => b.textContent).join(' | ')
    assert.ok(labels.includes('network-card-cited-by'), labels)
  })

  it('says how much of the collection it analysed, and what it could not cover', () => {
    const container = draw(
      network({}, { capped: true, analysed: 3, itemsInScope: 900, unresolved: [{ itemID: 5, reason: 'not-found' }] }),
    )
    assert.ok(container.querySelector('[data-role="capped"]'), 'no banner for a capped analysis')
    assert.ok(container.querySelector('[data-role="coverage"]'), 'no coverage note')
    assert.equal(draw().querySelector('[data-role="capped"]'), null)
    assert.equal(draw().querySelector('[data-role="coverage"]'), null)
  })

  it('draws a library as a graph, not as the empty placeholder', () => {
    const net = network({ scope: { kind: 'library', libraryID: 1, name: 'My Library' } })
    const container = document.createElement('div')
    container.id = `net-${++containers}`
    documentBody.append(container)
    renderNetworkGraph(
      window as any,
      container as any,
      { kind: 'library', libraryID: 1, name: 'My Library' } as any,
      net,
    )
    assert.ok(container.querySelectorAll('[data-mark]').length > 0)
    assert.ok(!(container.textContent ?? '').includes('graph-empty'))
    assert.ok(!(container.textContent ?? '').includes('graph-placeholder-title'))
  })

  it('asks before a large analysis, with three answers', () => {
    const container = document.createElement('div')
    documentBody.append(container)
    const answers: string[] = []
    const estimate = { listRequests: 40, singleRequests: 0, usd: 0.004, dailyBudgetUsd: 0.1, shareOfDailyBudget: 0.04 }
    renderSeedChoice(
      document as any,
      container as any,
      { kind: 'library', libraryID: 1, name: 'Lib' } as any,
      { total: 900, limit: 300, all: estimate, capped: estimate },
      (choice: string) => answers.push(choice),
    )
    const choices = [...container.querySelectorAll('[data-choice]')].map((b: any) => b.getAttribute('data-choice'))
    assert.deepEqual(choices, ['all', 'cap', 'cancel'])
    fire(container.querySelector('[data-choice="cap"]'), 'click')
    assert.deepEqual(answers, ['cap'])
    assert.ok((container.textContent ?? '').includes('network-confirm-estimate-all'))
  })

  it('moves the bar through the analysis, within a step as well as between them', () => {
    const container = document.createElement('div')
    documentBody.append(container)
    const width = (step: any, done: number, total: number) => {
      renderNetworkProgress(document as any, container as any, { kind: 'library', name: 'x' } as any, {
        step,
        done,
        total,
      })
      return (container.querySelector('[data-progress] > div') as any)?.style.width
    }
    assert.equal(width('seeds', 0, 0), '0%')
    assert.equal(width('lookup', 1, 2), '25%')
    assert.equal(width('clusters', 1, 1), '100%')
  })

  it('shows what is left of the OpenAlex budget while it runs', async () => {
    const { parseOpenAlexBudget, recordOpenAlexBudget } = await import('../src/modules/openAlexBudget.core.ts')
    const container = document.createElement('div')
    documentBody.append(container)
    const draw = () =>
      renderNetworkProgress(document as any, container as any, { kind: 'library', name: 'x' } as any, {
        step: 'references',
        done: 3,
        total: 10,
      })
    recordOpenAlexBudget(
      parseOpenAlexBudget(
        (name) => ({ 'x-ratelimit-limit-usd': '1', 'x-ratelimit-remaining-usd': '0.91' })[name] ?? null,
        Date.now(),
      ),
    )
    draw()
    assert.ok(container.querySelector('[data-role="budget"]'), 'no budget line under the bar')
  })

  it('moves within a group of citing works, page by page, and says how far it got', () => {
    const container = document.createElement('div')
    documentBody.append(container)
    const render = (pages?: number, found?: number) => {
      renderNetworkProgress(document as any, container as any, { kind: 'library', name: 'x' } as any, {
        step: 'citing',
        done: 0,
        total: 3,
        ...(pages === undefined ? {} : { pages, found }),
      })
      return {
        width: Number.parseFloat((container.querySelector('[data-progress] > div') as any)?.style.width),
        text: container.textContent ?? '',
      }
    }
    const before = render()
    const later = render(6, 540)
    assert.ok(later.width > before.width, `${later.width} is not past ${before.width}`)
    assert.ok(later.text.includes('network-step-pages'), 'the page caption is not shown')
    // Never onto the next group however many pages come in.
    assert.ok(render(500, 50_000).width < render(undefined).width + (100 / 6 / 3) * 1.0001)
  })
})
