/**
 * Refreshing the field-weighted impact column, for a selection or a library.
 *
 * Until this existed the value had no path of its own. It arrived only as a
 * by-product of an OpenAlex *count* lookup, and OpenAlex is not in the shipped
 * database order -- so on a default install the column stayed blank except for
 * items whose pane had been opened. Asking for it deliberately is what this is.
 *
 * The count path spends one request per item because it asks per DOI. This asks
 * fifty DOIs at a time, for two fields, which is what makes a whole library
 * affordable: five thousand items are a hundred requests rather than five
 * thousand, and the payload per work is a float instead of a full record.
 *
 * Paced through the same `RateLimitManager` bucket as every other OpenAlex call,
 * so a refresh and a count run cannot together exceed what one of them would.
 */

import { getLocaleID, getString } from '../utils/locale'
import { debugLog } from '../utils/log'

import { Helpers, lookupFetch, RateLimitManager, REQUEST_HEADERS } from './citationTally'
import { flushFwciStore, recordFwci, shouldRefreshFwci, storedFwciCount } from './fwciTracker'
import { chunk, countValues, fwciWritesForChunk, planFwciLookups } from './fwciUpdate.core.ts'
import {
  buildFwciByDoiUrl,
  normalizeFwciBatch,
  OPENALEX_DATABASE,
  REFERENCE_CHUNK,
  toLookupDoi,
} from './openAlexClient.core'

/** One run at a time; a second would double the request rate for no gain. */
let running = false

interface RefreshOptions {
  /** Ask about every DOI, not only the missing and outdated ones. */
  force?: boolean
  /** No progress window and no summary. Used for the pass that follows a count run. */
  silent?: boolean
}

/** DOIs an item can be looked up by, in the order the count path would try them. */
function itemLookupDois(item: Zotero.Item): string[] {
  return Helpers.getAllItemIdentifiers(item).map((identifier) => toLookupDoi(identifier))
}

/**
 * Ask OpenAlex about one batch.
 *
 * Returns null for a failure worth stopping on -- a rate limit or an outage --
 * and an empty list when the batch simply matched nothing. The distinction
 * matters: on null nothing is written, so a transient failure is never recorded
 * as "this work has no FWCI".
 */
async function fetchBatch(dois: readonly string[]): Promise<ReturnType<typeof normalizeFwciBatch> | null> {
  await RateLimitManager.waitForRateLimit(OPENALEX_DATABASE)

  let response: Response
  try {
    response = await lookupFetch(buildFwciByDoiUrl(dois), { headers: REQUEST_HEADERS })
  } catch (err) {
    debugLog('Citation debug - FWCI batch request failed:', err)
    return null
  }

  RateLimitManager.noteBudget(OPENALEX_DATABASE, response)

  if (!response.ok) {
    if (response.status === 429) RateLimitManager.handleRateLimit(OPENALEX_DATABASE)
    debugLog(`Citation debug - FWCI batch HTTP ${response.status} for ${dois.length} DOIs`)
    return null
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    debugLog('Citation debug - FWCI batch body parse failed:', err)
    return null
  }

  RateLimitManager.handleSuccess(OPENALEX_DATABASE)
  return normalizeFwciBatch(body)
}

/**
 * Refresh the field-weighted impact for a set of items.
 *
 * Deliberately independent of the configured database order. FWCI is an OpenAlex
 * measure whichever source the counts come from, and gating it on the count
 * setting is what left the column empty by default.
 */
