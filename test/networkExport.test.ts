import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DOMParser } from 'linkedom'

import {
  connectedPapersUrl,
  DEEP_LINK_DOI_MAX,
  gapsToCsv,
  gapsToRis,
  incitefulUrl,
  localCitationNetworkUrl,
  openAlexCitesUrl,
  toGraphml,
  toVosviewerJson,
} from '../src/modules/networkExport.core.ts'
import { xmlErrors } from './svgWellFormed.ts'

import type { CollectionNetwork, Gap, NetworkWork, SeedWork } from '../src/modules/collectionTypes.ts'

/** Everything a title can do to a file format at once. */
const NASTY = 'Cats & dogs <in> "quotes", commas\nand a second line'

function seed(partial: Partial<SeedWork> & { openAlexId: string }): SeedWork {
  return {
    itemID: 1,
    doi: null,
    title: partial.openAlexId,
    year: 2020,
    citedByCount: 10,
    referenceCount: 5,
    authors: ['Ada Lovelace'],
    referencedWorks: [],
    primaryTopic: null,
    ...partial,
  }
}

function work(partial: Partial<NetworkWork> & { openAlexId: string }): NetworkWork {
  return {
    doi: null,
    title: partial.openAlexId,
    year: 2015,
    citedByCount: 100,
    referenceCount: 20,
    authors: [],
    direction: 'reference',
    seeds: [],
    match: null,
    ...partial,
  }
}

const gap: Gap = {
  ...work({
    openAlexId: 'W10',
    doi: '10.1000/gap(1);x',
    title: NASTY,
    year: 2010,
    citedByCount: 500,
    authors: ['Grace Hopper', 'Turing, Alan'],
    seeds: ['W1', 'W2'],
  }),
  match: null,
  score: 1.5,
  rank: 1,
}

const probable = work({
  openAlexId: 'W20',
  title: 'Probably held',
  direction: 'citing',
  seeds: ['W3'],
  match: { itemID: 9, confidence: 'probable', via: 'title' },
})

/** Two clusters, a seed without one, a gap that is also a work, and a probable match. */
function fixture(): CollectionNetwork {
  return {
    version: 1,
    scope: { kind: 'collection', collectionID: 1, libraryID: 1, name: 'My, "collection"' },
    builtAt: 0,
    seeds: [
      seed({ openAlexId: 'W1', doi: '10.1000/a/b', title: 'First seed', authors: ['Ada Lovelace'] }),
      seed({ openAlexId: 'W2', doi: '10.1000/c', title: NASTY, authors: ['Hopper, Grace'], year: null }),
      seed({ openAlexId: 'W3', doi: null, title: 'Unclustered seed', authors: [], citedByCount: null }),
    ],
    works: [work({ openAlexId: 'W10', seeds: ['W1', 'W2'] }), work({ openAlexId: 'W11' }), probable],
    coupling: [
      { a: 'W1', b: 'W2', shared: 3 },
      { a: 'W2', b: 'W99', shared: 2 }, // W99 is in no node set
    ],
    citations: [
      { from: 'W1', to: 'W10' },
      { from: 'W2', to: 'W10' },
      { from: 'W10', to: 'W2' }, // reciprocal: still one citation pair W2-W10
      { from: 'W1', to: 'W10' }, // duplicate row: adds nothing
      { from: 'W2', to: 'W1' }, // coupled and cited: adds to the W1-W2 link
      { from: 'W1', to: 'W11' }, // W11 is not a VOSviewer item
      { from: 'W1', to: 'W98' }, // W98 is nowhere
    ],
    clusters: [
      { id: 0, label: 'Big cluster', topicShare: 0.8, members: ['W1'] },
      { id: 1, label: 'Small & odd', topicShare: 0.5, members: ['W2'] },
    ],
    // No entry for the gap: W10 looks up as undefined, not null.
    clusterOf: { W1: 0, W2: 1, W3: null },
    gaps: [gap],
    probable: [probable],
    coverage: {
      itemsInScope: 3,
      analysed: 3,
      capped: false,
      resolved: 3,
      unresolved: [],
      citingIncluded: true,
      citingTruncated: false,
      requestsMade: 4,
    },
  }
}

