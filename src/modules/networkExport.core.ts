/**
 * The collection network written out for other tools, and links into them.
 *
 * Pure: every function takes a `CollectionNetwork` (or part of one) and returns
 * a string. Saving and opening happen in networkExport.ts.
 *
 * Two facts about the network shape shape the code here:
 *
 * - `gaps` and `probable` are works too, and may or may not also appear in
 *   `works`. Every node set is therefore a union keyed by OpenAlex id, and an
 *   edge is written only when both of its ends made it into the set.
 * - `clusterOf` is keyed by seed. Looking a gap up in it gives `undefined`, not
 *   the `null` the type promises, so cluster numbers are read through
 *   `clusterNumber`, which treats anything that is not a number as "none".
 *
 * Cluster numbers are written 1-based in every format (VOSviewer requires
 * 1..1000), so the same cluster carries the same number in each file.
 */

import { normalizeDoi } from '../utils/identifiers.ts'

import type { CollectionNetwork, Gap, NetworkWork, OpenAlexId, SeedWork } from './collectionTypes.ts'

const OPENALEX_WORK_BASE = 'https://openalex.org/'

/** VOSviewer accepts cluster numbers 1..1000 only. */
const VOSVIEWER_MAX_CLUSTER = 1000

/** The most DOIs a deep link carries; the rest are left out. */
export const DEEP_LINK_DOI_MAX = 100

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The 1-based cluster number of a work, or null when it has none. */
function clusterNumber(net: CollectionNetwork, id: OpenAlexId): number | null {
  const raw = net.clusterOf[id] as number | null | undefined
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw + 1 : null
}

function openAlexUrl(id: OpenAlexId): string {
  return OPENALEX_WORK_BASE + id
}

/** Surname of a display name delivered as "Given Family" or "Family, Given". */
function surname(name: string): string {
  const trimmed = name.trim()
  if (trimmed.includes(',')) return trimmed.split(',')[0].trim()
  const parts = trimmed.split(/\s+/)
  return parts[parts.length - 1] ?? ''
}

/** "Family, Given" for RIS, from either delivered form. */
function risAuthor(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (trimmed.includes(',') || !trimmed.includes(' ')) return trimmed
  const cut = trimmed.lastIndexOf(' ')
  return `${trimmed.slice(cut + 1)}, ${trimmed.slice(0, cut)}`
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** XML text and attribute escape, dropping characters XML 1.0 cannot carry at all. */
function escapeXml(text: string): string {
  // eslint-disable-next-line no-control-regex
  return escapeHtml(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ''))
}

/** Undirected pair key over two ids, smaller first. */
function pairKey<T extends string | number>(a: T, b: T): [T, T] {
  return a < b ? [a, b] : [b, a]
}

// ---------------------------------------------------------------------------
// VOSviewer
// ---------------------------------------------------------------------------

interface VosItem {
  id: number
  label: string
  description: string
  url: string
  cluster?: number
  weights: { 'Links': number; 'Total link strength': number; 'Citations': number }
  scores: { 'Pub. year'?: number }
}

interface VosLink {
  source_id: number
  target_id: number
  strength: number
}

function vosLabel(work: { authors: readonly string[]; year: number | null; title: string }): string {
  const first = work.authors.length > 0 ? surname(work.authors[0]) : ''
  const head = first !== '' ? first : oneLine(work.title).slice(0, 40)
  return work.year === null ? head : `${head} ${work.year}`
}

/**
 * VOSviewer Online JSON (https://app.vosviewer.com/docs/file-types/json-file-type/).
 *
 * Items are the seeds and the gaps. One link per item pair, its strength the
 * coupling count plus one for each citation between the two, in either
 * direction -- so a pair that is coupled and cited, or that cites both ways,
 * is one link with the sum. `Links` and `Total link strength` are counted from
 * the links written.
 */
