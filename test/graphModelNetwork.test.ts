import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { buildGraphLayout, placeLabels, renderGraphSvg } from '../src/modules/graphModel.core.ts'

import type { GraphLink, GraphNode, LayoutOptions, Viewport } from '../src/modules/graphModel.core.ts'

/**
 * The single-paper graph, frozen.
 *
 * The fixture was written by the code as it stood before network mode was
 * added, and every addition since is optional -- so the star graph has to come
 * out of this module byte for byte as it did then. `ORBIT_UPDATE_SNAPSHOT=1`
 * rewrites it, which is only ever right when the star graph is meant to change.
 */
const FIXTURE = new URL('./fixtures/graphStar.snapshot.json', import.meta.url)

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
