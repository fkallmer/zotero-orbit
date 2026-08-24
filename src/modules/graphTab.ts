/**
 * The citation graph tab.
 *
 * Scaffolding only: it opens, it is titled, it draws a placeholder. No data,
 * no layout, no interaction. Rendering inside Zotero's chrome has cost this
 * plugin an evening already -- namespaces, a sanitizer that strips `xmlns`,
 * Fluent messages that wipe an element's children -- so the container is
 * proven to paint before anything is stacked on it.
 *
 * `Zotero_Tabs.add` hands back a `<tab-content>` element to fill however we
 * like, so this is the supported route rather than a workaround.
 */

import { getLocaleID, getString } from '../utils/locale'
import { debugLog } from '../utils/log'
import { getPref, setPref } from '../utils/prefs'
import { readCache } from '../utils/recordCache'
import { toS2PaperRefs } from '../utils/s2Identifiers'

import { Helpers } from './citationTally'
import {
  AXIS_GUTTER,
  AXIS_METRICS,
  buildGraphLayout,
  edgeEnds,
  placeLabels,
  renderGraphSvg,
} from './graphModel.core.ts'
import { getDoiIndex, normalizeDoi } from './libraryIndex'
import { fetchCitingWorks, fetchReferences, fetchScholarlyRecord } from './openAlexEnrichment'
import { s2DetailsCacheKey } from './s2Details'

import type { AxisMetric, GraphLayout, GraphNode, GraphTheme, ScaleKind } from './graphModel.core.ts'
import type { ResolvedReference } from './openAlexClient.core.ts'
import type { S2Details } from './semanticScholarClient.core'
import type { FluentMessageId } from '../../typings/i10n'

/** The item pane is a XUL document; so is this. See citationPane. */
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/**
 * Every entry in Zotero's context menus is `menuitem-iconic`, a class the menu
 * manager only adds when an icon is given. The first version passed none and
 * the entries rendered as blank clickable rows.
 *
 * `onShowing` is deliberately absent throughout: the menu manager calls it as a
 * hook and discards what it returns, so guarding a menu with it does nothing.
 * The guard lives in onCommand, where seedFromSelection returns null and the
 * command is a no-op.
 */
const GRAPH_MENU_ICON = 'chrome://zotero/skin/16/universal/related.svg'

/** The `data-item-type` token the tab icon rule keys on. */
const TAB_ICON_TYPE = 'citationtally-graph'

const TAB_ICON_STYLE_ID = 'citationtally-tab-icon-style'

/**
 * Supply the CSS rule for our tab icon.
 *
 * Zotero has no hook for a plugin tab icon: the tab bar hands data.icon to
 * CSSItemTypeIcon, which only sets `data-item-type` and leaves the picture to
 * the stylesheet. So the stylesheet is what we add.
 */
export function installTabIconStyle(win: Window): void {
  const doc = win.document
  if (doc.getElementById(TAB_ICON_STYLE_ID)) return
  const style = doc.createElementNS(XHTML_NS, 'style')
  style.id = TAB_ICON_STYLE_ID
  style.textContent =
    `.tab-icon[data-item-type="${TAB_ICON_TYPE}"] {` +
    `  background-image: url("chrome://${addon.data.config.addonRef}/content/icons/pane16.svg");` +
    `  -moz-context-properties: fill, fill-opacity;` +
    `  fill: currentColor;` +
    `}`
  doc.documentElement?.appendChild(style)
}

export function removeTabIconStyle(win: Window): void {
  win.document.getElementById(TAB_ICON_STYLE_ID)?.remove()
}

/**
 * One tab per seed, reused rather than reopened.
 *
 * Without a stable id every invocation stacks another tab, and a menu item
 * that is easy to hit twice leaves a row of identical graphs.
 */
function tabIDFor(seed: GraphSeed): string {
  switch (seed.kind) {
    case 'collection':
      return `citationtally-graph-collection-${seed.collectionID}`
    case 'items':
      return `citationtally-graph-items-${seed.itemIDs.slice().sort().join('-')}`
    case 'library':
      return `citationtally-graph-library-${seed.libraryID}`
  }
}

export type GraphSeed =
  | { kind: 'collection'; collectionID: number; name: string }
  | { kind: 'items'; itemIDs: number[]; name: string }
  | { kind: 'library'; libraryID: number; name: string }

