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
  chainFrom,
  edgeEnds,
  LINE_HEIGHT,
  placeLabels,
  renderGraphSvg,
} from './graphModel.core.ts'
import { getDoiIndex, normalizeDoi } from './libraryIndex'
import { fetchCitingWorks, fetchGraphLinks, fetchReferences, fetchScholarlyRecord } from './openAlexEnrichment'
import { s2DetailsCacheKey } from './s2Details'

import type { ItemIdentifier } from './citationTypes.ts'
import type { AxisMetric, Chain, GraphLayout, GraphNode, GraphTheme, ScaleKind } from './graphModel.core.ts'
import type { ResolvedReference } from './openAlexClient.core.ts'
import type { GraphLink } from './openAlexEnrichment'
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
const TAB_ICON_TYPE = 'orbit-graph'

const TAB_ICON_STYLE_ID = 'orbit-tab-icon-style'

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
      return `orbit-graph-collection-${seed.collectionID}`
    case 'items':
      return `orbit-graph-items-${seed.itemIDs.slice().sort().join('-')}`
    case 'library':
      return `orbit-graph-library-${seed.libraryID}`
    case 'work':
      return `orbit-graph-work-${seed.doi.toLowerCase()}`
  }
}

export type GraphSeed =
  | { kind: 'collection'; collectionID: number; name: string }
  | { kind: 'items'; itemIDs: number[]; name: string }
  | { kind: 'library'; libraryID: number; name: string }
  /**
   * A work identified only by its DOI, filed or not.
   *
   * The graph puts a paper's surroundings on screen, and the reader wants to
   * step into one of them and look around from there. Requiring it to be in
   * the library first would refuse exactly the case the graph exists to
   * surface: the work you do not have yet.
   */
  | { kind: 'work'; doi: string; name: string; libraryID: number }

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
    type: 'orbit-graph',
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
  Zotero.debug(`Orbit: graph tab opened for ${seed.kind} "${seed.name}"`)

  /**
   * Fetch and draw. Called again by the tab's reload button, with force set.
   *
   * Everything the graph shows is cached -- which is what makes it quick, and
   * what makes it wrong once a paper has picked up citations or the library
   * has gained the work. Reloading is the only way back to the sources, so it
   * is a button rather than something to discover by closing the tab.
   */
  const load = async (force: boolean): Promise<void> => {
    try {
      renderPlaceholder(win.document, container, seed, getString('graph-loading'))
      const start = startingPoint(seed)
      const nodes = start ? await collectNodes(start.identifiers, start.libraryID, start.title, force) : []
      if (nodes.length === 0) {
        renderPlaceholder(win.document, container, seed, getString('graph-empty'))
        return
      }
      // One more request, after the nodes are known and before the first
      // paint: the placeholder is already up, and a graph that appears and
      // then sprouts lines a second later reads as a glitch.
      let links: GraphLink[] = []
      try {
        links = await fetchGraphLinks(nodes, { force })
      } catch (err) {
        // Paths are an addition. Losing them must not cost the graph.
        Zotero.debug(`Orbit: citation paths unavailable: ${String(err)}`)
      }
      renderGraph(win, container, seed, nodes, links, () => void load(true))
      Zotero.debug(`Orbit: graph rendered with ${nodes.length} nodes and ${links.length} paths`)
    } catch (err) {
      Zotero.debug(`Orbit: graph failed: ${String(err)}`)
      renderPlaceholder(win.document, container, seed, String(err))
    }
  }

  void load(false)
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
async function collectNodes(
  identifiers: ItemIdentifier[],
  libraryID: number,
  fallbackTitle: string,
  force: boolean,
): Promise<GraphNode[]> {
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
  const inLibrary = await getDoiIndex(libraryID)

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
    record.title ?? fallbackTitle,
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
  // An arrow round three quarters of a circle, with a head where it stops.
  reload: ['M13.2,8a5.2,5.2 0 1,1 -1.9,-4', 'M13.4,2.6v3.6h-3.6'],
  zoomIn: [MAGNIFIER, HANDLE, 'M6.5,4.3v4.4', 'M4.3,6.5h4.4'],
  zoomOut: [MAGNIFIER, HANDLE, 'M4.3,6.5h4.4'],
  centre: ['M13,8a5,5 0 1,1 -10,0a5,5 0 1,1 10,0', 'M8,1.2v1.6', 'M8,13.2v1.6', 'M1.2,8h1.6', 'M13.2,8h1.6'],
  fit: ['M2,6V2h4', 'M10,2h4v4', 'M14,10v4h-4', 'M6,14H2v-4'],
}

