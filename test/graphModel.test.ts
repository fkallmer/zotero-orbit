import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AXIS_GUTTER, buildGraphLayout, citationScale, renderGraphSvg } from '../src/modules/graphModel.core.ts'

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

  it('names title, year and citations on hover', () => {
    const svg = renderGraphSvg(layout, theme)
    assert.ok(svg.includes('<title>held · 2010 · 80 citations</title>'))
  })

  it('escapes a title that would otherwise break the markup', () => {
    const nasty = buildGraphLayout([node({ key: 'x', title: 'A <b> & "quote"' })], options)!
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
    assert.ok(svg.includes('marker-end="url(#arrow-ref)"'))
    assert.ok(svg.includes('marker-end="url(#arrow-cite)"'))
  })

  it('says how many works a mark cites, since that is what its size means', () => {
    const sized = buildGraphLayout([node({ key: 'r', title: 'R', referenceCount: 42 })], options)!
    assert.ok(renderGraphSvg(sized, theme).includes('cites 42 works'))
  })

  it('omits the reference count rather than printing undefined for it', () => {
    const svg = renderGraphSvg(layout, theme)
    assert.ok(!svg.includes('undefined'))
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
    assert.ok(svg.includes('clip-path="url(#plot-area)"'))
    assert.ok(svg.includes('<clipPath id="plot-area">'))
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

  it('reads as author, year and title', () => {
    const layout = buildGraphLayout(
      [node({ key: 's', role: 'seed', author: 'Soleimani', year: 2019, title: 'Magnetic induction' })],
      options,
    )!
    assert.equal(layout.nodes[0].label, 'Soleimani 2019 · Magnetic induction')
  })

  it('still labels a work whose author is unknown', () => {
    const layout = buildGraphLayout([node({ key: 's', author: null, year: 2019, title: 'Untitled work' })], options)!
    assert.equal(layout.nodes[0].label, '2019 · Untitled work')
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
    assert.equal(layout.nodes.find((placed) => placed.role === 'seed')?.label, 'Li 2020 · Seed')
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
