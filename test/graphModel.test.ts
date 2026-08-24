import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AXIS_GUTTER,
  buildGraphLayout,
  citationScale,
  edgeEnds,
  FITTED,
  placeLabels,
  renderGraphSvg,
} from '../src/modules/graphModel.core.ts'
import { xmlErrors } from './svgWellFormed.ts'

import type { GraphNode } from '../src/modules/graphModel.core.ts'

const theme = {
  seed: '#e34948',
  reference: '#2a78d6',
  citing: '#1baf7a',
  muted: '#5c5c5c',
  surface: '#ffffff',
}
const options = { width: 400, height: 200, padding: { top: 10, right: 10, bottom: 20, left: 30 } }

function node(partial: Partial<GraphNode> & { key: string }): GraphNode {
  return {
    title: partial.key,
    year: 2020,
    citedByCount: 10,
    role: 'reference',
    doi: null,
    author: null,
    referenceCount: null,
    itemID: null,
    ...partial,
  }
}

describe('citationScale', () => {
  it('places uncited work at zero rather than at minus infinity', () => {
    // log(0) would be -Infinity and take the whole axis with it.
    assert.equal(citationScale(0), 0)
  })

  it('compresses orders of magnitude', () => {
    // A seed with 6 next to a reference with 84,000 is the real case.
    const ratio = citationScale(84000) / citationScale(6)
    assert.ok(ratio > 3 && ratio < 6, `expected a single-digit ratio, got ${ratio}`)
  })

  it('treats a negative count as zero rather than producing NaN', () => {
    assert.equal(citationScale(-5), 0)
  })
})

describe('buildGraphLayout', () => {
  it('runs time left to right', () => {
    const layout = buildGraphLayout([node({ key: 'old', year: 2000 }), node({ key: 'new', year: 2020 })], options)
    const old = layout?.nodes.find((n) => n.key === 'old')
    const recent = layout?.nodes.find((n) => n.key === 'new')
    assert.ok(old && recent && old.x < recent.x)
  })

  it('puts more-cited work higher', () => {
    const layout = buildGraphLayout(
      [node({ key: 'few', citedByCount: 1 }), node({ key: 'many', citedByCount: 5000 })],
      options,
    )
    const few = layout?.nodes.find((n) => n.key === 'few')
    const many = layout?.nodes.find((n) => n.key === 'many')
    // Smaller y is further up the page.
    assert.ok(few && many && many.y < few.y)
  })

  it('reports works it cannot place instead of dropping them silently', () => {
    const layout = buildGraphLayout([node({ key: 'dated' }), node({ key: 'undated', year: null })], options)
    assert.equal(layout?.nodes.length, 1)
    assert.equal(layout?.dropped, 1)
  })

  it('returns null when nothing can be placed at all', () => {
    assert.equal(buildGraphLayout([node({ key: 'a', year: null })], options), null)
  })

  it('survives a single node, where the year span would be zero', () => {
    const layout = buildGraphLayout([node({ key: 'only' })], options)
    assert.equal(layout?.nodes.length, 1)
    assert.ok(Number.isFinite(layout?.nodes[0].x))
    assert.ok(Number.isFinite(layout?.nodes[0].y))
  })

  it('gives the seed a floor size, so a lightly cited one is still findable', () => {
    const layout = buildGraphLayout(
      [node({ key: 'seed', role: 'seed', citedByCount: 2 }), node({ key: 'ref', citedByCount: 2 })],
      options,
    )
    const seed = layout?.nodes.find((n) => n.key === 'seed')
    const ref = layout?.nodes.find((n) => n.key === 'ref')
    assert.ok(seed && ref && seed.radius > ref.radius)
  })

  it('paints the seed last so its neighbours cannot cover it', () => {
    const layout = buildGraphLayout(
      [node({ key: 'a' }), node({ key: 'seed', role: 'seed' }), node({ key: 'b' })],
      options,
    )
    assert.equal(layout?.nodes.at(-1)?.role, 'seed')
  })

  it('labels the citation axis in powers of ten', () => {
    const layout = buildGraphLayout([node({ key: 'a', citedByCount: 2500 })], options)
    assert.deepEqual(
      layout?.yTicks.map((tick) => tick.label),
      ['0', '1', '10', '100', '1k'],
    )
  })
})