/** A minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF records. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
    } else field += c
  }
  assert.equal(field, '', 'the last record ends with CRLF')
  return rows
}

describe('toVosviewerJson', () => {
  const parsed = JSON.parse(toVosviewerJson(fixture())) as {
    network: {
      items: Record<string, unknown>[]
      links: { source_id: number; target_id: number; strength: number }[]
      clusters: { cluster: number; label: string }[]
    }
  }
  const { items, links, clusters } = parsed.network

  it('has the seeds and the gaps as items with integer ids', () => {
    assert.deepEqual(
      items.map((item) => [item.id, item.url]),
      [
        [1, 'https://openalex.org/W1'],
        [2, 'https://openalex.org/W2'],
        [3, 'https://openalex.org/W3'],
        [4, 'https://openalex.org/W10'],
      ],
    )
  })

  it('labels by first author surname and year', () => {
    assert.deepEqual(
      items.map((item) => item.label),
      ['Lovelace 2020', 'Hopper', 'Unclustered seed 2020', 'Hopper 2010'],
    )
  })

  it('writes clusters 1-based and leaves them out when there is none', () => {
    assert.deepEqual(
      items.map((item) => item.cluster),
      [1, 2, undefined, undefined],
    )
    assert.ok(!('cluster' in items[2]) && !('cluster' in items[3]))
    assert.deepEqual(clusters, [
      { cluster: 1, label: 'Big cluster' },
      { cluster: 2, label: 'Small & odd' },
    ])
  })

  it('HTML-escapes the description', () => {
    assert.equal(items[1].description, 'Cats &amp; dogs &lt;in&gt; &quot;quotes&quot;, commas\nand a second line')
  })

  it('collapses coupling and citations into one undirected link per pair', () => {
    assert.deepEqual(links, [
      { source_id: 1, target_id: 2, strength: 4 }, // coupling 3 + W2->W1
      { source_id: 1, target_id: 4, strength: 1 },
      { source_id: 2, target_id: 4, strength: 1 }, // W2->W10 and W10->W2, one pair
    ])
    for (const link of links) assert.ok(link.source_id < link.target_id)
  })

  it('counts weights from the written links, with numbers only', () => {
    assert.deepEqual(items[0].weights, { 'Links': 2, 'Total link strength': 5, 'Citations': 10 })
    assert.deepEqual(items[2].weights, { 'Links': 0, 'Total link strength': 0, 'Citations': 0 })
    assert.deepEqual(items[0].scores, { 'Pub. year': 2020 })
    assert.deepEqual(items[1].scores, {})
  })
})

describe('toGraphml', () => {
  const xml = toGraphml(fixture())
  const doc = new DOMParser().parseFromString(xml, 'text/xml')

  it('is well-formed XML', () => {
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'))
    // svgWellFormed reads no prolog and no dotted attribute names; GraphML's
    // `attr.name` is legal XML, so it is renamed for the check only.
    const body = xml.replace(/^<\?xml[^?]*\?>\n/, '').replace(/\battr\./g, 'attr-')
    assert.deepEqual(xmlErrors(body), [])
  })

  it('declares every key and is directed', () => {
    const keys = [...doc.querySelectorAll('key')].map((key) => `${key.getAttribute('for')}:${key.getAttribute('id')}`)
    assert.deepEqual(keys, [
      'node:label',
      'node:title',
      'node:year',
      'node:doi',
      'node:openalex',
      'node:cluster',
      'node:role',
      'node:held',
      'edge:type',
      'edge:weight',
    ])
    assert.equal(doc.querySelector('graph')?.getAttribute('edgedefault'), 'directed')
  })

  function nodeData(id: string): Record<string, string> {
    const node = [...doc.querySelectorAll('node')].find((n) => n.getAttribute('id') === id)
    assert.ok(node, `node ${id}`)
    return Object.fromEntries([...node.querySelectorAll('data')].map((d) => [d.getAttribute('key'), d.textContent]))
  }

  it('gives each node its role and how it is held, once', () => {
    const ids = [...doc.querySelectorAll('node')].map((n) => n.getAttribute('id'))
    assert.deepEqual(ids, ['W1', 'W2', 'W3', 'W10', 'W11', 'W20'])
    assert.equal(nodeData('W1').role, 'seed')
    assert.equal(nodeData('W1').held, 'exact')
    assert.equal(nodeData('W10').role, 'gap')
    assert.equal(nodeData('W10').held, 'none')
    assert.equal(nodeData('W11').role, 'reference')
    assert.equal(nodeData('W20').role, 'citing')
    assert.equal(nodeData('W20').held, 'probable')
  })

  it('writes the cluster 1-based and nothing for none', () => {
    assert.equal(nodeData('W1').cluster, '1')
    assert.equal(nodeData('W2').cluster, '2')
    assert.ok(!('cluster' in nodeData('W3')))
    assert.ok(!('cluster' in nodeData('W10')))
    assert.ok(!('year' in nodeData('W2')))
  })

  it('escapes titles so they read back unchanged', () => {
    assert.equal(nodeData('W2').title, NASTY)
    assert.ok(xml.includes('Cats &amp; dogs &lt;in&gt; &quot;quotes&quot;'))
    assert.equal(nodeData('W10').doi, '10.1000/gap(1);x')
  })

  it('writes citations directed and coupling undirected, inside the node set only', () => {
    const edges = [...doc.querySelectorAll('edge')].map((e) => {
      const data = Object.fromEntries(
        [...e.querySelectorAll('data')].map((d) => [d.getAttribute('key'), d.textContent]),
      )
      return [e.getAttribute('source'), e.getAttribute('target'), data.type, data.weight, e.getAttribute('directed')]
    })
    assert.deepEqual(edges, [
      ['W1', 'W10', 'citation', '1', null],
      ['W2', 'W10', 'citation', '1', null],
      ['W10', 'W2', 'citation', '1', null],
      ['W2', 'W1', 'citation', '1', null],
      ['W1', 'W11', 'citation', '1', null],
      ['W1', 'W2', 'coupling', '3', 'false'],
    ])
  })

  it('drops characters XML cannot carry', () => {
    const net = fixture()
    net.seeds[0].title = 'bell\u0007 here'
    const out = toGraphml(net)
    assert.ok(out.includes('bell here'))
    assert.ok(!out.includes('\u0007'))
  })
})

describe('gapsToCsv', () => {
  const csv = gapsToCsv(fixture())

  it('starts with a BOM and uses CRLF', () => {
    assert.ok(csv.startsWith('﻿rank,'))
    assert.ok(csv.endsWith('\r\n'))
    // The only bare LFs are the ones inside the quoted title and seed title.
    assert.equal(csv.replace(/\r\n/g, '').split('\n').length, 3)
  })

  it('round-trips through an RFC 4180 reader', () => {
    const rows = parseCsv(csv.slice(1))
    assert.deepEqual(rows, [
      ['rank', 'direction', 'score', 'seedCount', 'title', 'year', 'doi', 'openalex', 'citedBy', 'citingSeeds'],
      [
        '1',
        'reference',
        '1.5',
        '2',
        NASTY,
        '2010',
        '10.1000/gap(1);x',
        'https://openalex.org/W10',
        '500',
        `First seed; ${NASTY}`,
      ],
    ])
  })

  it('leaves empty fields for missing values', () => {
    const net = fixture()
    net.gaps = [{ ...gap, year: null, doi: null, citedByCount: null, seeds: ['W404'] }]
    const rows = parseCsv(gapsToCsv(net).slice(1))
    assert.deepEqual(rows[1].slice(5), ['', '', 'https://openalex.org/W10', '', 'W404'])
  })

  it('writes a title a spreadsheet would run as a formula as text', () => {
    // Titles come from OpenAlex; opening the file must not execute them.
    for (const title of ['=HYPERLINK("http://x","y")', '+1+1', '-2', '@SUM(A1)', '\t=1']) {
      const net = fixture()
      net.gaps = [{ ...gap, title }]
      const rows = parseCsv(gapsToCsv(net).slice(1))
      assert.equal(rows[1][4], `'${title}`, title)
    }
    // An ordinary title and the numbers are untouched.
    const rows = parseCsv(gapsToCsv(fixture()).slice(1))
    assert.ok(!rows[1][4].startsWith("'"))
    assert.ok(!rows[1][2].startsWith("'"))
  })
})

describe('gapsToRis', () => {
  const ris = gapsToRis([gap])

  it('writes one record with one AU line per author', () => {
    assert.equal(
      ris,
      [
        'TY  - JOUR',
        'TI  - Cats & dogs <in> "quotes", commas and a second line',
        'AU  - Hopper, Grace',
        'AU  - Turing, Alan',
        'PY  - 2010',
        'DO  - 10.1000/gap(1);x',
        'UR  - https://openalex.org/W10',
        'ER  - ',
        '',
        '',
      ].join('\r\n'),
    )
  })

  it('skips PY and DO when unknown and writes nothing for no gaps', () => {
    const out = gapsToRis([{ ...gap, year: null, doi: null, authors: [] }])
    assert.ok(!/^(PY|DO|AU) {2}- /m.test(out))
    assert.equal(gapsToRis([]), '')
  })
})

describe('deep links', () => {
  const awkward = ['10.1000/a/b', '10.1000/x(1);2', 'https://doi.org/10.1000/c', 'doi:10.1000/D']

  it('Local Citation Network carries every DOI as LCN reads them back', () => {
    const url = localCitationNetworkUrl(awkward, 'My, "collection" & more')
    assert.ok(url)
    assert.ok(url.startsWith('https://localcitationnetwork.github.io/?API=OpenAlex&listOfIds='))
    assert.ok(url.includes('10.1000%2Fx(1)%3B2'))
    const params = new URL(url).searchParams
    assert.equal(params.get('API'), 'OpenAlex')
    assert.deepEqual(params.get('listOfIds')?.split(','), ['10.1000/a/b', '10.1000/x(1);2', '10.1000/c', '10.1000/D'])
    assert.equal(params.get('name'), 'My, "collection" & more')
  })

  it('Local Citation Network leaves out a DOI with a comma, which it would split', () => {
    const url = localCitationNetworkUrl(['10.1000/a,b', '10.1000/ok'], 'x')
    assert.deepEqual(new URL(url ?? '').searchParams.get('listOfIds')?.split(','), ['10.1000/ok'])
    assert.equal(localCitationNetworkUrl(['10.1000/a,b'], 'x'), null)
  })

  it('Inciteful carries every DOI as an ids[] entry', () => {
    const url = incitefulUrl(awkward)
    assert.ok(url)
    assert.ok(url.startsWith('https://incitefulmed.com/academic/p?ids[]=10.1000%2Fa%2Fb&ids[]='))
    assert.deepEqual(new URL(url).searchParams.getAll('ids[]'), [
      '10.1000/a/b',
      '10.1000/x(1);2',
      '10.1000/c',
      '10.1000/D',
    ])
  })

  it('stops at DEEP_LINK_DOI_MAX distinct DOIs', () => {
    const many = Array.from({ length: 150 }, (_, i) => `10.1000/${i}`)
    const withDuplicates = ['10.1000/0', '10.1000/0', ...many.map((d) => d.toUpperCase())]
    const lcn = new URL(localCitationNetworkUrl(withDuplicates, 'x') ?? '').searchParams.get('listOfIds')?.split(',')
    assert.equal(lcn?.length, DEEP_LINK_DOI_MAX)
    assert.equal(lcn?.[0], '10.1000/0')
    assert.equal(lcn?.[99], '10.1000/99')
    assert.equal(new URL(incitefulUrl(many) ?? '').searchParams.getAll('ids[]').length, DEEP_LINK_DOI_MAX)
  })

  it('is null without a DOI', () => {
    assert.equal(localCitationNetworkUrl([], 'x'), null)
    assert.equal(localCitationNetworkUrl([null, undefined, '', 'not a doi'], 'x'), null)
    assert.equal(incitefulUrl([null, 'nope']), null)
  })

  it('builds the single-work links', () => {
    assert.equal(
      connectedPapersUrl('649def34f8be52c8b66281af98ae884c09aef38b'),
      'https://www.connectedpapers.com/main/649def34f8be52c8b66281af98ae884c09aef38b/graph',
    )
    assert.equal(openAlexCitesUrl('W2741809807'), 'https://openalex.org/works?filter=cites:W2741809807')
  })
})
