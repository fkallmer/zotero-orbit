import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildGraphLayout,
  CLUSTER_PALETTE,
  FITTED,
  GAP_TIERS,
  NETWORK_MAX_RADIUS,
  hueFor,
  placeLabels,
  renderGraphSvg,
} from '../src/modules/graphModel.core.ts'
import { xmlErrors } from './svgWellFormed.ts'

import type { GraphLink, GraphNode, LayoutOptions, Viewport } from '../src/modules/graphModel.core.ts'

/**
 * The single-paper graph, frozen.
 *
 * The fixture was written by the code as it stood before network mode was
 * added, and every addition since is optional -- so the star graph has to come
 * out of this module byte for byte as it did then. `ORBIT_UPDATE_SNAPSHOT=1`
 * rewrites it, which is only ever right when the star graph is meant to change.
 */
const FIXTURE = join(import.meta.dirname, 'fixtures/graphStar.snapshot.json')

const theme = {
  seed: '#e34948',
  reference: '#2a78d6',
  citing: '#1baf7a',
  muted: '#5c5c5c',
  surface: '#ffffff',
}

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

/** A deterministic stand-in for Math.random, so the dense case is the same every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

interface StarCase {
  name: string
  nodes: GraphNode[]
  options: LayoutOptions
  /** A zoomed view to place labels in, with a pointed-at mark. */
  view: Viewport
  emphasis: string
}

function cases(): StarCase[] {
  const padding = { top: 10, right: 10, bottom: 20, left: 30 }

  // A seed with a handful of references and citing works, some filed, some
  // with paths among them -- what the tab draws for an ordinary paper.
  const small: GraphNode[] = [
    node({ key: 'seed', role: 'seed', year: 2015, citedByCount: 120, author: 'Soleimani', referenceCount: 40 }),
    node({ key: 'r1', year: 2001, citedByCount: 8400, author: 'Ada', referenceCount: 12, itemID: 5 }),
    node({ key: 'r2', year: 2004, citedByCount: 300, author: 'Babbage', referenceCount: 80 }),
    node({ key: 'r3', year: 2009, citedByCount: 45, author: null, title: 'An untitled <thing> & more', doi: '10.1/x' }),
    node({ key: 'r4', year: 2012, citedByCount: 0, author: 'Curie', referenceCount: 3 }),
    node({ key: 'c1', role: 'citing', year: 2017, citedByCount: 20, author: 'Darwin', itemID: 9 }),
    node({ key: 'c2', role: 'citing', year: 2019, citedByCount: 4, author: 'Euler', referenceCount: 200 }),
    node({ key: 'c3', role: 'citing', year: 2021, citedByCount: null, author: 'Fermat' }),
    node({ key: 'c4', role: 'citing', year: 2022, citedByCount: 1, author: 'Gauss' }),
  ]
  const smallLinks: GraphLink[] = [
    { from: 'r2', to: 'r1' },
    { from: 'c2', to: 'c1' },
    { from: 'c3', to: 'r1' },
  ]

  // Fifty works crowded into a few years: the case label placement exists for.
  const random = prng(7)
  const dense: GraphNode[] = [
    node({ key: 'seed', role: 'seed', year: 2018, citedByCount: 60, author: 'Hopper', referenceCount: 55 }),
  ]
  for (let i = 0; i < 50; i++) {
    const role = i % 3 === 0 ? 'citing' : 'reference'
    dense.push(
      node({
        key: `n${i}`,
        role,
        year: role === 'citing' ? 2018 + Math.floor(random() * 6) : 2008 + Math.floor(random() * 10),
        citedByCount: Math.floor(random() ** 3 * 5000),
        author: `Author${i}`,
        referenceCount: Math.floor(random() * 120),
        itemID: i % 7 === 0 ? 100 + i : null,
      }),
    )
  }
  const denseLinks: GraphLink[] = []
  for (let i = 0; i < 30; i++) {
    denseLinks.push({ from: `n${Math.floor(random() * 50)}`, to: `n${Math.floor(random() * 50)}` })
  }

  return [
    {
      name: 'small',
      nodes: small,
      options: { width: 640, height: 360, padding, links: smallLinks },
      view: { kx: 1.6, ky: 1.2, tx: -80, ty: -20, width: 640, height: 360 },
      emphasis: 'r1',
    },
    {
      name: 'dense-linear',
      nodes: dense,
      options: { width: 720, height: 420, padding, scale: 'linear', links: denseLinks },
      view: { kx: 2.5, ky: 1, tx: -400, ty: 0, width: 720, height: 420 },
      emphasis: 'n4',
    },
    {
      name: 'references-axis',
      nodes: dense.slice(0, 25),
      options: { width: 500, height: 300, padding, xMetric: 'citations', yMetric: 'references' },
      view: { kx: 1, ky: 1, tx: 0, ty: 0, width: 500, height: 300 },
      emphasis: 'seed',
    },
  ]
}

