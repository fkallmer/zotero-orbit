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

import { Helpers } from './citationTally'
import { buildGraphLayout, renderGraphSvg } from './graphModel.core.ts'
import { getDoiIndex, normalizeDoi } from './libraryIndex'
import { fetchCitingWorks, fetchReferences, fetchScholarlyRecord } from './openAlexEnrichment'

import type { GraphNode, GraphTheme, ScaleKind } from './graphModel.core.ts'

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
      const items = itemsForSeed(seed)
      const nodes: GraphNode[] = []
      for (const item of items) nodes.push(...(await collectNodes(item, false)))
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

  const [references, citing, index] = await Promise.all([
    fetchReferences(record, { force }),
    fetchCitingWorks(record, { force }),
    getDoiIndex(item.libraryID),
  ])

  const seen = new Set<string>()
  const nodes: GraphNode[] = []
  const push = (
    title: string | null,
    doi: string | null,
    year: number | null,
    citedByCount: number | null,
    role: GraphNode['role'],
  ): void => {
    const key = (doi ?? title ?? '').toLowerCase()
    // A work can be both cited and citing across a wider graph; first role wins
    // so the seed and its references keep their identity.
    if (key === '' || seen.has(key)) return
    seen.add(key)
    nodes.push({
      key,
      title: title ?? doi ?? '',
      year,
      citedByCount,
      role,
      doi,
      itemID: doi ? (index.get(normalizeDoi(doi)) ?? null) : null,
    })
  }

  push(
    record.title ?? item.getField('title'),
    identifiers.find((id) => id.type === 'doi')?.id ?? null,
    record.publicationYear,
    record.citedByCount,
    'seed',
  )
  for (const ref of references) push(ref.title, ref.doi, ref.year, ref.citedByCount, 'reference')
  for (const cite of citing) push(cite.title, cite.doi, cite.year, cite.citedByCount, 'citing')
  return nodes
}

const PADDING = { top: 18, right: 24, bottom: 26, left: 44 }

function renderLegend(doc: Document, theme: GraphTheme, counts: Record<GraphNode['role'], number>): HTMLElement {
  const legend = el(doc, 'div')
  legend.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;font-size:12px;padding:2px 0 8px'
  // Three series, so a legend is present rather than optional -- and the roles
  // are named, so identity never rests on colour alone.
  const entries: [GraphNode['role'], string, string][] = [
    ['seed', theme.seed, getString('graph-role-seed')],
    ['reference', theme.reference, getString('graph-role-reference')],
    ['citing', theme.citing, getString('graph-role-citing')],
  ]
  for (const [role, color, label] of entries) {
    const row = el(doc, 'div')
    row.style.cssText = 'display:flex;align-items:center;gap:6px'
    const dot = el(doc, 'span')
    dot.style.cssText = `width:9px;height:9px;border-radius:50%;background:${color};flex:none`
    row.append(dot, el(doc, 'span', `${label} (${counts[role]})`))
    legend.append(row)
  }
  return legend
}

function renderGraph(win: Window, container: Element, seed: GraphSeed, nodes: GraphNode[]): void {
  const doc = win.document
  const theme = themeFor(win)

  const root = el(doc, 'div')
  root.style.cssText =
    'display:flex;flex-direction:column;height:100%;width:100%;padding:14px 18px;box-sizing:border-box'

  const title = el(doc, 'div', seed.name)
  title.style.cssText = 'font-weight:600;font-size:14px;padding-bottom:2px'
  const axes = el(doc, 'div', getString('graph-axes-note'))
  axes.style.cssText = 'font-size:12px;opacity:.7;padding-bottom:6px'
  root.append(title, axes)

  const counts = { seed: 0, reference: 0, citing: 0 }
  for (const node of nodes) counts[node.role]++
  root.append(renderLegend(doc, theme, counts))

  const plot = el(doc, 'div')
  plot.style.cssText = 'flex:1;min-height:0;position:relative'

  // Remembered, because which axis is right depends on the library rather than
  // on the moment: a field where everything sits between 40 and 90 citations
  // wants linear every time, one spanning four orders of magnitude wants log.
  let scale: ScaleKind = getPref('graphScale') === 'linear' ? 'linear' : 'log'

  const toggle = el(doc, 'button', getString(scale === 'log' ? 'graph-scale-log' : 'graph-scale-linear'))
  toggle.style.cssText =
    'font:inherit;font-size:11px;padding:2px 8px;border-radius:4px;cursor:pointer;' +
    'border:1px solid currentColor;background:transparent;color:inherit;opacity:.75'
  toggle.setAttribute('title', getString('graph-scale-hint'))

  const controls = el(doc, 'div')
  controls.style.cssText = 'display:flex;align-items:center;gap:10px;padding-bottom:6px'
  controls.append(toggle)

  root.append(controls, plot)
  container.replaceChildren(root)

  // Measured after layout, not guessed: the tab is whatever size the window is.
  const draw = (): void => {
    const width = Math.max(320, plot.clientWidth)
    const height = Math.max(220, plot.clientHeight)
    const layout = buildGraphLayout(nodes, { width, height, padding: PADDING, scale })
    if (!layout) {
      plot.replaceChildren(el(doc, 'div', getString('graph-no-years')))
      return
    }

    // Parsed and imported, never innerHTML: Zotero's sanitizer strips xmlns and
    // the result silently stops being SVG.
    const parsed = new DOMParser().parseFromString(renderGraphSvg(layout, theme), 'image/svg+xml')
    const svg = parsed.documentElement
    if (!svg || svg.nodeName === 'parsererror') return
    const imported = doc.importNode(svg, true)

    imported.addEventListener('click', (event) => {
      const target = (event.target as Element | null)?.closest?.('circle')
      if (!target) return
      const itemID = target.getAttribute('data-item-id')
      const doi = target.getAttribute('data-doi')
      if (itemID) void Zotero.getActiveZoteroPane()?.selectItem(Number(itemID))
      else if (doi) Zotero.launchURL(`https://doi.org/${doi}`)
    })

    plot.replaceChildren(imported)
    if (layout.droppedNoYear > 0) {
      const note = el(doc, 'div', getString('graph-dropped-no-year', { args: { count: layout.droppedNoYear } }))
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
      return seed.itemIDs.map((id) => Zotero.Items.get(id)).filter((item): item is Zotero.Item => Boolean(item))
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