function el(doc: Document, tag: string, text?: string): HTMLElement {
  const node = doc.createElementNS(XHTML_NS, tag) as HTMLElement
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * Fill the tab with something unmistakably ours.
 *
 * A framed box with the seed spelled out: enough to tell "the container paints
 * and knows what it was opened for" from "the tab opened empty", which are the
 * two outcomes worth distinguishing before any real work goes in.
 */
function renderPlaceholder(doc: Document, container: Element, seed: GraphSeed, note?: string): void {
  const root = el(doc, 'div')
  // width as well as height: a block child of the XUL tab container does not
  // stretch on its own, and without it the centring only worked vertically.
  root.style.cssText =
    'display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;' +
    'width:100%;height:100%;padding:24px;font-size:13px;box-sizing:border-box'

  const frame = el(doc, 'div')
  frame.style.cssText =
    'display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;' +
    'border:2px dashed currentColor;border-radius:8px;opacity:.65;' +
    'padding:32px 40px;max-width:520px;text-align:center;line-height:1.45'

  const title = el(doc, 'div', getString('graph-placeholder-title'))
  title.style.cssText = 'font-weight:600;font-size:15px'

  const what = el(doc, 'div', seed.name)
  what.style.cssText = 'opacity:.85'

  const noteText = el(doc, 'div', note ?? getString('graph-placeholder-note'))
  noteText.style.cssText = 'font-size:12px;opacity:.75'

  frame.append(title, what, noteText)
  root.append(frame)
  container.replaceChildren(root)
}

export function openGraphTab(seed: GraphSeed): void {
  const win = Zotero.getMainWindow()
  if (!win) return

  const tabs = (win as unknown as { Zotero_Tabs?: Zotero_Tabs }).Zotero_Tabs
  if (!tabs) {
    debugLog('Citation debug - Zotero_Tabs unavailable; cannot open the graph tab')
    return
  }

  const id = tabIDFor(seed)
  // Already open: select it rather than adding a duplicate.
  const existing = win.document.getElementById(id)
  if (existing) {
    tabs.select(id)
    return
  }

  const { container } = tabs.add({
    id,
    type: 'citationtally-graph',
    title: getString('graph-tab-title', { args: { name: seed.name } }),
    // The tab bar reads its icon from data.icon; `related` is Zotero's own
    // linked-rings glyph, which is the concept exactly.
    // The tab bar routes every non-library tab through CSSItemTypeIcon, which
    // renders <span data-item-type="…"> and expects a Zotero item type. An icon
    // name lands there and matches no rule, which is why `related` produced the
    // default document glyph. Passing our own token and supplying the rule is
    // the way in -- see installTabIconStyle.
    data: { icon: TAB_ICON_TYPE },
    select: true,
  })

  // Something on screen before any fetching starts, so an empty tab always
  // means a failure rather than a wait.
  renderPlaceholder(win.document, container, seed, getString('graph-loading'))
  Zotero.debug(`Citation Tally: graph tab opened for ${seed.kind} "${seed.name}"`)

  void (async () => {
    try {
      const item = itemsForSeed(seed)[0]
      const nodes = item ? await collectNodes(item, false) : []
      if (nodes.length === 0) {
        renderPlaceholder(win.document, container, seed, getString('graph-empty'))
        return
      }
      renderGraph(win, container, seed, nodes)
      Zotero.debug(`Citation Tally: graph rendered with ${nodes.length} nodes`)
    } catch (err) {
      Zotero.debug(`Citation Tally: graph failed: ${String(err)}`)
      renderPlaceholder(win.document, container, seed, String(err))
    }
  })()
}

/** The seed for the current selection, or null when there is nothing to graph. */
export function seedFromSelection(): GraphSeed | null {
  const pane = Zotero.getActiveZoteroPane()
  if (!pane) return null

  const items = pane.getSelectedItems().filter((item) => item.isRegularItem())
  if (items.length > 0) {
    return {
      kind: 'items',
      itemIDs: items.map((item) => item.id),
      name:
        items.length === 1
          ? items[0].getField('title') || getString('graph-seed-untitled')
          : getString('graph-seed-items', { args: { count: items.length } }),
    }
  }

  const collections = pane.getSelectedCollections()
  if (collections.length > 0) {
    return { kind: 'collection', collectionID: collections[0].id, name: collections[0].name }
  }
  return null
}

export function registerGraphMenus(): void {
  // Tools: the whole library, and the way back to a tab that was closed.
  Zotero.MenuManager.registerMenu({
    menuID: `${addon.data.config.addonID}-graph-tools`,
    pluginID: addon.data.config.addonID,
    target: 'main/menubar/tools',
    menus: [
      {
        menuType: 'menuitem',
        l10nID: getLocaleID('menuitem-graph-library'),
        icon: GRAPH_MENU_ICON,
        onCommand: () => {
          const pane = Zotero.getActiveZoteroPane()
          const libraryIDs = pane?.getSelectedLibraryIDs() ?? []
          const libraryID = libraryIDs[0] ?? Zotero.Libraries.userLibraryID
          const library = Zotero.Libraries.get(libraryID)
          openGraphTab({
            kind: 'library',
            libraryID,
            // Libraries.get returns false, not undefined, for an unknown id.
            name: library ? library.name : getString('graph-seed-library'),
          })
        },
      },
    ],
  })

  // A collection is the set someone actually wants to see as a graph.
  Zotero.MenuManager.registerMenu({
    menuID: `${addon.data.config.addonID}-graph-collection`,
    pluginID: addon.data.config.addonID,
    target: 'main/library/collection',
    menus: [
      {
        menuType: 'menuitem',
        l10nID: getLocaleID('menuitem-graph-selection'),
        icon: GRAPH_MENU_ICON,
        onCommand: () => {
          const seed = seedFromSelection()
          if (seed) openGraphTab(seed)
        },
      },
    ],
  })

  Zotero.MenuManager.registerMenu({
    menuID: `${addon.data.config.addonID}-graph-items`,
    pluginID: addon.data.config.addonID,
    target: 'main/library/item',
    menus: [
      {
        menuType: 'menuitem',
        l10nID: getLocaleID('menuitem-graph-selection'),
        icon: GRAPH_MENU_ICON,
        onCommand: () => {
          const seed = seedFromSelection()
          if (seed) openGraphTab(seed)
        },
      },
    ],
  })
}

/** Minimal shape of the parts of Zotero_Tabs this module uses. */
interface Zotero_Tabs {
  add: (options: { id: string; type: string; title: string; data: Record<string, unknown>; select?: boolean }) => {
    id: string
    container: Element
  }
  select: (id: string) => void
}

/** Marks read against the tab surface, which differs from the item pane's. */
function themeFor(win: Window): GraphTheme {
  const dark = win.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
  return dark
    ? { seed: '#e66767', reference: '#3987e5', citing: '#199e70', muted: '#c3c2b7', surface: '#1a1a19' }
    : { seed: '#e34948', reference: '#2a78d6', citing: '#1baf7a', muted: '#5c5c5c', surface: '#ffffff' }
}

/**
 * Gather the works around a seed item.
 *
 * Everything here is already cached by the pane and the count path for any
 * item that has been tallied, so a graph over familiar items costs little. The
 * citing direction is the one genuinely new request.
 */
async function collectNodes(item: Zotero.Item, force: boolean): Promise<GraphNode[]> {
  const identifiers = Helpers.getAllItemIdentifiers(item)
  if (identifiers.length === 0) return []

  const record = await fetchScholarlyRecord(identifiers, { force })
  if (!record) return []

  // Semantic Scholar first for the backward direction: measured across five
  // papers it resolves consistently more than OpenAlex, 74 against 58 on one.
  // OpenAlex covers the cases where a publisher has told S2 not to serve the
  // list at all.
  const s2 = toS2PaperRefs(identifiers)
    .map((ref) => readCache<S2Details>(s2DetailsCacheKey(ref.paperId)))
    .find((found) => found !== null)

  let references: ResolvedReference[] = (s2?.references ?? []).map((ref) => ({
    title: ref.title,
    doi: ref.doi,
    year: ref.year,
    citedByCount: ref.citedByCount,
    author: ref.author,
    referenceCount: ref.referenceCount,
  }))
  if (references.length === 0) references = await fetchReferences(record, { force })

  const citing = await fetchCitingWorks(record, { force })

  // One pass over the library rather than a search per work; the index is
  // memoised and dropped when items change. See libraryIndex.
  const inLibrary = await getDoiIndex(item.libraryID)

  const seen = new Set<string>()
  const nodes: GraphNode[] = []
  const push = (
    title: string | null,
    doi: string | null,
    year: number | null,
    citedByCount: number | null,
    role: GraphNode['role'],
    author: string | null = null,
    referenceCount: number | null = null,
  ): void => {
    const key = (doi ?? title ?? '').toLowerCase()
    // A work can be both cited and citing across a wider graph; first role wins
    // so the seed and its references keep their identity.
    if (key === '' || seen.has(key)) return
    seen.add(key)
    // Which of these the reader already has is a fact about them rather than
    // about the citation, so it is looked up here and encoded as ink rather
    // than as a fourth colour.
    const itemID = doi ? (inLibrary.get(normalizeDoi(doi)) ?? null) : null
    nodes.push({ key, title: title ?? doi ?? '', year, citedByCount, role, doi, author, referenceCount, itemID })
  }

  push(
    record.title ?? item.getField('title'),
    identifiers.find((id) => id.type === 'doi')?.id ?? null,
    record.publicationYear,
    record.citedByCount,
    'seed',
    record.authors[0]?.name.split(/\s+/).pop() ?? null,
    record.referencedWorksCount,
  )
  for (const ref of references) {
    push(ref.title, ref.doi, ref.year, ref.citedByCount, 'reference', ref.author ?? null, ref.referenceCount ?? null)
  }
  for (const cite of citing) {
    push(cite.title, cite.doi, cite.year, cite.citedByCount, 'citing', cite.author, cite.referenceCount)
  }
  return nodes
}

const PADDING = { top: 18, right: 24, bottom: 26, left: 44 }

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * A 16px line icon, built element by element.
 *
 * Not innerHTML: Zotero's sanitizer strips the SVG namespace off parsed markup
 * and what comes back is no longer a drawing. Not a glyph either -- the tab
 * inherits whatever font the platform gives it, and half of these have no
 * character that reliably exists.
 */
function icon(doc: Document, paths: string[]): Element {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '15')
  svg.setAttribute('height', '15')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

const MAGNIFIER = 'M11,6.5a4.5,4.5 0 1,1 -9,0a4.5,4.5 0 1,1 9,0'
const HANDLE = 'M9.9,9.9 L14,14'
const ICONS = {
  zoomIn: [MAGNIFIER, HANDLE, 'M6.5,4.3v4.4', 'M4.3,6.5h4.4'],
  zoomOut: [MAGNIFIER, HANDLE, 'M4.3,6.5h4.4'],
  centre: ['M13,8a5,5 0 1,1 -10,0a5,5 0 1,1 10,0', 'M8,1.2v1.6', 'M8,13.2v1.6', 'M1.2,8h1.6', 'M13.2,8h1.6'],
  fit: ['M2,6V2h4', 'M10,2h4v4', 'M14,10v4h-4', 'M6,14H2v-4'],
}

function railButton(doc: Document, paths: string[], tooltip: string, onClick: () => void): HTMLElement {
  const button = el(doc, 'button')
  button.style.cssText =
    'display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;' +
    'border:none;background:transparent;color:inherit;opacity:.55;cursor:pointer;border-radius:5px'
  button.setAttribute('title', tooltip)
  button.append(icon(doc, paths))
  button.addEventListener('mouseenter', () => (button.style.opacity = '1'))
  button.addEventListener('mouseleave', () => (button.style.opacity = '.55'))
  button.addEventListener('click', onClick)
  return button
}

function renderLegend(doc: Document, theme: GraphTheme, nodes: readonly GraphNode[]): HTMLElement {
  const legend = el(doc, 'div')
  legend.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;font-size:12px;padding:2px 0 8px'

  const row = (swatch: HTMLElement, label: string, count: number): HTMLElement => {
    const line = el(doc, 'div')
    line.style.cssText = 'display:flex;align-items:center;gap:6px'
    line.append(swatch, el(doc, 'span', `${label} (${count})`))
    return line
  }

  // Three series, so a legend is present rather than optional -- and the roles
  // are named, so identity never rests on colour alone.
  const entries: [GraphNode['role'], string, string][] = [
    ['seed', theme.seed, getString('graph-role-seed')],
    ['reference', theme.reference, getString('graph-role-reference')],
    ['citing', theme.citing, getString('graph-role-citing')],
  ]
  for (const [role, color, label] of entries) {
    const dot = el(doc, 'span')
    dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${color};flex:none`
    legend.append(row(dot, label, nodes.filter((node) => node.role === role).length))
  }

  // The fourth entry is a ring rather than a dot, because that is what the
  // mark is: the same swatch drawn hollow would claim membership is a fourth
  // role, and it sits across all three.
  const filed = nodes.filter((node) => node.itemID !== null).length
  if (filed > 0) {
    const ring = el(doc, 'span')
    ring.style.cssText =
      `width:11px;height:11px;border-radius:50%;border:1.6px solid ${theme.muted};` +
      'opacity:.85;background:transparent;flex:none'
    legend.append(row(ring, getString('graph-in-library'), filed))
  }
  return legend
}

const METRIC_LABEL: Record<AxisMetric, FluentMessageId> = {
  year: 'graph-metric-year',
  citations: 'graph-metric-citations',
  references: 'graph-metric-references',
}

/**
 * What "further along this axis" means, as a phrase.
 *
 * Tick numbers say where a mark is; this says what the direction means, which
 * is the thing a reader needs first and the thing a numbered axis leaves them
 * to work out. It sits outside the plot, so panning does not carry it away.
 */
const METRIC_DIRECTION: Record<AxisMetric, FluentMessageId> = {
  year: 'graph-direction-year',
  citations: 'graph-direction-citations',
  references: 'graph-direction-references',
}

function metricSelect(doc: Document, current: AxisMetric, onChange: (metric: AxisMetric) => void): HTMLElement {
  const select = el(doc, 'select') as HTMLSelectElement
  select.style.cssText =
    'font:inherit;font-size:11px;padding:1px 4px;border-radius:4px;' +
    'border:1px solid currentColor;background:transparent;color:inherit;opacity:.75'
  for (const metric of AXIS_METRICS) {
    const option = el(doc, 'option', getString(METRIC_LABEL[metric])) as HTMLOptionElement
    option.value = metric
    if (metric === current) option.selected = true
    select.append(option)
  }
  select.addEventListener('change', () => onChange(select.value as AxisMetric))
  return select
}

function readMetricPref(name: 'graphAxisX' | 'graphAxisY', fallback: AxisMetric): AxisMetric {
  const stored = String(getPref(name) ?? '')
  return (AXIS_METRICS as readonly string[]).includes(stored) ? (stored as AxisMetric) : fallback
}

/** Which axis a zoom acts on. */
type ZoomAxes = 'both' | 'x' | 'y'

/**
 * The modifier decides which axis the wheel moves.
 *
 * Shift for the horizontal and Alt for the vertical, which is the convention
 * charting tools have settled on; without a modifier both move together, so
 * the ordinary gesture is unchanged. Ctrl and Meta are left alone -- the
 * platform and Zotero already claim them.
 */
function axesFor(event: WheelEvent): ZoomAxes {
  if (event.shiftKey) return 'x'
  if (event.altKey) return 'y'
  return 'both'
}

/** How much one wheel notch zooms. Small: a trackpad sends a stream of them. */
const ZOOM_PER_PIXEL = 0.0022
/** Per event, so one flick of a coarse wheel cannot cross the whole range. */
const ZOOM_STEP_LIMIT = 0.22
const ZOOM_BUTTON_STEP = 1.3

const ROLE_LABEL: Record<GraphNode['role'], FluentMessageId> = {
  seed: 'graph-role-seed',
  reference: 'graph-role-reference',
  citing: 'graph-role-citing',
}

/**
 * The card a click on a mark opens.
 *
 * A mark is a dot with a truncated caption; the question a click asks is
 * "what is this", and the honest answer is the record, not the publisher's
 * website. Opening the DOI outright answered a question nobody had asked yet
 * and threw away the one piece of context -- role, counts, whether it is
 * already filed -- that the graph had and the browser would not.
 *
 * Everything shown is already in hand, so the card costs no request.
 */
function buildMarkCard(
  doc: Document,
  node: GraphNode,
  theme: GraphTheme,
  onClose: () => void,
): { card: HTMLElement; width: number } {
  const card = el(doc, 'div')
  card.style.cssText =
    'position:absolute;z-index:5;width:280px;box-sizing:border-box;padding:10px 12px 11px;' +
    `background:${theme.surface};color:inherit;border:1px solid ${theme.muted}59;border-radius:7px;` +
    'box-shadow:0 3px 14px rgba(0,0,0,.22);font-size:12px;line-height:1.4;' +
    'display:flex;flex-direction:column;gap:6px'
  // Clicks inside must not reach the plot, which closes the card.
  card.addEventListener('click', (event) => event.stopPropagation())

  const head = el(doc, 'div')
  head.style.cssText = 'display:flex;align-items:center;gap:6px'
  const dot = el(doc, 'span')
  const roleColor = node.role === 'seed' ? theme.seed : node.role === 'reference' ? theme.reference : theme.citing
  dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${roleColor};flex:none`
  const role = el(doc, 'span', getString(ROLE_LABEL[node.role]))
  role.style.cssText = 'opacity:.7'
  head.append(dot, role)

  if (node.itemID !== null) {
    const badge = el(doc, 'span')
    badge.style.cssText = 'display:flex;align-items:center;gap:5px;opacity:.7'
    const ring = el(doc, 'span')
    ring.style.cssText = `width:10px;height:10px;border-radius:50%;border:1.6px solid ${theme.muted};flex:none`
    badge.append(ring, el(doc, 'span', getString('graph-in-library')))
    head.append(badge)
  }

  const close = el(doc, 'button', '\u00d7')
  close.style.cssText =
    'margin-left:auto;border:none;background:transparent;color:inherit;opacity:.5;cursor:pointer;' +
    'font-size:15px;line-height:1;padding:0 2px'
  close.setAttribute('title', getString('graph-card-close'))
  close.addEventListener('click', onClose)
  head.append(close)

  // The full title, which is the point: the caption on the mark is cut at 34
  // characters and the tooltip vanishes the moment the pointer moves.
  const title = el(doc, 'div', node.title || getString('graph-card-title'))
  title.style.cssText = 'font-weight:600;font-size:12.5px;overflow-wrap:anywhere'

  const byline = [node.author, node.year === null ? null : String(node.year)].filter(Boolean).join(' \u00b7 ')
  const facts = [
    byline,
    node.citedByCount === null ? null : getString('graph-card-citations', { args: { count: node.citedByCount } }),
    node.referenceCount === null ? null : getString('graph-card-references', { args: { count: node.referenceCount } }),
  ].filter(Boolean)
  const detail = el(doc, 'div', facts.join(' \u00b7 '))
  detail.style.cssText = 'opacity:.75'

  card.append(head, title, detail)

  const actions = el(doc, 'div')
  actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding-top:2px'
  const action = (label: string, run: () => void): HTMLElement => {
    const button = el(doc, 'button', label)
    button.style.cssText =
      'font:inherit;font-size:11px;padding:3px 9px;border-radius:4px;cursor:pointer;' +
      'border:1px solid currentColor;background:transparent;color:inherit;opacity:.8'
    button.addEventListener('click', () => {
      run()
      onClose()
    })
    return button
  }

  if (node.itemID !== null) {
    actions.append(
      action(getString('graph-card-item'), () => {
        void Zotero.getActiveZoteroPane()?.selectItem(node.itemID as number)
      }),
    )
  }
  if (node.doi) {
    actions.append(
      action(getString('graph-card-doi'), () => {
        Zotero.launchURL(`https://doi.org/${node.doi ?? ''}`)
      }),
    )
  }
  if (actions.children.length > 0) card.append(actions)
  else {
    const none = el(doc, 'div', getString('graph-card-no-doi'))
    none.style.cssText = 'opacity:.6;font-size:11px'
    card.append(none)
  }

  return { card, width: 280 }
}

/**
 * The strip above the plot, which says what is under the pointer.
 *
 * It takes the place of the hint line rather than sitting beside it, so the
 * plot below never moves: a row that appears on hover would shift every mark
 * out from under the pointer that summoned it.
 */
function fillDetailStrip(doc: Document, strip: HTMLElement, node: GraphNode | null, theme: GraphTheme): void {
  if (!node) {
    strip.replaceChildren(doc.createTextNode(getString('graph-axes-note')))
    strip.style.opacity = '.7'
    return
  }
  strip.style.opacity = '1'

  const dot = el(doc, 'span')
  const roleColor = node.role === 'seed' ? theme.seed : node.role === 'reference' ? theme.reference : theme.citing
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${roleColor};flex:none`

  const title = el(doc, 'span', node.title || getString('graph-card-title'))
  title.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0'

  const facts = [
    getString(ROLE_LABEL[node.role]),
    node.author,
    node.year === null ? null : String(node.year),
    node.citedByCount === null ? null : getString('graph-card-citations', { args: { count: node.citedByCount } }),
    node.referenceCount === null ? null : getString('graph-card-references', { args: { count: node.referenceCount } }),
    node.itemID === null ? null : getString('graph-in-library'),
  ].filter(Boolean)
  const detail = el(doc, 'span', facts.join(' · '))
  detail.style.cssText = 'opacity:.7;white-space:nowrap;flex:none'

  strip.replaceChildren(dot, title, detail)
}

export function renderGraph(win: Window, container: Element, seed: GraphSeed, nodes: GraphNode[]): void {
  const doc = win.document
  const theme = themeFor(win)

  const root = el(doc, 'div')
  root.style.cssText =
    'display:flex;flex-direction:column;height:100%;width:100%;padding:14px 18px;box-sizing:border-box'

  const title = el(doc, 'div', seed.name)
  title.style.cssText = 'font-weight:600;font-size:14px;padding-bottom:2px'
  // One row, fixed height, doubling as the hint line when nothing is hovered.
  const strip = el(doc, 'div', getString('graph-axes-note'))
  strip.setAttribute('data-role', 'strip')
  strip.style.cssText =
    'font-size:12px;opacity:.7;padding-bottom:6px;display:flex;align-items:center;gap:7px;' +
    'white-space:nowrap;overflow:hidden;min-height:17px'
  root.append(title, strip)

  root.append(renderLegend(doc, theme, nodes))

  // Remembered, because which axis is right depends on the library rather than
  // on the moment: a field where everything sits between 40 and 90 citations
  // wants linear every time, one spanning four orders of magnitude wants log.
  let scale: ScaleKind = getPref('graphScale') === 'linear' ? 'linear' : 'log'
  let xMetric = readMetricPref('graphAxisX', 'year')
  let yMetric = readMetricPref('graphAxisY', 'citations')

  const toggle = el(doc, 'button', getString(scale === 'log' ? 'graph-scale-log' : 'graph-scale-linear'))
  toggle.style.cssText =
    'font:inherit;font-size:11px;padding:2px 8px;border-radius:4px;cursor:pointer;' +
    'border:1px solid currentColor;background:transparent;color:inherit;opacity:.75'
  toggle.setAttribute('title', getString('graph-scale-hint'))

  const controls = el(doc, 'div')
  controls.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;padding-bottom:6px;flex-wrap:wrap'

  const axisLabel = (text: string): HTMLElement => {
    const label = el(doc, 'span', text)
    label.style.cssText = 'opacity:.6;padding-left:6px'
    return label
  }

  // Declared before the selects, which call it; assigned after the plot exists.
  let draw = (): void => {}

  controls.append(
    axisLabel(getString('graph-axis-x')),
    metricSelect(doc, xMetric, (metric) => {
      xMetric = metric
      setPref('graphAxisX', metric)
      draw()
    }),
    axisLabel(getString('graph-axis-y')),
    metricSelect(doc, yMetric, (metric) => {
      yMetric = metric
      setPref('graphAxisY', metric)
      draw()
    }),
    axisLabel(''),
    toggle,
  )

  /**
   * Plot, axis captions and the button rail, on a grid.
   *
   * The captions sit in their own tracks rather than floating over the drawing:
   * the left gutter is already spoken for by the tick labels, and text laid on
   * top of them would collide at exactly the sizes where it matters.
   */
  const frame = el(doc, 'div')
  frame.style.cssText =
    'flex:1;min-height:0;display:grid;grid-template-columns:16px 1fr 30px;grid-template-rows:1fr 16px;gap:2px'

  const yCaption = el(doc, 'div')
  yCaption.style.cssText =
    'grid-column:1;grid-row:1;writing-mode:vertical-rl;transform:rotate(180deg);' +
    'display:flex;align-items:center;justify-content:center;font-size:11px;opacity:.55;white-space:nowrap'

  const xCaption = el(doc, 'div')
  xCaption.style.cssText =
    'grid-column:2;grid-row:2;display:flex;align-items:center;justify-content:center;' +
    'font-size:11px;opacity:.55;white-space:nowrap'

  const plot = el(doc, 'div')
  plot.style.cssText = 'grid-column:2;grid-row:1;position:relative;min-width:0;min-height:0'

  const rail = el(doc, 'div')
  rail.style.cssText =
    'grid-column:3;grid-row:1;display:flex;flex-direction:column;gap:2px;align-items:center;justify-content:center'

  frame.append(yCaption, plot, rail, xCaption)
  root.append(controls, frame)
  container.replaceChildren(root)

  /** The live view, replaced on every redraw. Null until the first one. */
  let view: {
    zoomBy: (factor: number, atX?: number, atY?: number) => void
    reset: () => void
    centre: (x: number, y: number) => void
  } | null = null
  let seedPoint: { x: number; y: number } | null = null

  rail.append(
    railButton(doc, ICONS.zoomIn, getString('graph-zoom-in'), () => view?.zoomBy(1 / ZOOM_BUTTON_STEP)),
    railButton(doc, ICONS.zoomOut, getString('graph-zoom-out'), () => view?.zoomBy(ZOOM_BUTTON_STEP)),
    railButton(doc, ICONS.centre, getString('graph-center-seed'), () => {
      if (seedPoint) view?.centre(seedPoint.x, seedPoint.y)
    }),
    railButton(doc, ICONS.fit, getString('graph-zoom-reset'), () => view?.reset()),
  )

  // Panning must not fire the click handler, so the two share this flag.
  let dragged = false

  /** The mark under the pointer, if any. Drives emphasis and the strip. */
  let hovered: string | null = null
  let byKey = new Map<string, GraphNode>()

  /** At most one card at a time, dismissed by Escape or a click off it. */
  let card: HTMLElement | null = null
  let escapeHandler: ((event: KeyboardEvent) => void) | null = null

  const closeCard = (): void => {
    card?.remove()
    card = null
    if (escapeHandler) doc.removeEventListener('keydown', escapeHandler)
    escapeHandler = null
  }

  const openCard = (node: GraphNode, event: MouseEvent): void => {
    closeCard()
    const built = buildMarkCard(doc, node, theme, closeCard)
    card = built.card

    // Placed against the plot, and kept inside it: a card that opens half
    // off the edge is worse than one that opens a little away from its mark.
    const bounds = plot.getBoundingClientRect()
    const left = Math.min(Math.max(event.clientX - bounds.left + 14, 4), Math.max(4, bounds.width - built.width - 4))
    card.style.left = `${left}px`
    // Measured after insertion, since the height depends on how the title wraps.
    card.style.top = '0px'
    plot.append(card)
    const top = event.clientY - bounds.top + 12
    card.style.top = `${Math.min(Math.max(top, 4), Math.max(4, bounds.height - card.offsetHeight - 4))}px`

    escapeHandler = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key === 'Escape') closeCard()
    }
    doc.addEventListener('keydown', escapeHandler)
  }

  /**
   * Wheel to zoom, drag to pan, by transforming the plot inside a fixed frame.
   *
   * The transform lands on the content group alone rather than on the viewBox,
   * which is what keeps the axis still. Moving the viewBox moved everything,
   * axis included, so zooming in far enough left the scale off-screen and the
   * marks unreadable in the other sense: big, and about nothing.
   *
   * Marks and labels do scale, which is the point -- at fifty works the plot is
   * denser than a fixed viewport can show, and zooming is how the crowded
   * middle becomes legible without dropping anything from it. The ticks scale
   * only in position, sliding along their own axis to stay on the value they
   * name.
   *
   * The wheel scales by how far it actually turned, not by a fixed step per
   * event. A trackpad sends a stream of two-pixel deltas, and a fixed step
   * turned a light two-finger swipe into four levels of zoom.
   */
  const installPanAndZoom = (svg: SVGSVGElement, layout: GraphLayout, width: number, height: number): typeof view => {
    const all = (selector: string): Element[] => {
      const found = svg.querySelectorAll(selector) as unknown as ArrayLike<Element>
      return Array.from(found)
    }
    const marks = all('[data-mark]')
    const edgeLines = all('[data-edge]')
    const labelSlots = all('[data-label]')
    const keyOf = (element: Element): string => element.getAttribute('data-key') ?? ''
    // Every edge has the seed at one end, so pointing at the seed lights all
    // of them: an edge is named after its other end, not after both.
    const seedKey = layout.nodes.find((node) => node.role === 'seed')?.key ?? null
    const yTicks = all('[data-axis="y"]')
    const xTicks = all('[data-axis="x"]')

    let kx = 1
    let ky = 1
    let tx = 0
    let ty = 0
    /** One update per frame, however many wheel events arrive between them. */
    let pending = 0

    /** Resting value, dimmed value, and the value for the mark being pointed at. */
    const emphasis = (key: string, rest: number, dim: number, lit: number): string =>
      hovered === null ? String(rest) : String(key === hovered ? lit : dim)

    const pair = (element: Element, name: string): [number, number] => {
      const [a, b] = (element.getAttribute(name) ?? '0,0').split(',')
      return [Number(a), Number(b)]
    }

    const apply = (): void => {
      const view = { kx, ky, tx, ty, width, height }

      for (const mark of marks) {
        const [x, y] = pair(mark, 'data-at')
        mark.setAttribute('transform', `translate(${(x * kx + tx).toFixed(2)},${(y * ky + ty).toFixed(2)})`)
      }

      for (const line of edgeLines) {
        const [fx, fy] = pair(line, 'data-from')
        const [tox, toy] = pair(line, 'data-to')
        const [startGap, endGap] = pair(line, 'data-gaps')
        const ends = edgeEnds({ x: fx, y: fy, radius: startGap - 2 }, { x: tox, y: toy, radius: endGap - 7 }, view)
        line.setAttribute('x1', ends.x1.toFixed(1))
        line.setAttribute('y1', ends.y1.toFixed(1))
        line.setAttribute('x2', ends.x2.toFixed(1))
        line.setAttribute('y2', ends.y2.toFixed(1))
        line.setAttribute('opacity', ends.hidden ? '0' : '0.4')
      }

      // Re-laid out, not merely repositioned: the marks keep their size while
      // zoom spreads them apart, so a name that could not fit at the fitted
      // view often can once there is room. Zooming reveals labels rather than
      // magnifying the ones already there, which is the point of zooming.
      // The hovered mark goes down first and carries its title.
      const placements = placeLabels(layout.nodes, view, hovered)
      labelSlots.forEach((slot, index) => {
        const placement = placements[index]
        if (!placement) {
          slot.setAttribute('opacity', '0')
          return
        }
        slot.textContent = placement.text
        slot.setAttribute('x', placement.x.toFixed(1))
        slot.setAttribute('y', placement.y.toFixed(1))
        slot.setAttribute('text-anchor', placement.anchor)
        slot.setAttribute('opacity', emphasis(placement.key, 0.9, 0.2, 1))
      })

      /**
       * Pointing at a mark pushes the rest back rather than lighting it up.
       *
       * Recede-the-others reads at a glance where brighten-the-one does not:
       * the plot is already full of saturated marks, and one more of them is
       * not a signal. Nothing is hidden -- dimmed marks stay visible, keep
       * their tooltip and remain clickable.
       */
      for (const mark of marks) mark.setAttribute('opacity', emphasis(keyOf(mark), 1, 0.22, 1))
      for (const line of edgeLines) {
        if (line.getAttribute('opacity') === '0') continue // an edge too short to draw
        const touched = hovered !== null && (keyOf(line) === hovered || hovered === seedKey)
        line.setAttribute('opacity', hovered === null ? '0.4' : touched ? '0.75' : '0.07')
      }

      // A tick whose value has moved out of the plot is hidden rather than
      // stacked against the edge, where it would name a place nobody can see.
      for (const tick of yTicks) {
        const home = Number(tick.getAttribute('data-pos'))
        const at = home * ky + ty
        tick.setAttribute('transform', `translate(0,${(at - home).toFixed(2)})`)
        tick.setAttribute('opacity', at > 8 && at < height - AXIS_GUTTER.bottom ? '1' : '0')
      }
      for (const tick of xTicks) {
        const home = Number(tick.getAttribute('data-pos'))
        const at = home * kx + tx
        tick.setAttribute('transform', `translate(${(at - home).toFixed(2)},0)`)
        tick.setAttribute('opacity', at > AXIS_GUTTER.left && at < width - 4 ? '1' : '0')
      }
    }

    /** Coalesced: a trackpad delivers wheel events faster than frames. */
    const schedule = (): void => {
      if (pending) return
      pending = win.requestAnimationFrame(() => {
        pending = 0
        apply()
      })
    }

    /**
     * factor > 1 zooms out; the anchor is a fraction of the viewport, 0 to 1.
     *
     * `axes` says which of them moves. Zooming one alone is not a distortion
     * here -- the marks keep their size at any zoom, so a horizontal stretch
     * pulls apart works published in the same few years and leaves everything
     * about their citation counts exactly where it was.
     */
    const zoomBy = (factor: number, atX = 0.5, atY = 0.5, axes: ZoomAxes = 'both'): void => {
      // Clamped: far enough in to pull a dense cluster apart, not so far out
      // that the marks pile back on top of each other.
      const clamp = (value: number): number => Math.min(15, Math.max(1 / 3, value))
      const anchorX = atX * width
      const anchorY = atY * height
      // Hold the point under the anchor still while the scale changes around it.
      if (axes !== 'y') {
        const next = clamp(kx / factor)
        tx = anchorX - (anchorX - tx) * (next / kx)
        kx = next
      }
      if (axes !== 'x') {
        const next = clamp(ky / factor)
        ty = anchorY - (anchorY - ty) * (next / ky)
        ky = next
      }
      schedule()
    }

    svg.addEventListener(
      'wheel',
      (event: WheelEvent) => {
        event.preventDefault()
        // deltaMode 1 counts lines and 2 counts pages; both must become pixels
        // before a pixel-based sensitivity means anything.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
        const raw = event.deltaY * unit * ZOOM_PER_PIXEL
        const clamped = Math.max(-ZOOM_STEP_LIMIT, Math.min(ZOOM_STEP_LIMIT, raw))
        const rect = svg.getBoundingClientRect()
        // Zoom about the pointer, so the mark under it stays put.
        zoomBy(
          Math.exp(clamped),
          (event.clientX - rect.left) / rect.width,
          (event.clientY - rect.top) / rect.height,
          axesFor(event),
        )
      },
      { passive: false },
    )

    svg.addEventListener('mouseover', (event: MouseEvent) => {
      const mark = (event.target as Element | null)?.closest?.('[data-mark]')
      const key = mark ? keyOf(mark) : null
      if (key === hovered) return
      hovered = key
      fillDetailStrip(doc, strip, key === null ? null : (byKey.get(key) ?? null), theme)
      schedule()
    })
    svg.addEventListener('mouseleave', () => {
      if (hovered === null) return
      hovered = null
      fillDetailStrip(doc, strip, null, theme)
      schedule()
    })

    let from: { x: number; y: number } | null = null
    svg.addEventListener('mousedown', (event: MouseEvent) => {
      from = { x: event.clientX, y: event.clientY }
      dragged = false
      svg.style.cursor = 'grabbing'
    })
    svg.addEventListener('mousemove', (event: MouseEvent) => {
      if (!from) return
      const rect = svg.getBoundingClientRect()
      // Screen pixels are not user units once the viewport is scaled to fit.
      tx += ((event.clientX - from.x) / rect.width) * width
      ty += ((event.clientY - from.y) / rect.height) * height
      if (Math.abs(event.clientX - from.x) > 3 || Math.abs(event.clientY - from.y) > 3) dragged = true
      from = { x: event.clientX, y: event.clientY }
      schedule()
    })
    const release = (): void => {
      from = null
      svg.style.cursor = 'grab'
    }
    svg.addEventListener('mouseup', release)
    svg.addEventListener('mouseleave', release)
    svg.style.cursor = 'grab'

    return {
      zoomBy,
      reset: () => {
        kx = 1
        ky = 1
        tx = 0
        ty = 0
        schedule()
      },
      centre: (x: number, y: number) => {
        tx = width / 2 - x * kx
        ty = height / 2 - y * ky
        schedule()
      },
    }
  }

  draw = (): void => {
    // The plot is about to be replaced; a card anchored to the old one would
    // be orphaned over the new, and a hover state would name a mark that is
    // no longer there.
    closeCard()
    hovered = null
    fillDetailStrip(doc, strip, null, theme)
    // Number.isFinite, not just Math.max: an unmeasured element yields
    // undefined, Math.max(320, undefined) is NaN, and a layout built on NaN
    // renders every mark at nowhere -- an empty plot with nothing to see and
    // nothing thrown.
    const span = (measured: number, floor: number): number => Math.max(floor, Number.isFinite(measured) ? measured : 0)
    const width = span(plot.clientWidth, 320)
    const height = span(plot.clientHeight, 220)
    const layout = buildGraphLayout(nodes, { width, height, padding: PADDING, scale, xMetric, yMetric })
    yCaption.textContent = getString(METRIC_DIRECTION[yMetric])
    xCaption.textContent = getString(METRIC_DIRECTION[xMetric])
    // Log or linear is a question about counts. With years on both axes there
    // is nothing for it to act on, and an control that does nothing when
    // pressed is worse than one that says it cannot.
    const countAxis = xMetric !== 'year' || yMetric !== 'year'
    ;(toggle as HTMLButtonElement).disabled = !countAxis
    toggle.style.opacity = countAxis ? '.75' : '.3'
    if (!layout) {
      view = null
      seedPoint = null
      plot.replaceChildren(el(doc, 'div', getString('graph-no-values')))
      return
    }

    // Parsed and imported, never innerHTML: Zotero's sanitizer strips xmlns and
    // the result silently stops being SVG.
    const text = {
      x: getString(METRIC_LABEL[xMetric]),
      y: getString(METRIC_LABEL[yMetric]),
      inLibrary: getString('graph-in-library'),
    }
    const parsed = new DOMParser().parseFromString(renderGraphSvg(layout, theme, text), 'image/svg+xml')
    const svg = parsed.documentElement
    if (!svg || svg.nodeName === 'parsererror') return
    const imported = doc.importNode(svg, true)

    byKey = new Map(layout.nodes.map((node) => [node.key, node]))
    imported.addEventListener('click', (event) => {
      // A drag that ends over a mark is panning, not a click on it.
      if (dragged) return
      const target = (event.target as Element | null)?.closest?.('circle')
      // Anywhere else in the plot dismisses whatever is open.
      if (!target) {
        closeCard()
        return
      }
      const node = byKey.get(target.getAttribute('data-key') ?? '')
      if (node) openCard(node, event as MouseEvent)
    })

    view = installPanAndZoom(imported as unknown as SVGSVGElement, layout, width, height)
    const seedNode = layout.nodes.find((node) => node.role === 'seed')
    seedPoint = seedNode ? { x: seedNode.x, y: seedNode.y } : null

    plot.replaceChildren(imported)
    if (layout.dropped > 0) {
      const note = el(doc, 'div', getString('graph-dropped-no-value', { args: { count: layout.dropped } }))
      note.style.cssText = 'position:absolute;right:0;bottom:0;font-size:11px;opacity:.6'
      plot.append(note)
    }
  }

  toggle.addEventListener('click', () => {
    scale = scale === 'log' ? 'linear' : 'log'
    setPref('graphScale', scale)
    toggle.textContent = getString(scale === 'log' ? 'graph-scale-log' : 'graph-scale-linear')
    draw()
  })

  draw()
  // The plot is sized by flex; redraw when the window changes rather than
  // stretching a fixed viewBox.
  win.addEventListener('resize', draw)
}

/** The items a seed stands for. Collections and libraries are seeded by content. */
function itemsForSeed(seed: GraphSeed): Zotero.Item[] {
  switch (seed.kind) {
    case 'items':
      // One seed, always. The graph is drawn from a single work's point of view
      // -- its references behind it, what cites it ahead -- and merging several
      // perspectives into one plot answers no question anyone asked.
      return seed.itemIDs
        .slice(0, 1)
        .map((id) => Zotero.Items.get(id))
        .filter((item): item is Zotero.Item => Boolean(item))
    case 'collection': {
      const collection = Zotero.Collections.get(seed.collectionID)
      // One seed for now: a graph of every item in a collection is a different
      // shape of question and a much larger set of requests.
      return collection
        ? collection
            .getChildItems()
            .filter((item) => item.isRegularItem())
            .slice(0, 1)
        : []
    }
    case 'library':
      return []
  }
}