describe('renderGraphSvg', () => {
  const layout = buildGraphLayout(
    [
      node({ key: 'seed', role: 'seed', year: 2019, citedByCount: 6, doi: '10.1/seed' }),
      node({ key: 'held', year: 2010, citedByCount: 80, doi: '10.1/held' }),
      node({ key: 'cite', role: 'citing', year: 2022, citedByCount: 3 }),
    ],
    options,
  )!

  it('carries the DOI a click needs', () => {
    const svg = renderGraphSvg(layout, theme)
    assert.ok(svg.includes('data-doi="10.1/seed"'))
  })

  it('haloes the seed and nothing else', () => {
    const svg = renderGraphSvg(layout, theme)
    // Three marks plus one halo.
    assert.equal(svg.match(/<circle /g)?.length, 4)
  })

  it('emits no native tooltip, since the label already carries the title', () => {
    // Two answers to one question is one too many: the browser's tooltip put
    // the title in a box at the pointer while the label carried it at the mark.
    const svg = renderGraphSvg(layout, theme)
    assert.ok(!svg.includes('<title>'))
  })

  it('escapes a title that would otherwise break the markup', () => {
    // A work with neither author nor year falls back to its title as the
    // label, which is where an unescaped angle bracket would land.
    const nasty = buildGraphLayout(
      [node({ key: 'x', author: null, year: null, referenceCount: 5, title: 'A <b> & "quote"' })],
      {
        ...options,
        xMetric: 'citations',
        yMetric: 'references',
      },
    )!
    const svg = renderGraphSvg(nasty, theme)
    assert.ok(svg.includes('&lt;b&gt;'))
    assert.ok(!svg.includes('<b>'))
  })

  it('carries a text alternative', () => {
    assert.ok(renderGraphSvg(layout, theme).includes('role="img"'))
  })

  it('draws arrowheads from the citing work to the cited one', () => {
    const svg = renderGraphSvg(layout, theme)
    // The seed cites its references, so those edges leave the seed; the citing
    // works cite the seed, so theirs arrive at it. Without the heads the plot
    // shows two clusters and leaves the direction to be guessed.
    assert.ok(svg.includes('marker-end="url(#orbit-graph-arrow-ref)"'))
    assert.ok(svg.includes('marker-end="url(#orbit-graph-arrow-cite)"'))
  })

  it('never prints undefined for a field a caller left out', () => {
    const svg = renderGraphSvg(layout, theme)
    assert.ok(!svg.includes('undefined'))
  })
})

describe('the markup the tab actually parses', () => {
  // DOMParser as image/svg+xml is XML, and XML mandates a value for every
  // attribute. `data-mark` written bare is ordinary HTML and fatal here: the
  // parse aborts and the tab renders nothing. Every other test still passed.
  const shapes: [string, GraphNode[], Partial<typeof options>][] = [
    ['the ordinary case', [node({ key: 'a' }), node({ key: 'b', role: 'seed', year: 2015 })], {}],
    ['a work already in the library', [node({ key: 'a', itemID: 7, role: 'seed' })], {}],
    [
      'references across the bottom',
      [node({ key: 'a', referenceCount: 40 }), node({ key: 'b', referenceCount: 2 })],
      { xMetric: 'references' as const },
    ],
    ['a title carrying markup', [node({ key: 'a', title: 'A <b> & "quoted" title' })], {}],
    ['an author carrying an apostrophe', [node({ key: 'a', author: "O'Brien" })], {}],
  ]

  for (const [what, nodes, extra] of shapes) {
    it(`is well-formed XML for ${what}`, () => {
      const layout = buildGraphLayout(nodes, { ...options, ...extra })!
      const svg = renderGraphSvg(layout, theme, { x: 'Year', y: 'Citations', inLibrary: 'in your library' })
      assert.deepEqual(xmlErrors(svg), [])
    })
  }

  it('catches a valueless attribute, which is the failure that got through', () => {
    // The guard has to fail on the real thing, or it guards nothing.
    assert.equal(xmlErrors('<svg><g data-mark></g></svg>').length, 1)
    assert.deepEqual(xmlErrors('<svg><g data-mark="1"></g></svg>'), [])
  })

  it('catches an unclosed tag too', () => {
    assert.equal(xmlErrors('<svg><g></svg>').length, 2)
  })
})