function railButton(doc: Document, paths: string[], tooltip: string, onClick: () => void, name?: string): HTMLElement {
  const button = el(doc, 'button')
  button.style.cssText =
    'display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;' +
    'border:none;background:transparent;color:inherit;opacity:.55;cursor:pointer;border-radius:5px'
  button.setAttribute('title', tooltip)
  if (name) button.setAttribute('data-control', name)
  button.append(icon(doc, paths))
  button.addEventListener('mouseenter', () => (button.style.opacity = '1'))
  button.addEventListener('mouseleave', () => (button.style.opacity = '.55'))
  button.addEventListener('click', onClick)
  return button
}

/**
 * Whether library membership narrows the view, and which way.
 *
 * Three states rather than two, because there are two questions and hiding
 * one group answers only one of them: "which of these do I already have" and
 * "which am I missing" are asked as often as each other, and a plain on/off
 * can serve one at a time.
 */
export type LibraryFilter = 'all' | 'only' | 'missing'

export const LIBRARY_FILTERS: readonly LibraryFilter[] = ['all', 'only', 'missing']

/** The three switches the legend offers. */
export type FilterKey = 'reference' | 'citing' | 'library'

/** Which groups are drawn. The seed is not a group and is always drawn. */
export interface GraphFilters {
  reference: boolean
  citing: boolean
  library: LibraryFilter
}

export function keepNode(node: GraphNode, filters: GraphFilters): boolean {
  // The seed is what the graph is of. A view of a work without the work is
  // not one anyone asked for.
  if (node.role === 'seed') return true
  if (node.role === 'reference' && !filters.reference) return false
  if (node.role === 'citing' && !filters.citing) return false
  if (filters.library === 'only' && node.itemID === null) return false
  if (filters.library === 'missing' && node.itemID !== null) return false
  return true
}

/**
 * The legend, which is also the filter.
 *
 * Two rows would say the same thing twice: the legend already names each group
 * and counts it, and a separate row of switches beside it would repeat both
 * and then disagree with it the moment one was flipped. Clicking an entry
 * takes that group out; the count stays the group's size, not what survives.
 */
