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
function renderPlaceholder(doc: Document, container: Element, seed: GraphSeed): void {
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

  const note = el(doc, 'div', getString('graph-placeholder-note'))
  note.style.cssText = 'font-size:12px;opacity:.75'

  frame.append(title, what, note)
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
    data: { icon: 'related' },
    select: true,
  })

  renderPlaceholder(win.document, container, seed)
  Zotero.debug(`Citation Tally: graph tab opened for ${seed.kind} "${seed.name}"`)
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