describe('zoom spreads the marks without inflating them', () => {
  // Eight works of the same year and much the same citation count, on a plot
  // whose axes are stretched by one old and heavily cited paper. They land on
  // top of each other: the case the graph is worst at, and the reason to zoom.
  const cluster = Array.from({ length: 8 }, (_, index) =>
    node({ key: `c${index}`, role: 'citing', author: `Author${index}`, year: 2021, citedByCount: 10 + index }),
  )
  const options = { width: 600, height: 300, padding: { top: 10, right: 10, bottom: 20, left: 30 } }
  const layout = buildGraphLayout(
    [node({ key: 'seed', role: 'seed', year: 2019 }), node({ key: 'old', year: 1960, citedByCount: 5000 }), ...cluster],
    options,
  )!

  it('carries the position on the group and the geometry at the origin', () => {
    const svg = renderGraphSvg(layout, theme)
    // A circle with cx/cy inside a scaled layer grows with the zoom. One at the
    // origin under a translated group does not, which is the whole change.
    assert.ok(svg.includes('<g data-mark="1" data-key='))
    assert.ok(!/<circle [^>]*cx=/.test(svg))
  })

  it('keeps one text element per mark, showing or not', () => {
    const svg = renderGraphSvg(layout, theme)
    // A pool, so a zoom swaps attributes rather than rebuilding the group.
    assert.equal(svg.match(/<text data-label="/g)?.length, layout.nodes.length)
  })

  it('names more of a crowded cluster once there is room for the names', () => {
    const fitted = placeLabels(layout.nodes, FITTED(options.width, options.height))
    const crowd = layout.nodes.filter((placed) => placed.role === 'citing')
    const middleX = crowd.reduce((sum, placed) => sum + placed.x, 0) / crowd.length
    const middleY = crowd.reduce((sum, placed) => sum + placed.y, 0) / crowd.length
    const k = 4
    const zoomed = placeLabels(layout.nodes, {
      kx: k,
      ky: k,
      tx: options.width / 2 - middleX * k,
      ty: options.height / 2 - middleY * k,
      width: options.width,
      height: options.height,
    })
    const named = (placements: { key: string }[]): number =>
      crowd.filter((placed) => placements.some((placement) => placement.key === placed.key)).length
    assert.ok(named(zoomed) > named(fitted), `${named(fitted)} at rest, ${named(zoomed)} zoomed in`)
  })

  it('gives no label to a mark that has left the viewport', () => {
    const offscreen = placeLabels(layout.nodes, {
      kx: 1,
      ky: 1,
      tx: 5000,
      ty: 0,
      width: options.width,
      height: options.height,
    })
    assert.equal(offscreen.length, 0)
  })
})

describe('zooming one axis alone', () => {
  const options = { width: 600, height: 300, padding: { top: 10, right: 10, bottom: 20, left: 30 } }
  const layout = buildGraphLayout(
    [
      node({ key: 'a', role: 'seed', year: 2000, citedByCount: 10 }),
      node({ key: 'b', year: 2004, citedByCount: 1000 }),
    ],
    options,
  )!
  const view = (kx: number, ky: number) => ({ kx, ky, tx: 0, ty: 0, width: 1e6, height: 1e6 })
  const gap = (kx: number, ky: number, axis: 'x' | 'y'): number => {
    const placements = placeLabels(layout.nodes, view(kx, ky))
    const at = (key: string) => placements.find((placement) => placement.key === key)!
    return Math.abs(at('a')[axis] - at('b')[axis])
  }

  it('pulls the marks apart along the axis it is given', () => {
    // Marks keep their size at any zoom, so this is not a distortion -- it
    // separates works of the same few years without touching anything about
    // their citation counts, which one shared factor cannot do.
    assert.ok(gap(3, 1, 'x') > gap(1, 1, 'x') * 2.5)
    assert.ok(gap(1, 3, 'y') > gap(1, 1, 'y') * 2.5)
  })

  it('leaves the other axis exactly where it was', () => {
    // Asserted on the geometry rather than on the labels: a label moves to
    // another side of its mark once the crowding changes, which is the point
    // of laying them out again and says nothing about the axis.
    const from = { x: 100, y: 100, radius: 10 }
    const to = { x: 200, y: 200, radius: 10 }
    const rest = edgeEnds(from, to, { kx: 1, ky: 1, tx: 0, ty: 0, width: 600, height: 300 })
    const wide = edgeEnds(from, to, { kx: 3, ky: 1, tx: 0, ty: 0, width: 600, height: 300 })
    const tall = edgeEnds(from, to, { kx: 1, ky: 3, tx: 0, ty: 0, width: 600, height: 300 })
    assert.ok(wide.x2 > rest.x2 * 2)
    assert.ok(tall.y2 > rest.y2 * 2)
    // The mark itself has not moved on the untouched axis: y stays near 100,
    // off it only by the gap that holds the line clear of the mark.
    assert.ok(Math.abs(wide.y1 - 100) < 12, `y drifted to ${wide.y1}`)
    assert.ok(Math.abs(tall.x1 - 100) < 12, `x drifted to ${tall.x1}`)
  })
})

describe('edgeEnds', () => {
  const from = { x: 100, y: 100, radius: 10 }
  const to = { x: 300, y: 100, radius: 10 }

  it('holds the arrowhead the same distance off its target at any zoom', () => {
    // The marks no longer scale, so the gap is a screen distance. Scaling it
    // with the data would bury the head under the mark when zoomed in.
    const near = edgeEnds(from, to, { kx: 1, ky: 1, tx: 0, ty: 0, width: 600, height: 300 })
    const far = edgeEnds(from, to, { kx: 4, ky: 4, tx: 0, ty: 0, width: 600, height: 300 })
    assert.equal(Math.round(300 - near.x2), 17)
    assert.equal(Math.round(300 * 4 - far.x2), 17)
  })

  it('hides an edge whose ends have come closer than the two gaps', () => {
    // A head pointing backwards through its own mark states the opposite of
    // the truth, so nothing is drawn at all.
    const squeezed = edgeEnds(from, { ...to, x: 110 }, { kx: 1, ky: 1, tx: 0, ty: 0, width: 600, height: 300 })
    assert.equal(squeezed.hidden, true)
  })

  it('survives two marks at exactly the same point', () => {
    const same = edgeEnds(from, { ...from }, { kx: 1, ky: 1, tx: 0, ty: 0, width: 600, height: 300 })
    assert.equal(same.hidden, true)
    assert.ok(!Number.isNaN(same.x1))
  })
})

describe('work the reader already has', () => {
  const mixed = [
    node({ key: 'filed', title: 'Filed', itemID: 42, citedByCount: 20 }),
    node({ key: 'not', title: 'Not filed', citedByCount: 5, year: 2015 }),
  ]

  it('rings a filed work in plain ink, not in a fourth colour', () => {
    // Three hues already mean role, and "I have this" is a fact about the
    // reader rather than about the citation -- it has to read in greyscale.
    const svg = renderGraphSvg(buildGraphLayout(mixed, options)!, theme)
    assert.equal(svg.match(new RegExp(`stroke="${theme.muted}" stroke-width="1.6"`, 'g'))?.length, 1)
  })

  it('keeps the surface ring underneath, so overlapping marks stay countable', () => {
    const svg = renderGraphSvg(buildGraphLayout(mixed, options)!, theme)
    assert.equal(svg.match(/stroke="#ffffff" stroke-width="2"/g)?.length, 2)
  })

  it('carries the item id, so the mark can lead back to the item', () => {
    const svg = renderGraphSvg(buildGraphLayout(mixed, options)!, theme)
    assert.ok(svg.includes('data-item="42"'))
    assert.ok(svg.includes('data-item=""'))
  })

  it('leaves saying so to the caller, which is the one that can translate it', () => {
    // The fact reaches the reader through the detail line under the pointed-at
    // mark, and that line is built where the localised strings are.
    const layout = buildGraphLayout(mixed, options)!
    const describe = (node: { itemID: number | null }) => (node.itemID === null ? ['plain'] : ['in your library'])
    const filed = placeLabels(layout.nodes, FITTED(options.width, options.height), 'filed', describe)
    assert.ok(filed.find((placement) => placement.key === 'filed')?.lines.includes('in your library'))
  })
})

describe('paths between the surrounding works', () => {
  const three = [
    node({ key: 'seed', role: 'seed', year: 2019, citedByCount: 6 }),
    node({ key: 'a', year: 2005, citedByCount: 900 }),
    node({ key: 'b', year: 2010, citedByCount: 40 }),
  ]
  const links = [{ from: 'b', to: 'a' }]

  it('draws them, but paints them at zero', () => {
    // All of them at once is a thicket rather than a finding; the tab lights
    // one when its end is pointed at.
    const svg = renderGraphSvg(buildGraphLayout(three, { ...options, links })!, theme)
    assert.equal(svg.match(/data-link="1"/g)?.length, 1)
    assert.ok(/data-link="1"[^>]*opacity="0"/.test(svg))
  })

  it('names both ends, so either can light it', () => {
    const svg = renderGraphSvg(buildGraphLayout(three, { ...options, links })!, theme)
    assert.ok(/data-link="1" data-key="b" data-key2="a"/.test(svg))
  })

  it('uses plain ink rather than a fourth hue', () => {
    // The three hues mean a work's relation to the seed, and a path between
    // two of the surrounding works is about neither of them.
    const svg = renderGraphSvg(buildGraphLayout(three, { ...options, links })!, theme)
    assert.ok(svg.includes(`<marker id="orbit-graph-arrow-link"`))
    assert.ok(/data-link="1"[^>]*stroke="#5c5c5c"/.test(svg))
  })

  it('drops a path to a work that could not be placed', () => {
    // A line to nowhere is worse than no line.
    const withGhost = buildGraphLayout(three, { ...options, links: [{ from: 'a', to: 'missing' }] })!
    assert.deepEqual(withGhost.links, [])
  })

  it('keeps a path whose ends both survived', () => {
    assert.deepEqual(buildGraphLayout(three, { ...options, links })!.links, links)
  })
})

describe('a fixed frame around a moving plot', () => {
  const layout = buildGraphLayout(
    [
      node({ key: 'seed', role: 'seed', year: 2019, citedByCount: 6 }),
      node({ key: 'old', year: 1998, citedByCount: 900 }),
    ],
    options,
  )!

  it('separates the plot from the frame so only one of them can be moved', () => {
    const svg = renderGraphSvg(layout, theme)
    // Zoom transforms this group. Without the split it moved the axis too, and
    // zooming in far enough left the scale off-screen entirely.
    assert.ok(svg.includes('<g data-role="content"'))
    assert.ok(svg.includes('<g data-role="axis">'))
  })

  it('clips the plot out of the gutters the tick numbers live in', () => {
    const svg = renderGraphSvg(layout, theme)
    assert.ok(svg.includes('clip-path="url(#orbit-graph-plot-area)"'))
    assert.ok(svg.includes('<clipPath id="orbit-graph-plot-area">'))
  })

  it('namespaces its defs, so two open graphs cannot clip each other', () => {
    // Both would otherwise define `plot-area`, and `url(#plot-area)` resolves
    // to whichever came first in the document. The second tab's plot is then
    // clipped by the first tab's rectangle -- which is in a hidden deck panel
    // and has collapsed to nothing, so the second graph draws an empty box
    // until the first tab is closed.
    const first = renderGraphSvg(layout, theme, undefined, 'tab-a')
    const second = renderGraphSvg(layout, theme, undefined, 'tab-b')
    for (const name of ['plot-area', 'arrow-ref', 'arrow-cite']) {
      assert.ok(first.includes(`id="tab-a-${name}"`), `first is missing ${name}`)
      assert.ok(second.includes(`id="tab-b-${name}"`), `second is missing ${name}`)
      assert.ok(!second.includes(`url(#tab-a-${name})`), `second reaches into the first for ${name}`)
    }
  })

  it('tags every tick with where it started, so it can slide back onto its value', () => {
    const svg = renderGraphSvg(layout, theme)
    for (const tick of [...layout.yTicks, ...layout.xTicks]) {
      assert.ok(svg.includes(`data-pos="${tick.position.toFixed(1)}"`), `no data-pos for ${tick.label}`)
    }
    assert.equal(svg.match(/data-axis="y"/g)?.length, layout.yTicks.length)
    assert.equal(svg.match(/data-axis="x"/g)?.length, layout.xTicks.length)
  })

  it('keeps labels out of the gutters, where they would be cut in half', () => {
    const crowded = Array.from({ length: 14 }, (_, index) =>
      node({ key: `n${index}`, author: 'Author', year: 1990 + index, citedByCount: index }),
    )
    const placed = buildGraphLayout(crowded, options)!
    for (const mark of placed.nodes) {
      if (mark.label === null) continue
      const width = mark.label.length * 5.4
      const left =
        mark.labelAnchor === 'start'
          ? mark.labelX!
          : mark.labelAnchor === 'end'
            ? mark.labelX! - width
            : mark.labelX! - width / 2
      assert.ok(left >= AXIS_GUTTER.left, `${mark.key} label starts at ${left}`)
      assert.ok(mark.labelY! <= options.height - AXIS_GUTTER.bottom, `${mark.key} label sits in the bottom gutter`)
    }
  })
})

describe('axis choice', () => {
  const mixed: GraphNode[] = [
    node({ key: 'a', year: 2000, citedByCount: 5, referenceCount: 80 }),
    node({ key: 'b', year: 2020, citedByCount: 500, referenceCount: 8 }),
  ]

  it('puts year across and citations up unless told otherwise', () => {
    const layout = buildGraphLayout(mixed, options)!
    assert.equal(layout.xMetric, 'year')
    assert.equal(layout.yMetric, 'citations')
  })

  it('plots references against citations when asked', () => {
    const layout = buildGraphLayout(mixed, { ...options, xMetric: 'references', yMetric: 'citations' })!
    const wide = layout.nodes.find((placed) => placed.key === 'a')!
    const narrow = layout.nodes.find((placed) => placed.key === 'b')!
    // 80 references against 8: the wide bibliography belongs to the right.
    assert.ok(wide.x > narrow.x)
    // And it is the less cited of the two, so it sits lower.
    assert.ok(wide.y > narrow.y)
  })

  it('starts a count axis at zero but a year axis at the earliest year', () => {
    // Zero on a year axis would push every paper into the right-hand pixel.
    const years = buildGraphLayout(mixed, options)!
    assert.equal(Math.round(years.nodes.find((placed) => placed.key === 'a')!.x), options.padding.left)
    const counts = buildGraphLayout(mixed, { ...options, xMetric: 'citations' })!
    assert.ok(counts.nodes.find((placed) => placed.key === 'a')!.x > options.padding.left)
  })

  it('labels a year axis in years and a count axis in counts', () => {
    const years = buildGraphLayout(mixed, options)!
    assert.ok(years.xTicks.every((tick) => tick.label.length === 4))
    const counts = buildGraphLayout(mixed, { ...options, xMetric: 'references' })!
    assert.ok(counts.xTicks.some((tick) => tick.label === '0'))
  })

  it('drops a work missing the value the chosen axis asks for', () => {
    // Swapping to references excludes everything whose bibliography is unknown,
    // which is a different set from the one a year axis excludes.
    const partial = [...mixed, node({ key: 'c', referenceCount: null })]
    assert.equal(buildGraphLayout(partial, options)!.dropped, 0)
    assert.equal(buildGraphLayout(partial, { ...options, yMetric: 'references' })!.dropped, 1)
  })

  it('returns null rather than an empty plot when nothing can be placed', () => {
    assert.equal(
      buildGraphLayout([node({ key: 'x', referenceCount: null })], { ...options, xMetric: 'references' }),
      null,
    )
  })

  it('keeps the log scale off the year axis, where it would be meaningless', () => {
    // log(2000) and log(2020) differ by a hair; the axis would collapse.
    const linear = buildGraphLayout(mixed, { ...options, scale: 'linear' })!
    const log = buildGraphLayout(mixed, { ...options, scale: 'log' })!
    assert.deepEqual(
      linear.nodes.map((placed) => Math.round(placed.x)),
      log.nodes.map((placed) => Math.round(placed.x)),
    )
  })
})

describe('mark size', () => {
  it('grows with the bibliography, not with the citation count', () => {
    // Size and the vertical axis must not encode the same variable; breadth is
    // what the axis leaves unsaid.
    const layout = buildGraphLayout(
      [
        node({ key: 'broad', citedByCount: 1, referenceCount: 200 }),
        node({ key: 'narrow', citedByCount: 5000, referenceCount: 4, year: 2015 }),
      ],
      options,
    )!
    const broad = layout.nodes.find((placed) => placed.key === 'broad')!
    const narrow = layout.nodes.find((placed) => placed.key === 'narrow')!
    assert.ok(broad.radius > narrow.radius)
  })

  it('gives a work with no known bibliography the base size rather than none', () => {
    const layout = buildGraphLayout([node({ key: 'unknown', referenceCount: null })], options)!
    assert.ok(layout.nodes[0].radius >= 6)
  })

  it('keeps the seed findable even when it cites almost nothing', () => {
    const layout = buildGraphLayout(
      [node({ key: 'seed', role: 'seed', referenceCount: 1 }), node({ key: 'ref', referenceCount: 30, year: 2015 })],
      options,
    )!
    const seed = layout.nodes.find((placed) => placed.role === 'seed')!
    assert.ok(seed.radius >= 16)
  })
})

describe('labels', () => {
  const options = { width: 600, height: 300, padding: { top: 10, right: 10, bottom: 20, left: 30 } }

  it('reads as author and year, and stops there', () => {
    // Author and year identifies a paper to someone who knows the field, and
    // is a quarter the width of a truncated title -- so far more marks carry
    // a name at all, which is the whole job of a label.
    const layout = buildGraphLayout(
      [node({ key: 's', role: 'seed', author: 'Soleimani', year: 2019, title: 'Magnetic induction' })],
      options,
    )!
    assert.equal(layout.nodes[0].label, 'Soleimani 2019')
  })

  it('adds the title for the one mark being pointed at', () => {
    const layout = buildGraphLayout(
      [node({ key: 's', role: 'seed', author: 'Soleimani', year: 2019, title: 'Magnetic induction' })],
      options,
    )!
    const [pointed] = placeLabels(layout.nodes, FITTED(options.width, options.height), 's')
    // Title first, wrapped rather than cut, then whatever the caller adds.
    assert.deepEqual(pointed.lines, ['Magnetic induction', 'Soleimani 2019'])
  })

  it('drops back to the plain name when the title will not fit anywhere', () => {
    // Better the name of the mark being pointed at than nothing at all.
    const wall = Array.from({ length: 14 }, (_, index) =>
      node({ key: `w${index}`, author: 'Wall', year: 2000 + (index % 2), citedByCount: 50 + index }),
    )
    const target = node({ key: 't', author: 'Target', year: 2000, citedByCount: 60, title: 'x'.repeat(200) })
    const layout = buildGraphLayout([...wall, target], { ...options, width: 260, height: 160 })!
    const pointed = placeLabels(layout.nodes, FITTED(260, 160), 't').find((placement) => placement.key === 't')
    if (pointed) assert.ok(!pointed.lines.join(' ').includes('xxx'), `kept the title: ${pointed.lines.join(' / ')}`)
  })

  it('gives the pointed-at mark first refusal on a spot', () => {
    // Ten works stacked on the same point: only one label can fit, and at rest
    // the most-cited takes it. Pointing at another must hand it over, because
    // that label is the longest and the one certainly wanted.
    const stack = Array.from({ length: 10 }, (_, index) =>
      node({ key: `n${index}`, author: `Author${index}`, year: 2000, citedByCount: 100 }),
    )
    const layout = buildGraphLayout(stack, options)!
    const view = FITTED(options.width, options.height)
    const atRest = placeLabels(layout.nodes, view).map((placement) => placement.key)
    assert.ok(!atRest.includes('n7'), 'the fixture is not crowded enough to prove anything')
    assert.equal(placeLabels(layout.nodes, view, 'n7')[0]?.key, 'n7')
  })

  it('keeps the year as an identity when the author is unknown', () => {
    const layout = buildGraphLayout([node({ key: 's', author: null, year: 2019, title: 'Untitled work' })], options)!
    assert.equal(layout.nodes[0].label, '2019')
  })

  it('falls back to the title when there is neither author nor year', () => {
    // A nameless dot is worse than a truncated one.
    const layout = buildGraphLayout(
      [node({ key: 's', author: null, year: null, title: 'A work with no byline', referenceCount: 20 })],
      {
        ...options,
        xMetric: 'citations',
        yMetric: 'references',
      },
    )!
    assert.equal(layout.nodes[0].label, 'A work with no byline')
  })

  it('never lets a label sit on top of a mark', () => {
    // Ten works in one year pile up on a single vertical line.
    const crowded = Array.from({ length: 10 }, (_, index) =>
      node({ key: `n${index}`, author: 'Author', title: 'A paper about something', citedByCount: 10 + index }),
    )
    const layout = buildGraphLayout(crowded, options)!
    for (const placed of layout.nodes) {
      if (placed.label === null) continue
      const half = (placed.label.length * 5.4) / 2
      const x1 =
        placed.labelAnchor === 'start'
          ? placed.labelX!
          : placed.labelAnchor === 'end'
            ? placed.labelX! - half * 2
            : placed.labelX! - half
      const x2 = x1 + placed.label.length * 5.4
      for (const other of layout.nodes) {
        const clearsHorizontally = x2 < other.x - other.radius || x1 > other.x + other.radius
        const clearsVertically = Math.abs((placed.labelY ?? 0) - other.y) > other.radius + 12
        assert.ok(clearsHorizontally || clearsVertically, `${placed.key} label overlaps ${other.key}`)
      }
    }
  })

  it('labels the seed even where its own citing works crowd around it', () => {
    const crowd = Array.from({ length: 12 }, (_, index) =>
      node({ key: `c${index}`, role: 'citing', citedByCount: 9 + index, referenceCount: 40 }),
    )
    const layout = buildGraphLayout(
      [node({ key: 'seed', role: 'seed', author: 'Li', title: 'Seed' }), ...crowd],
      options,
    )!
    assert.equal(layout.nodes.find((placed) => placed.role === 'seed')?.label, 'Li 2020')
  })
})

describe('scale choice', () => {
  const spread: GraphNode[] = [
    node({ key: 'low', citedByCount: 5 }),
    node({ key: 'mid', citedByCount: 500, year: 2015 }),
    node({ key: 'high', citedByCount: 5000, year: 2010 }),
  ]

  it('linear pins the small values near the baseline', () => {
    const layout = buildGraphLayout(spread, { ...options, scale: 'linear' })!
    const low = layout.nodes.find((n) => n.key === 'low')!
    const high = layout.nodes.find((n) => n.key === 'high')!
    const base = options.height - options.padding.bottom
    // 5 against 5000 is a thousandth of the range: visually on the floor.
    assert.ok(base - low.y < (base - high.y) * 0.05)
  })

  it('logarithmic lifts them into view', () => {
    const layout = buildGraphLayout(spread, { ...options, scale: 'log' })!
    const low = layout.nodes.find((n) => n.key === 'low')!
    const high = layout.nodes.find((n) => n.key === 'high')!
    const base = options.height - options.padding.bottom
    assert.ok(base - low.y > (base - high.y) * 0.15)
  })

  it('labels a linear axis in round steps rather than powers of ten', () => {
    const layout = buildGraphLayout([node({ key: 'a', citedByCount: 100 })], {
      ...options,
      scale: 'linear',
    })!
    const values = layout.yTicks.map((tick) => tick.value)
    assert.equal(values[0], 0)
    // Evenly spaced, unlike the log axis.
    const gaps = new Set(values.slice(1).map((value, i) => value - values[i]))
    assert.equal(gaps.size, 1)
  })

  it('sizes marks logarithmically whatever the axis does', () => {
    // A linear radius would give a 5,000-citation mark a thousand times the
    // area of a 5-citation one.
    const linear = buildGraphLayout(spread, { ...options, scale: 'linear' })!
    const log = buildGraphLayout(spread, { ...options, scale: 'log' })!
    const radii = (l: typeof linear) => l.nodes.map((n) => n.radius.toFixed(3)).sort()
    assert.deepEqual(radii(linear), radii(log))
  })

  it('defaults to logarithmic', () => {
    const explicit = buildGraphLayout(spread, { ...options, scale: 'log' })!
    const implied = buildGraphLayout(spread, options)!
    assert.deepEqual(
      implied.nodes.map((n) => n.y.toFixed(3)),
      explicit.nodes.map((n) => n.y.toFixed(3)),
    )
  })
})