/**
 * Six hundred works, a third of them seeds: the size network mode has to carry.
 *
 * Shared by the frozen large case and the timing test, so the timing is of the
 * same realistic mix -- seeds search four rings of spots and are the expensive
 * part, so a field of references alone would flatter the number.
 */
function largeField(count = 600): GraphNode[] {
  const random = prng(11)
  const roles = ['seed', 'reference', 'citing'] as const
  return Array.from({ length: count }, (_, i) =>
    node({
      key: `w${i}`,
      role: roles[i % 3],
      year: 1990 + Math.floor(random() * 35),
      citedByCount: Math.floor(random() ** 3 * 20000),
      author: `Author${i}`,
      referenceCount: Math.floor(random() * 150),
      itemID: i % 5 === 0 ? i : null,
    }),
  )
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of cases()) {
    const layout = buildGraphLayout(c.nodes, c.options)
    assert.ok(layout)
    out[c.name] = {
      layout: {
        nodes: layout.nodes,
        xTicks: layout.xTicks,
        yTicks: layout.yTicks,
        links: layout.links,
        dropped: layout.dropped,
      },
      svg: renderGraphSvg(layout, theme, { x: 'Year', y: 'Citations' }, `snap-${c.name}`),
      zoomed: placeLabels(layout.nodes, c.view, c.emphasis, (n) => [`${n.citedByCount ?? '?'} citations`]),
    }
  }

  // Large enough that a bucketed overlap check would show any disagreement
  // with the all-pairs one it replaced; hashed to keep the fixture readable.
  const large = buildGraphLayout(largeField(), {
    width: 900,
    height: 560,
    padding: { top: 10, right: 10, bottom: 20, left: 30 },
  })
  assert.ok(large)
  const describe = (n: GraphNode): string[] => [`${n.citedByCount ?? '?'} citations`]
  out.large = {
    layout: hash([large.nodes, large.xTicks, large.yTicks]),
    svg: hash(renderGraphSvg(large, theme)),
    labelled: large.nodes.filter((n) => n.label !== null).length,
    zoomed: hash(placeLabels(large.nodes, { kx: 3, ky: 2, tx: -900, ty: -300, width: 900, height: 560 })),
    pointed: hash(
      placeLabels(large.nodes, { kx: 1.5, ky: 1.5, tx: -200, ty: -100, width: 900, height: 560 }, 'w301', describe),
    ),
  }
  return out
}