export async function refreshFwciForItems(items: readonly Zotero.Item[], options: RefreshOptions = {}): Promise<void> {
  const { force = false, silent = false } = options

  if (running) {
    // Silence here would read as a menu item that does nothing.
    if (!silent) {
      new ztoolkit.ProgressWindow(addon.data.config.addonName, { closeOnClick: true })
        .createLine({ text: getString('progress-fwci-already-running'), type: 'default' })
        .show()
        .startCloseTimer(3000)
    }
    debugLog('Citation debug - FWCI refresh already running; skipping')
    return
  }

  const regular = items.filter((item) => item.isRegularItem())
  const now = Temporal.Now.instant()
  const dois = planFwciLookups(
    regular.map((item) => itemLookupDois(item)),
    (doi) => force || shouldRefreshFwci(doi, now),
  )

  if (dois.length === 0) {
    if (!silent) {
      new ztoolkit.ProgressWindow(addon.data.config.addonName, { closeOnClick: true })
        .createLine({ text: getString('progress-fwci-nothing-to-do'), type: 'success' })
        .show()
        .startCloseTimer(3000)
    }
    debugLog('Citation debug - FWCI refresh: nothing to ask about')
    return
  }

  running = true
  const batches = chunk(dois, REFERENCE_CHUNK)
  let asked = 0
  let withValue = 0
  let stopped = false

  let progressWindow: any = null
  if (!silent) {
    progressWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName)
    progressWindow.createLine({ text: getString('progress-fwci-starting'), type: 'default', progress: 0 })
    progressWindow.show()
  }

  try {
    for (let at = 0; at < batches.length; at++) {
      // Same shutdown contract as every other queue in the plugin.
      if (!addon.data.alive) break

      const batch = batches[at]
      const found = await fetchBatch(batch)
      if (found === null) {
        // Stop rather than press on: the usual cause is a rate limit or an
        // outage, and the remaining batches would meet the same wall while
        // spending the budget the next run needs.
        stopped = true
        break
      }

      const writes = fwciWritesForChunk(batch, found)
      for (const write of writes) recordFwci(write.lookupDoi, write.fwci)
      asked += writes.length
      withValue += countValues(writes)

      if (!silent && progressWindow) {
        progressWindow.changeLine({
          text: getString('progress-fwci-counter', {
            args: { current: Math.min(asked, dois.length), total: dois.length },
          }),
          progress: Math.round(((at + 1) / batches.length) * 100),
        })
        progressWindow.show()
      }
    }
  } finally {
    running = false
    // The column reads the store directly, so the values are only visible once
    // they are in it; the flush is what makes them survive a restart.
    await flushFwciStore()
    if (progressWindow) progressWindow.close()
  }

  debugLog(
    `Citation debug - FWCI refresh: asked ${asked} of ${dois.length} DOIs, ${withValue} with a value, ` +
      `${storedFwciCount()} stored${stopped ? ' (stopped early)' : ''}`,
  )

  // Cells are drawn from the store, and nothing else tells the tree the store
  // changed. Not during teardown, where the tree is already going away.
  if (addon.data.alive) Zotero.ItemTreeManager.refreshColumns()

  if (!silent && addon.data.alive) {
    const summary = new ztoolkit.ProgressWindow(addon.data.config.addonName)
    summary.createLine({
      text: stopped
        ? getString('progress-fwci-stopped', { args: { count: withValue } })
        : getString('progress-fwci-done', { args: { count: withValue } }),
      type: stopped ? 'error' : 'success',
      progress: 100,
    })
    summary.show()
    summary.startCloseTimer(4000)
  }
}

/** Every regular item in the user library, for the library-wide entry point. */
async function libraryItems(): Promise<Zotero.Item[]> {
  // Mirrors citationAutoupdate's scan: libraryID goes through the constructor,
  // and attachments and notes are excluded in the search rather than after it.
  const search = new Zotero.Search({ libraryID: Zotero.Libraries.userLibraryID })
  search.addCondition('deleted', 'false', '')
  search.addCondition('itemType', 'isNot', 'attachment')
  search.addCondition('itemType', 'isNot', 'note')
  const ids = await search.search()
  const items = await Zotero.Items.getAsync(ids)
  return items.filter((item) => item.isRegularItem())
}

/** The Tools entry: everything missing or past the outdated cutoff. */
export async function refreshFwciForLibrary(): Promise<void> {
  const items = await libraryItems()
  debugLog(`Citation debug - FWCI library refresh over ${items.length} regular items`)
  await refreshFwciForItems(items)
}

/** The context-menu entry: whatever is selected, asked about regardless of age. */
export async function refreshFwciForSelection(): Promise<void> {
  const pane = Zotero.getActiveZoteroPane()
  if (!pane) return
  // Force: someone who picked these items and asked for a refresh means these
  // items, not the subset a cutoff considers due.
  await refreshFwciForItems(pane.getSelectedItems(), { force: true })
}

/**
 * The pass that follows a count run.
 *
 * Cheap enough to be unconditional -- one request per fifty items, against a
 * count run that has just spent one per item -- and silent, because the count
 * run has its own progress window and summary.
 */
export async function refreshFwciAfterCounts(items: readonly Zotero.Item[]): Promise<void> {
  await refreshFwciForItems(items, { silent: true })
}

export function registerFwciMenus(): void {
  Zotero.MenuManager.registerMenu({
    menuID: `${addon.data.config.addonID}-update-fwci`,
    pluginID: addon.data.config.addonID,
    target: 'main/library/item',
    menus: [
      {
        menuType: 'menuitem',
        l10nID: getLocaleID('menuitem-update-fwci'),
        icon: 'chrome://zotero/skin/toolbar-advanced-search.png',
        onShowing: () => {
          try {
            const pane = Zotero.getActiveZoteroPane()
            if (!pane) return false
            const selected = pane.getSelectedItems()
            if (!selected || selected.length === 0) return false
            return selected.some((item) => item.isRegularItem())
          } catch {
            return false
          }
        },
        onCommand: () => addon.hooks.onDialogEvents('updateFwci'),
      },
    ],
  })

  Zotero.MenuManager.registerMenu({
    menuID: `${addon.data.config.addonID}-refresh-fwci-library`,
    pluginID: addon.data.config.addonID,
    target: 'main/menubar/tools',
    menus: [
      {
        menuType: 'menuitem',
        l10nID: getLocaleID('menuitem-refresh-fwci-library'),
        onCommand: () => addon.hooks.onDialogEvents('refreshFwciLibrary'),
      },
    ],
  })
}