export function toVosviewerJson(net: CollectionNetwork): string {
  const works: (SeedWork | Gap)[] = []
  const intId = new Map<OpenAlexId, number>()
  for (const work of [...net.seeds, ...net.gaps]) {
    if (intId.has(work.openAlexId)) continue
    intId.set(work.openAlexId, works.length + 1)
    works.push(work)
  }

  const strength = new Map<string, VosLink>()
  const addLink = (a: OpenAlexId, b: OpenAlexId, amount: number): void => {
    const ia = intId.get(a)
    const ib = intId.get(b)
    if (ia === undefined || ib === undefined || ia === ib || amount <= 0) return
    const [source, target] = pairKey(ia, ib)
    const key = `${source}-${target}`
    const link = strength.get(key)
    if (link) link.strength += amount
    else strength.set(key, { source_id: source, target_id: target, strength: amount })
  }
  for (const edge of net.coupling) addLink(edge.a, edge.b, edge.shared)
  for (const edge of net.citations) addLink(edge.from, edge.to, 1)

  const links = [...strength.values()].sort((x, y) => x.source_id - y.source_id || x.target_id - y.target_id)
  const degree = new Map<number, number>()
  const total = new Map<number, number>()
  for (const link of links) {
    for (const end of [link.source_id, link.target_id]) {
      degree.set(end, (degree.get(end) ?? 0) + 1)
      total.set(end, (total.get(end) ?? 0) + link.strength)
    }
  }

  const items: VosItem[] = works.map((work, index) => {
    const id = index + 1
    const item: VosItem = {
      id,
      label: vosLabel(work),
      description: escapeHtml(work.title),
      url: openAlexUrl(work.openAlexId),
      weights: {
        'Links': degree.get(id) ?? 0,
        'Total link strength': total.get(id) ?? 0,
        'Citations': Math.max(0, work.citedByCount ?? 0),
      },
      scores: {},
    }
    const cluster = clusterNumber(net, work.openAlexId)
    if (cluster !== null && cluster <= VOSVIEWER_MAX_CLUSTER) item.cluster = cluster
    if (work.year !== null) item.scores['Pub. year'] = work.year
    return item
  })

  const clusters = net.clusters
    .filter((cluster) => cluster.id + 1 <= VOSVIEWER_MAX_CLUSTER)
    .map((cluster) => ({ cluster: cluster.id + 1, label: cluster.label }))

  return JSON.stringify({ network: { items, links, clusters } }, null, 2)
}

// ---------------------------------------------------------------------------
// GraphML
// ---------------------------------------------------------------------------

type Role = 'seed' | 'gap' | 'reference' | 'citing'
type Held = 'exact' | 'probable' | 'none'

interface GraphNodeRow {
  id: OpenAlexId
  label: string
  title: string
  year: number | null
  doi: string | null
  cluster: number | null
  role: Role
  held: Held
}

function nodeRows(net: CollectionNetwork): GraphNodeRow[] {
  const rows = new Map<OpenAlexId, GraphNodeRow>()
  for (const seed of net.seeds) {
    rows.set(seed.openAlexId, {
      id: seed.openAlexId,
      label: vosLabel(seed),
      title: seed.title,
      year: seed.year,
      doi: seed.doi,
      cluster: clusterNumber(net, seed.openAlexId),
      role: 'seed',
      held: 'exact',
    })
  }
  const gapIds = new Set(net.gaps.map((gap) => gap.openAlexId))
  const add = (work: NetworkWork): void => {
    if (rows.has(work.openAlexId)) return
    rows.set(work.openAlexId, {
      id: work.openAlexId,
      label: vosLabel(work),
      title: work.title,
      year: work.year,
      doi: work.doi,
      cluster: clusterNumber(net, work.openAlexId),
      role: gapIds.has(work.openAlexId) ? 'gap' : work.direction,
      held: work.match?.confidence ?? 'none',
    })
  }
  for (const gap of net.gaps) add(gap)
  for (const work of net.works) add(work)
  for (const work of net.probable) add(work)
  return [...rows.values()]
}

const GRAPHML_KEYS: readonly [string, 'node' | 'edge', 'string' | 'int' | 'double'][] = [
  ['label', 'node', 'string'],
  ['title', 'node', 'string'],
  ['year', 'node', 'int'],
  ['doi', 'node', 'string'],
  ['openalex', 'node', 'string'],
  ['cluster', 'node', 'int'],
  ['role', 'node', 'string'],
  ['held', 'node', 'string'],
  ['type', 'edge', 'string'],
  ['weight', 'edge', 'double'],
]

/**
 * GraphML, directed: seeds, every connected work, the gaps and the probable
 * matches as nodes; citations as citer -> cited edges, coupling as edges
 * marked `directed="false"` with the shared-reference count as weight.
 */
export function toGraphml(net: CollectionNetwork): string {
  const rows = nodeRows(net)
  const present = new Set(rows.map((row) => row.id))
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns"',
    '    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '    xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
  ]
  for (const [id, scope, type] of GRAPHML_KEYS) {
    lines.push(`  <key id="${id}" for="${scope}" attr.name="${id}" attr.type="${type}"/>`)
  }
  lines.push('  <graph id="orbit" edgedefault="directed">')

  const data = (key: string, value: string | number | null): string =>
    value === null ? '' : `<data key="${key}">${escapeXml(String(value))}</data>`

  for (const row of rows) {
    const fields = [
      data('label', row.label),
      data('title', row.title),
      data('year', row.year),
      data('doi', row.doi),
      data('openalex', openAlexUrl(row.id)),
      data('cluster', row.cluster),
      data('role', row.role),
      data('held', row.held),
    ].join('')
    lines.push(`    <node id="${escapeXml(row.id)}">${fields}</node>`)
  }

  let edgeIndex = 0
  const seenCitations = new Set<string>()
  for (const edge of net.citations) {
    if (edge.from === edge.to || !present.has(edge.from) || !present.has(edge.to)) continue
    const key = `${edge.from}>${edge.to}`
    if (seenCitations.has(key)) continue
    seenCitations.add(key)
    lines.push(
      `    <edge id="e${edgeIndex++}" source="${escapeXml(edge.from)}" target="${escapeXml(edge.to)}">` +
        `${data('type', 'citation')}${data('weight', 1)}</edge>`,
    )
  }
  for (const edge of net.coupling) {
    if (edge.a === edge.b || !present.has(edge.a) || !present.has(edge.b)) continue
    lines.push(
      `    <edge id="e${edgeIndex++}" source="${escapeXml(edge.a)}" target="${escapeXml(edge.b)}" directed="false">` +
        `${data('type', 'coupling')}${data('weight', edge.shared)}</edge>`,
    )
  }

  lines.push('  </graph>', '</graphml>', '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Gaps as CSV and RIS
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  'rank',
  'direction',
  'score',
  'seedCount',
  'title',
  'year',
  'doi',
  'openalex',
  'citedBy',
  'citingSeeds',
] as const