describe('star mode', () => {
  it('renders the single-paper graph byte for byte as before network mode', () => {
    // Through JSON and back so the comparison is of values, not of the file's
    // formatting; the SVG is one string in it and is compared exactly.
    const current: unknown = JSON.parse(JSON.stringify(snapshot()))
    if (process.env.ORBIT_UPDATE_SNAPSHOT === '1') writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`)
    const frozen: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    assert.deepStrictEqual(current, frozen)
  })
})

const padding = { top: 10, right: 10, bottom: 20, left: 30 }
const network: LayoutOptions = { width: 640, height: 360, padding, mode: 'network' }
const clustered = { ...theme, clusters: ['#111111', '#222222', '#333333'] }

/** The markup of one mark's group, by key. */
function markOf(svg: string, key: string): string {
  const match = new RegExp(`<g data-mark="1" data-key="${key}"[^>]*>(.*?)</g>`).exec(svg)
  assert.ok(match, `no mark for ${key}`)
  return match[1]
}

const field = (): GraphNode[] => [
  node({ key: 's1', role: 'seed', year: 2010, citedByCount: 300, author: 'Ada', cluster: 0 }),
  node({ key: 's2', role: 'seed', year: 2014, citedByCount: 40, author: 'Babbage', cluster: 1 }),
  node({ key: 's3', role: 'seed', year: 2018, citedByCount: 5, author: 'Curie', cluster: null }),
  node({ key: 'g1', role: 'reference', year: 2001, citedByCount: 9000, author: 'Darwin', hollow: true }),
  node({ key: 'c1', role: 'citing', year: 2021, citedByCount: 2, author: 'Euler', itemID: 4, match: 'probable' }),
  node({ key: 'c2', role: 'citing', year: 2022, citedByCount: 1, author: 'Fermat', itemID: 5, match: 'exact' }),
]

describe('network mode', () => {
  it('draws no star edges when no links are passed', () => {
    const layout = buildGraphLayout(field(), network)
    assert.ok(layout)
    const svg = renderGraphSvg(layout, clustered)
    assert.deepEqual(xmlErrors(svg), [])
    assert.ok(!svg.includes('data-edge'), 'an edge was drawn with no link to draw it from')
  })

  it('draws the links it is given and nothing else', () => {
    const links: GraphLink[] = [
      { from: 's2', to: 's1' },
      { from: 'c1', to: 's3' },
    ]
    const layout = buildGraphLayout(field(), { ...network, links })
    assert.ok(layout)
    const svg = renderGraphSvg(layout, clustered)
    assert.equal(svg.match(/data-edge="1"/g)?.length, 2)
    assert.equal(svg.match(/data-link="/g)?.length, 2)
  })

  it('leaves star mode drawing one edge per surrounding work', () => {
    const layout = buildGraphLayout(field(), { ...network, mode: 'star' })
    assert.ok(layout)
    // Three seeds, three others: the star runs from the first seed found.
    assert.equal(renderGraphSvg(layout, theme).match(/data-edge="1"/g)?.length, 3)
  })

  it('takes any number of seeds and gives none of them a halo or a size floor', () => {
    const layout = buildGraphLayout(field(), network)
    assert.ok(layout)
    const seeds = layout.nodes.filter((n) => n.role === 'seed')
    assert.equal(seeds.length, 3)
    // referenceCount null gives the base radius; the star's floor is 16.
    for (const seed of seeds) assert.equal(seed.radius, 6)
    assert.ok(!renderGraphSvg(layout, clustered).includes('opacity="0.35"'), 'a seed halo was drawn')
  })

  it('reports its mode and label roles on the layout', () => {
    const layout = buildGraphLayout(field(), { ...network, labelRoles: ['seed'] })
    assert.equal(layout?.mode, 'network')
    assert.deepEqual(layout?.labelRoles, ['seed'])
    const star = buildGraphLayout(field(), { width: 640, height: 360, padding })
    assert.equal(star?.mode, 'star')
    assert.equal(star?.labelRoles, null)
  })
})

describe('cluster colour', () => {
  it('fills a mark with its cluster hue when the theme has a palette', () => {
    const layout = buildGraphLayout(field(), network)
    assert.ok(layout)
    const svg = renderGraphSvg(layout, clustered)
    assert.match(markOf(svg, 's1'), /fill="#111111"/)
    assert.match(markOf(svg, 's2'), /fill="#222222"/)
    assert.match(markOf(svg, 's3'), new RegExp(`fill="${theme.muted}"`))
  })

  it('falls back to the muted neutral for no cluster or one past the palette', () => {
    assert.equal(hueFor(node({ key: 'a', cluster: null }), clustered), theme.muted)
    assert.equal(hueFor(node({ key: 'b', cluster: 7 }), clustered), theme.muted)
  })

  it('leaves the role hue alone without a palette, or for a work with no cluster field', () => {
    assert.equal(hueFor(node({ key: 'a', role: 'seed', cluster: 1 }), theme), theme.seed)
    assert.equal(hueFor(node({ key: 'b', role: 'citing' }), clustered), theme.citing)
  })

  it('ships a default palette of distinct hues', () => {
    assert.equal(new Set(CLUSTER_PALETTE).size, CLUSTER_PALETTE.length)
    assert.ok(CLUSTER_PALETTE.length >= 9)
    for (const hue of CLUSTER_PALETTE) assert.match(hue, /^#[0-9a-f]{6}$/)
  })
})

describe('mark shape', () => {
  it('draws a hollow work as a ring in its hue that still takes the pointer', () => {
    const layout = buildGraphLayout(field(), network)
    assert.ok(layout)
    const mark = markOf(renderGraphSvg(layout, clustered), 'g1')
    assert.match(mark, /fill="none" stroke="#2a78d6" stroke-width="2" pointer-events="all"/)
    assert.match(mark, /data-key="g1"/)
  })

  it('dashes the collar of a probable match and keeps an exact one solid', () => {
    const layout = buildGraphLayout(field(), network)
    assert.ok(layout)
    const svg = renderGraphSvg(layout, clustered)
    assert.match(markOf(svg, 'c1'), /stroke-dasharray="2 2"/)
    assert.ok(markOf(svg, 'c2').includes('stroke-width="1.6" opacity'))
    assert.ok(!markOf(svg, 'c2').includes('dasharray'))
  })

  it('draws no collar without an item, whatever the match says', () => {
    const layout = buildGraphLayout([node({ key: 'x', match: 'probable' })], network)
    assert.ok(layout)
    assert.ok(!renderGraphSvg(layout, theme).includes('stroke-width="1.6"'))
  })
})

describe('labelRoles', () => {
  it('labels only the roles asked for at the fitted view', () => {
    const layout = buildGraphLayout(field(), { ...network, labelRoles: ['seed'] })
    assert.ok(layout)
    const labelled = layout.nodes.filter((n) => n.label !== null)
    assert.ok(labelled.length > 0)
    assert.ok(labelled.every((n) => n.role === 'seed'))
  })

  it('still labels the pointed-at mark whatever its role', () => {
    const layout = buildGraphLayout(field(), network)
    assert.ok(layout)
    const placements = placeLabels(layout.nodes, FITTED(640, 360), 'g1', undefined, { labelRoles: ['seed'] })
    assert.ok(placements.some((p) => p.key === 'g1'))
    assert.ok(placements.every((p) => p.key === 'g1' || p.key.startsWith('s')))
  })

  it('keeps unlabelled marks as obstacles', () => {
    // A small seed under a large unnamed reference: the spots next to the seed
    // lie inside the reference's disc, so the name goes further out, or
    // nowhere -- and sits close the moment the reference is taken away.
    const nodes = [
      node({ key: 'big', role: 'reference', year: 2015, citedByCount: 100, referenceCount: 400 }),
      node({ key: 's', role: 'seed', year: 2015, citedByCount: 100, author: 'Ada' }),
      node({ key: 'a', role: 'reference', year: 2000, citedByCount: 1 }),
      node({ key: 'b', role: 'reference', year: 2030, citedByCount: 10000 }),
    ]
    const layout = buildGraphLayout(nodes, network)
    assert.ok(layout)
    const only = { labelRoles: ['seed'] as const }
    const big = layout.nodes.find((n) => n.key === 'big')
    const seed = layout.nodes.find((n) => n.key === 's')
    assert.ok(big && seed)
    const crowded = placeLabels(layout.nodes, FITTED(640, 360), null, undefined, only).find((p) => p.key === 's')
    // Wherever the name went, it is not on the unnamed mark.
    if (crowded) assert.ok(Math.abs(crowded.y - big.y) > big.radius, 'the seed was named on top of an unnamed mark')
    const clear = placeLabels(
      layout.nodes.filter((n) => n.key !== 'big'),
      FITTED(640, 360),
      null,
      undefined,
      only,
    ).find((p) => p.key === 's')
    assert.ok(clear)
    if (crowded)
      assert.ok(Math.abs(clear.y - seed.y) < Math.abs(crowded.y - seed.y), 'the obstacle did not move the name')
  })

  it('caps the size of a mark in a network, not in the single-paper graph', () => {
    const review = node({ key: 'r', role: 'seed', referenceCount: 4000 })
    const inNetwork = buildGraphLayout([review], network)
    const inStar = buildGraphLayout([review], { ...network, mode: 'star' })
    assert.equal(inNetwork?.nodes[0]?.radius, NETWORK_MAX_RADIUS)
    assert.ok((inStar?.nodes[0]?.radius ?? 0) > 100)
  })
})

describe('performance', () => {
  it('lays out and labels six hundred works quickly', () => {
    const nodes = largeField()
    const opts: LayoutOptions = { width: 900, height: 560, padding, mode: 'network' }
    const view = { kx: 2, ky: 1.5, tx: -400, ty: -150, width: 900, height: 560 }
    const run = (): number => {
      const start = performance.now()
      const layout = buildGraphLayout(nodes, opts)
      assert.ok(layout)
      placeLabels(layout.nodes, view, 'w300', undefined, { mode: 'network' })
      return performance.now() - start
    }
    for (let i = 0; i < 3; i++) run()
    const times = Array.from({ length: 9 }, run).sort((a, b) => a - b)
    const median = times[4]
    console.log(`600 works, layout + placeLabels: median ${median.toFixed(2)} ms, max ${times[8].toFixed(2)} ms`)
    // The target is 25 ms; the bound is loose because test files run in parallel.
    assert.ok(median < 100, `median ${median.toFixed(1)} ms`)
  })
})

describe('ranked gaps', () => {
  const gapAt = (rank: number | null): string => {
    const layout = buildGraphLayout(
      [
        node({ key: 'S', role: 'seed', year: 2010, citedByCount: 100, itemID: 1 }),
        node({ key: 'G', year: 2005, citedByCount: 50, hollow: true, gapRank: rank }),
      ],
      {
        width: 600,
        height: 400,
        padding: { top: 10, right: 10, bottom: 20, left: 30 },
        mode: 'network',
        labelRoles: ['seed'],
      },
    )
    assert.ok(layout)
    const svg = renderGraphSvg(layout, theme)
    const mark = /<g data-mark="1" data-key="G"[^>]*>(.*?)<\/g>/.exec(svg)
    assert.ok(mark)
    return mark[1]
  }

  it('numbers the first ten, heavy and tinted, in their own hue', () => {
    const mark = gapAt(3)
    assert.match(mark, /fill="#2a78d6" fill-opacity="0.14" stroke="#2a78d6" stroke-width="3.2"/)
    assert.match(mark, />3<\/text>/)
  })

  it('draws the next twenty heavier, without a number', () => {
    const mark = gapAt(GAP_TIERS.coloured)
    assert.match(mark, /fill="none" stroke="#2a78d6" stroke-width="2.4"/)
    assert.doesNotMatch(mark, /<text/)
  })

  it('draws the rest faint', () => {
    const mark = gapAt(GAP_TIERS.coloured + 1)
    assert.match(mark, /stroke-width="1.4" stroke-opacity="0.45"/)
  })

  it('leaves an unranked gap as before', () => {
    assert.match(gapAt(null), /fill="none" stroke="[^"]+" stroke-width="2" pointer-events="all"/)
  })
})
