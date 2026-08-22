import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildGraphLayout, citationScale, renderGraphSvg } from '../src/modules/graphModel.core.ts'

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
    assert.equal(layout?.droppedNoYear, 1)
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
      node({ key: 'held', year: 2010, citedByCount: 80, itemID: 42, doi: '10.1/held' }),
      node({ key: 'cite', role: 'citing', year: 2022, citedByCount: 3 }),
    ],
    options,
  )!

  it('carries the identifiers a click needs', () => {
    const svg = renderGraphSvg(layout, theme)
    assert.ok(svg.includes('data-item-id="42"'))
    assert.ok(svg.includes('data-doi="10.1/seed"'))
  })

  it('rings works that are in the library', () => {
    const svg = renderGraphSvg(layout, theme)
    // Three marks, plus a ring for the held one and a halo for the seed.
    assert.equal(svg.match(/<circle /g)?.length, 5)
  })

  it('names year, citations and library membership on hover', () => {
    const svg = renderGraphSvg(layout, theme)
    assert.ok(svg.includes('<title>held · 2010 · 80 citations · in your library</title>'))
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