function csvField(value: string | number | null): string {
  if (value === null) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The gaps as RFC 4180 CSV: UTF-8 with a byte-order mark so spreadsheet
 * programs read it as UTF-8, CRLF line ends, fields quoted only when needed.
 */
export function gapsToCsv(net: CollectionNetwork): string {
  const seedTitle = new Map(net.seeds.map((seed) => [seed.openAlexId, seed.title]))
  const rows = [CSV_COLUMNS.join(',')]
  for (const gap of net.gaps) {
    const citing = gap.seeds.map((id) => seedTitle.get(id) ?? id).join('; ')
    rows.push(
      [
        gap.rank,
        gap.direction,
        gap.score,
        gap.seeds.length,
        gap.title,
        gap.year,
        gap.doi,
        openAlexUrl(gap.openAlexId),
        gap.citedByCount,
        citing,
      ]
        .map(csvField)
        .join(','),
    )
  }
  return '﻿' + rows.join('\r\n') + '\r\n'
}

/** The gaps as RIS journal articles, for import into Zotero or any manager. */
export function gapsToRis(gaps: readonly Gap[]): string {
  const records = gaps.map((gap) => {
    const lines = ['TY  - JOUR', `TI  - ${oneLine(gap.title)}`]
    for (const author of gap.authors) {
      const name = oneLine(author)
      if (name !== '') lines.push(`AU  - ${risAuthor(name)}`)
    }
    if (gap.year !== null) lines.push(`PY  - ${gap.year}`)
    if (gap.doi) lines.push(`DO  - ${oneLine(gap.doi)}`)
    lines.push(`UR  - ${openAlexUrl(gap.openAlexId)}`, 'ER  - ')
    return lines.join('\r\n')
  })
  return records.map((record) => record + '\r\n\r\n').join('')
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/** Normalised, case-insensitively unique DOIs, at most DEEP_LINK_DOI_MAX. */
function linkDois(
  dois: readonly (string | null | undefined)[],
  allow: (doi: string) => boolean = () => true,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of dois) {
    if (!raw) continue
    const doi = normalizeDoi(raw)
    if (doi === null || !allow(doi)) continue
    const key = doi.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(doi)
    if (out.length === DEEP_LINK_DOI_MAX) break
  }
  return out
}

/**
 * Local Citation Network, OpenAlex backend, with the DOIs as a custom list.
 *
 * LCN reads `listOfIds` with URLSearchParams and splits it on `,` after
 * decoding, so a DOI that itself contains a comma cannot be carried and is
 * left out. Null when no DOI remains.
 */
export function localCitationNetworkUrl(dois: readonly (string | null | undefined)[], name: string): string | null {
  const list = linkDois(dois, (doi) => !doi.includes(','))
  if (list.length === 0) return null
  const ids = list.map(encodeURIComponent).join(',')
  return `https://localcitationnetwork.github.io/?API=OpenAlex&listOfIds=${ids}&name=${encodeURIComponent(name)}`
}

/** Inciteful's literature-review graph over the DOIs. Null when there is none. */
export function incitefulUrl(dois: readonly (string | null | undefined)[]): string | null {
  const list = linkDois(dois)
  if (list.length === 0) return null
  return `https://incitefulmed.com/academic/p?${list.map((doi) => `ids[]=${encodeURIComponent(doi)}`).join('&')}`
}

/** Connected Papers' graph for one Semantic Scholar paper id. */
export function connectedPapersUrl(s2PaperId: string): string {
  return `https://www.connectedpapers.com/main/${encodeURIComponent(s2PaperId)}/graph`
}

/** OpenAlex's list of works citing one work. */
export function openAlexCitesUrl(openAlexId: OpenAlexId): string {
  return `https://openalex.org/works?filter=cites:${encodeURIComponent(openAlexId)}`
}