function renderLegend(
  doc: Document,
  theme: GraphTheme,
  nodes: readonly GraphNode[],
  filters: GraphFilters,
  onToggle: (which: keyof GraphFilters) => void,
): HTMLElement {
  const legend = el(doc, 'div')
  legend.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;font-size:12px;padding:2px 0 8px'

  const row = (swatch: HTMLElement, label: string, count: number, which: FilterKey | null): HTMLElement => {
    const line = el(doc, which === null ? 'div' : 'button')
    // "Resting" rather than "on": the library switch has three states and only
    // the first of them leaves the view unnarrowed.
    const resting = which === null || (which === 'library' ? filters.library === 'all' : filters[which])
    line.style.cssText =
      'display:flex;align-items:center;gap:6px;font:inherit;font-size:12px;color:inherit;' +
      'border:1px solid transparent;border-radius:11px;padding:1px 8px 1px 6px;background:transparent;' +
      (which === null ? '' : 'cursor:pointer;') +
      // A narrowed view keeps full contrast on the library switch, which is
      // still showing works; the two group switches fade, because theirs are
      // gone.
      (resting ? '' : 'border-color:currentColor;') +
      (resting || which === 'library' ? '' : 'opacity:.4;')
    if (which !== null) {
      line.setAttribute('data-filter', which)
      line.setAttribute('data-state', which === 'library' ? filters.library : String(resting))
      line.setAttribute('aria-pressed', String(!resting))
      line.addEventListener('click', () => onToggle(which))
    }
    line.append(swatch, el(doc, 'span', `${label} (${count})`))
    return line
  }

  // Three series, so a legend is present rather than optional -- and the roles
  // are named, so identity never rests on colour alone.
  // Plural here, singular in the card and the strip: the legend counts works,
  // those two label one.
  const entries: [GraphNode['role'], string, string][] = [
    ['seed', theme.seed, getString('graph-legend-seed')],
    ['reference', theme.reference, getString('graph-legend-reference')],
    ['citing', theme.citing, getString('graph-legend-citing')],
  ]
  for (const [role, color, label] of entries) {
    const dot = el(doc, 'span')
    dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${color};flex:none`
    const which: FilterKey | null = role === 'seed' ? null : role === 'reference' ? 'reference' : 'citing'
    legend.append(row(dot, label, nodes.filter((node) => node.role === role).length, which))
  }

  // The fourth entry is a ring rather than a dot, because that is what the
  // mark is: the same swatch drawn hollow would claim membership is a fourth
  // role, and it sits across all three.
  const filed = nodes.filter((node) => node.itemID !== null).length
  if (filed > 0) {
    // The ring fills in when the view is narrowed to what is filed and stays
    // hollow when it is narrowed to what is not, so the swatch says what the
    // label says.
    const ring = el(doc, 'span')
    ring.style.cssText =
      `width:11px;height:11px;border-radius:50%;border:1.6px solid ${theme.muted};flex:none;opacity:.85;` +
      (filters.library === 'only' ? `background:${theme.muted}` : 'background:transparent')
    const label =
      filters.library === 'only'
        ? getString('graph-library-only')
        : filters.library === 'missing'
          ? getString('graph-library-missing')
          : getString('graph-in-library')
    // The count follows the label. Asking what is missing and being told how
    // many you have would answer the other question.
    const count = filters.library === 'missing' ? nodes.length - filed : filed
    legend.append(row(ring, label, count, 'library'))
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

/** How far the highlight can reach. Past three it stops discriminating. */
export const MAX_HOPS = 3

export function readHopsPref(): number {
  const stored = Number(getPref('graphHighlightHops'))
  return Number.isFinite(stored) ? Math.min(MAX_HOPS, Math.max(1, Math.round(stored))) : 1
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
/**
 * Semantic Scholar's own page for a work, reached by DOI.
 *
 * Through the api host, which redirects to the canonical paper page. The
 * obvious `semanticscholar.org/paper/<doi>` does not: it answers, with a page
 * that is not the paper. Checked, both of them, because a link that looks
 * right and is not is worse than no link.
 */
export function semanticScholarUrl(doi: string): string {
  return `https://api.semanticscholar.org/${doi}`
}

function buildMarkCard(
  doc: Document,
  node: GraphNode,
  theme: GraphTheme,
  onClose: () => void,
  onGraph: (node: GraphNode) => void,
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
      // Ahead of the DOI: stepping into a work's own surroundings is what the
      // reader is doing here, and it does not need the work to be filed.
      action(getString('graph-card-graph'), () => onGraph(node)),
      action(getString('graph-card-source'), () => {
        Zotero.launchURL(semanticScholarUrl(node.doi ?? ''))
      }),
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

/**
 * The line under the wrapped title of the mark being pointed at.
 *
 * Everything the card would say except the title itself, which is already the
 * lines above it.
 */
function describeNode(node: GraphNode): string[] {
  const parts = [
    getString(ROLE_LABEL[node.role]),
    node.author,
    node.year === null ? null : String(node.year),
    node.citedByCount === null ? null : getString('graph-card-citations', { args: { count: node.citedByCount } }),
    node.referenceCount === null ? null : getString('graph-card-references', { args: { count: node.referenceCount } }),
    node.itemID === null ? null : getString('graph-in-library'),
  ].filter(Boolean)
  return [parts.join(' · ')]
}

export function renderGraph(
  win: Window,
  container: Element,
  seed: GraphSeed,
  nodes: GraphNode[],
  links: GraphLink[] = [],
  onReload?: () => void,
): void {
  const doc = win.document
  const theme = themeFor(win)

  /**
   * Which library a graph opened from here checks membership against.
   *
   * The one this graph used, so a work's ring means the same thing on both.
   * Falls back to the user library, which is where a graph opened from a menu
   * with nothing selected would have looked anyway.
   */
  const seedLibraryID =
    seed.kind === 'work' ? seed.libraryID : (itemsForSeed(seed)[0]?.libraryID ?? Zotero.Libraries.userLibraryID)

  /** How far the highlight reaches. Remembered; nothing is fetched for it. */
  let hops = readHopsPref()

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

  // Declared before the selects, which call it; assigned after the plot exists.
  let draw = (): void => {}

  const stored = String(getPref('graphLibraryFilter') ?? '')
  const filters: GraphFilters = {
    reference: getPref('graphShowReferences') !== false,
    citing: getPref('graphShowCitations') !== false,
    library: (LIBRARY_FILTERS as readonly string[]).includes(stored) ? (stored as LibraryFilter) : 'all',
  }

  let legend = el(doc, 'div')
  const paintLegend = (): void => {
    const next = renderLegend(doc, theme, nodes, filters, (which) => {
      if (which === 'library') {
        // all -> only -> missing -> all. One control, both questions.
        filters.library = LIBRARY_FILTERS[(LIBRARY_FILTERS.indexOf(filters.library) + 1) % LIBRARY_FILTERS.length]
        setPref('graphLibraryFilter', filters.library)
      } else {
        filters[which] = !filters[which]
        setPref(which === 'reference' ? 'graphShowReferences' : 'graphShowCitations', filters[which])
      }
      paintLegend()
      draw()
    })
    legend.replaceWith(next)
    legend = next
  }
  root.append(legend)
  // replaceWith needs it in the tree first, so the first paint comes after the
  // append rather than before it.
  paintLegend()

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

  const hopsSelect = el(doc, 'select') as HTMLSelectElement
  hopsSelect.style.cssText =
    'font:inherit;font-size:11px;padding:1px 4px;border-radius:4px;' +
    'border:1px solid currentColor;background:transparent;color:inherit;opacity:.75'
  hopsSelect.setAttribute('title', getString('graph-highlight-hint'))
  hopsSelect.setAttribute('data-control', 'hops')
  for (let level = 1; level <= MAX_HOPS; level++) {
    const option = el(doc, 'option', getString('graph-highlight-hops', { args: { hops: level } })) as HTMLOptionElement
    option.value = String(level)
    if (level === hops) option.selected = true
    hopsSelect.append(option)
  }
  hopsSelect.addEventListener('change', () => {
    hops = Number(hopsSelect.value)
    setPref('graphHighlightHops', hops)
    // Nothing is fetched and nothing moves: the same works, lit differently.
    showEmphasis()
  })

  // Top row, not the rail: the rail is where you move the plot, and this
  // replaces it.
  const reload = onReload
    ? railButton(doc, ICONS.reload, getString('graph-reload'), onReload, 'reload')
    : el(doc, 'span')

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
    axisLabel(getString('graph-highlight')),
    hopsSelect,
    reload,
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
    repaint: () => void
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

  /**
   * What the emphasis is about: the mark held by a click, or failing that the
   * one under the pointer.
   *
   * A click pins it so the reader can move the mouse to the card and read it,
   * or study the lit paths, without the plot rearranging itself the moment
   * they set off. The pin is the card: they are opened and dropped together,
   * so there is one thing to dismiss rather than two.
   */
  let pointedAt: string | null = null
  let pinned: string | null = null
  const emphasised = (): string | null => pinned ?? pointedAt
  /** Assigned once the plot exists; the strip and the repaint live there. */
  let showEmphasis = (): void => {}

  let byKey = new Map<string, GraphNode>()

  /** At most one card at a time, dismissed by Escape or a click off it. */
  let card: HTMLElement | null = null
  let escapeHandler: ((event: KeyboardEvent) => void) | null = null

  const closeCard = (): void => {
    // The pin and the card are one thing to the reader, so they go together.
    const wasPinned = pinned !== null
    pinned = null
    card?.remove()
    card = null
    if (wasPinned) showEmphasis()
    if (escapeHandler) doc.removeEventListener('keydown', escapeHandler)
    escapeHandler = null
  }

  const openCard = (node: GraphNode, event: MouseEvent): void => {
    closeCard()
    const built = buildMarkCard(doc, node, theme, closeCard, (from) => {
      // A tab of its own, keyed on the DOI, so the graph it came from stays
      // open behind it.
      openGraphTab({
        kind: 'work',
        doi: from.doi ?? '',
        name: from.title || getString('graph-card-title'),
        libraryID: seedLibraryID,
      })
    })
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

    /**
     * The chain through the mark under the pointer, worked out once per hover
     * rather than once per frame: zoom repaints sixty times a second and the
     * answer does not change while it does.
     */
    let chainFor: string | null = null
    let chainHops = hops
    let chain: Chain | null = null
    const currentChain = (): Chain | null => {
      const at = emphasised()
      if (at !== chainFor || hops !== chainHops) {
        chainFor = at
        chainHops = hops
        chain = at === null ? null : chainFrom(layout.links, at, hops)
      }
      return chain
    }

    /**
     * Three levels, not two.
     *
     * The mark being pointed at, then the works on its line of descent, then
     * everything else. Two levels would push the chain back with the rest --
     * and the chain is the thing the paths were drawn to show.
     */
    const emphasis = (key: string, rest: number, dim: number, lit: number): string => {
      if (emphasised() === null) return String(rest)
      if (key === emphasised()) return String(lit)
      return String(currentChain()?.keys.has(key) ? dim + (lit - dim) * 0.55 : dim)
    }

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
        // Recorded rather than applied: the emphasis pass below decides what
        // is visible, and it must not resurrect a line with no room to draw.
        line.setAttribute('hidden-short', ends.hidden ? '1' : '0')
        if (ends.hidden) line.setAttribute('opacity', '0')
      }

      // Re-laid out, not merely repositioned: the marks keep their size while
      // zoom spreads them apart, so a name that could not fit at the fitted
      // view often can once there is room. Zooming reveals labels rather than
      // magnifying the ones already there, which is the point of zooming.
      // The emphasised mark goes down first and carries its title.
      const placements = placeLabels(layout.nodes, view, emphasised(), describeNode)
      labelSlots.forEach((slot, index) => {
        const placement = placements[index]
        if (!placement) {
          slot.setAttribute('opacity', '0')
          return
        }
        const x = placement.x.toFixed(1)
        // One line is the overwhelming case and costs a single assignment;
        // only the pointed-at mark is ever wrapped, and only that one pays for
        // the tspans it needs.
        if (placement.lines.length === 1) slot.textContent = placement.lines[0]
        else {
          slot.textContent = ''
          placement.lines.forEach((line, row) => {
            const tspan = doc.createElementNS(SVG_NS, 'tspan')
            tspan.setAttribute('x', x)
            if (row > 0) tspan.setAttribute('dy', String(LINE_HEIGHT))
            tspan.textContent = line
            slot.append(tspan)
          })
        }
        slot.setAttribute('x', x)
        slot.setAttribute('y', placement.y.toFixed(1))
        slot.setAttribute('text-anchor', placement.anchor)
        // Names of unrelated works go out rather than dim.
        //
        // A dimmed name is still a name, and twenty of them around the one
        // being read is exactly the crowding the emphasis exists to clear. The
        // marks stay -- they are the shape of the field and dimming is enough
        // for them -- but their captions are what makes it unreadable.
        const related = placement.key === emphasised() || (currentChain()?.keys.has(placement.key) ?? false)
        slot.setAttribute(
          'opacity',
          emphasised() === null ? '0.9' : related ? emphasis(placement.key, 0.9, 0.55, 1) : '0',
        )
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
      /** Lit edges thicken and take the larger head; the rest recede. */
      const setEdge = (line: Element, lit: boolean, resting: number, dim: number, base: number): void => {
        const at = emphasised()
        line.setAttribute('opacity', at === null ? String(resting) : lit ? '0.85' : String(dim))
        line.setAttribute('stroke-width', at !== null && lit ? String(base * 2) : String(base))
        const arrow = line.getAttribute(at !== null && lit ? 'data-arrow-lit' : 'data-arrow')
        if (arrow) line.setAttribute('marker-end', arrow)
      }

      for (const line of edgeLines) {
        if (line.getAttribute('hidden-short') === '1') continue // too short to draw
        const linkIndex = line.getAttribute('data-link')
        if (linkIndex !== null) {
          // A path between two surrounding works, shown while the mark being
          // pointed at is anywhere on its chain. All of them at once is a
          // thicket; only the ones touching it is half the story.
          const onChain = currentChain()?.edges.has(Number(linkIndex)) ?? false
          setEdge(line, onChain, 0, 0, 1)
          if (!onChain) line.setAttribute('opacity', '0')
          continue
        }
        /**
         * The edge to the seed is lit for the whole neighbourhood, not just
         * for the mark under the pointer.
         *
         * Everything on the plot is there because of its relation to this
         * work, and lighting one work's link to it while its neighbours' links
         * stay faint shows a fragment of the structure being asked about. The
         * seed itself lights all of them, since all of them are its own.
         */
        const at = emphasised()
        const related = at !== null && (at === seedKey || (currentChain()?.keys.has(keyOf(line)) ?? false))
        setEdge(line, related, 0.4, 0.06, 1.2)
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

    /**
     * Coalesced: a trackpad delivers wheel events faster than frames.
     *
     * The flag is raised before the frame is asked for, not from its handle.
     * Taking the handle means the callback can clear a flag that has not been
     * set yet, leaving it raised forever and every later update dropped -- a
     * browser's requestAnimationFrame returns first so it never happened, but
     * the guard should not rest on that.
     */
    const schedule = (): void => {
      if (pending) return
      pending = 1
      win.requestAnimationFrame(() => {
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
      if (key === pointedAt) return
      pointedAt = key
      // A pinned mark owns the emphasis; the pointer crossing others must not
      // quietly take it back.
      if (pinned !== null) return
      showEmphasis()
    })
    svg.addEventListener('mouseleave', () => {
      if (pointedAt === null) return
      pointedAt = null
      if (pinned !== null) return
      showEmphasis()
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
      repaint: schedule,
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
    // be orphaned over the new, and an emphasis would name a mark that is no
    // longer there.
    closeCard()
    pointedAt = null
    fillDetailStrip(doc, strip, null, theme)
    // Number.isFinite, not just Math.max: an unmeasured element yields
    // undefined, Math.max(320, undefined) is NaN, and a layout built on NaN
    // renders every mark at nowhere -- an empty plot with nothing to see and
    // nothing thrown.
    const span = (measured: number, floor: number): number => Math.max(floor, Number.isFinite(measured) ? measured : 0)
    const width = span(plot.clientWidth, 320)
    const height = span(plot.clientHeight, 220)
    const shown = nodes.filter((node) => keepNode(node, filters))
    const layout = buildGraphLayout(shown, { width, height, padding: PADDING, scale, xMetric, yMetric, links })
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
    const text = { x: getString(METRIC_LABEL[xMetric]), y: getString(METRIC_LABEL[yMetric]) }
    // The tab's own id namespaces the SVG defs, so two open graphs cannot
    // reach into each other's clip path.
    const uid = container.id || 'orbit-graph'
    const parsed = new DOMParser().parseFromString(renderGraphSvg(layout, theme, text, uid), 'image/svg+xml')
    const svg = parsed.documentElement
    if (!svg || svg.nodeName === 'parsererror') return
    const imported = doc.importNode(svg, true)

    byKey = new Map(layout.nodes.map((node) => [node.key, node]))
    imported.addEventListener('click', (event) => {
      // A drag that ends over a mark is panning, not a click on it.
      if (dragged) return
      // The group, not the circle: a mark is drawn as up to three circles --
      // the seed's halo, the library collar, the mark itself -- and only the
      // innermost carries the key. Aiming at the collar's ring, which sits
      // outside the mark, used to hit a circle that answered to nothing.
      const target = (event.target as Element | null)?.closest?.('[data-mark]')
      // Anywhere else in the plot lets go of whatever is held.
      if (!target) {
        closeCard()
        return
      }
      const key = target.getAttribute('data-key') ?? ''
      const node = byKey.get(key)
      if (!node) return
      // After openCard, not before: it starts by closing whatever is open,
      // and closing lets go of the pin.
      openCard(node, event as MouseEvent)
      pinned = key
      showEmphasis()
    })

    showEmphasis = (): void => {
      const at = emphasised()
      fillDetailStrip(doc, strip, at === null ? null : (byKey.get(at) ?? null), theme)
      view?.repaint()
    }

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

/**
 * What to look up, and which library to check membership against.
 *
 * A seed is either an item in the library, whose identifiers Zotero already
 * holds, or a bare DOI from a mark on another graph. Both end up as the same
 * list, so nothing downstream has to know which it was.
 */
function startingPoint(seed: GraphSeed): { identifiers: ItemIdentifier[]; libraryID: number; title: string } | null {
  if (seed.kind === 'work') {
    return {
      identifiers: [{ type: 'doi', id: seed.doi, source: 'Graph' }],
      libraryID: seed.libraryID,
      title: seed.name,
    }
  }
  const item = itemsForSeed(seed)[0]
  if (!item) return null
  return {
    identifiers: Helpers.getAllItemIdentifiers(item),
    libraryID: item.libraryID,
    title: item.getField('title'),
  }
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
    case 'work':
      // Handled by startingPoint, which does not need a Zotero item.
      return []
  }
}
