import { cancelAutomaticUpdate, startAutomaticUpdate } from './modules/citationAutoupdate'
import { registerCitationPane, unregisterCitationPane } from './modules/citationPane'
import {
  abortInFlightLookups,
  BasicRegistrar,
  cancelManualUpdate,
  cancelMonthlyCleanup,
  scheduleMonthlyCleanup,
  UIRegistrar,
  UX,
} from './modules/citationTally'
import {
  closeDegradedNotice,
  maybeShowProactiveDegradedNotice,
  notifySemanticScholarUnavailable,
} from './modules/degradedNotice'
import { installTabIconStyle, registerGraphMenus, removeTabIconStyle } from './modules/graphTab'
import { registerLibraryIndexNotifier, unregisterLibraryIndexNotifier } from './modules/libraryIndex'
import { registerPrefsScripts, validateApiKeyUI, validateDatabaseOrderUI } from './modules/preferenceScript'
import {
  closeSemanticScholarWarning,
  flushPendingSemanticScholarWarning,
  getSemanticScholarClient,
  isSemanticScholarAvailable,
  shutdownSemanticScholarClient,
} from './modules/semanticScholarClient'
import { adoptLegacyState } from './utils/adoptLegacyState'
import { getString, initLocale } from './utils/locale'
import { flushCache, loadCache } from './utils/recordCache'

async function onStartup() {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise])
  // A disable during the waits above must not initialize anything.
  if (!addon.data.alive) return

  initLocale()

  addon.data.runtimeBridge = _globalThis.__runtimeBridgeReport

  BasicRegistrar.registerPrefs()

  // Before anything reads a preference: the plugin was installed under a
  // different name, and its settings and cache are still filed under it.
  await adoptLegacyState()

  // Key changes must be observed before any lookup can start. In the degraded
  // runtime the client is never constructed, but startup still has to finish.
  if (isSemanticScholarAvailable()) {
    getSemanticScholarClient().registerObserver()
  }

  // Register citation count notifier to detect new items
  UIRegistrar.registerNotifier()

  // Register custom column for citation counts
  UIRegistrar.registerCitationColumn()
  UIRegistrar.registerFwciColumn()

  // Process-wide registrations. These used to live in onMainWindowLoad, which
  // runs once per main window, so a second window re-registered the menus and
  // orphaned the first window's preference-observer ids.
  UIRegistrar.registerCitationCountMenuItem()
  UIRegistrar.registerRetallyCitationsMenuItem()
  UIRegistrar.registerThemeObservers()

  // Scaffolding for the graph tab: menus only, the tab itself draws a
  // placeholder until the rendering is confirmed to work in Zotero's chrome.
  registerGraphMenus()

  // The item pane section is an extra, and it goes last and inside a guard for
  // that reason: an unguarded call here once took the rest of startup with it
  // -- menus, theme observers, per-window setup -- leaving the whole plugin
  // looking dead after a restart. Zotero.debug rather than the plugin's own
  // gated logger, so the outcome is recorded without the debug pref set.
  // The DOI index the references block matches against; dropped whenever an
  // item changes, so it can never answer from a stale library.
  registerLibraryIndexNotifier()

  try {
    registerCitationPane()
  } catch (err) {
    Zotero.logError(err as Error)
    Zotero.debug(`Orbit: item pane section failed to register: ${String(err)}`)
  }

  // The cache only feeds the item pane, so a slow read must not hold up
  // startup; the pane's first async render awaits it anyway.
  loadCache().catch((err: unknown) => {
    Zotero.debug(`Orbit: cache load failed: ${String(err)}`)
  })

  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)))

  // A disable during window setup must not start background work.
  if (!addon.data.alive) return

  // Start automatic citation updates if enabled
  void startAutomaticUpdate()

  // Schedule cleanup of ignored items
  scheduleMonthlyCleanup()

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // The toolkit is process-wide and is created once in the Addon constructor.
  // Re-creating it here simply replaced the shared instance on every window.
  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-addon.ftl`)
  installTabIconStyle(win)

  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString('startup-begin'),
      type: 'default',
      progress: 0,
    })
    .show()

  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (!addon.data.alive) {
    // Woken late, after shutdown. Close the popup this hook created and register nothing.
    popupWin.close()
    return
  }
  popupWin.changeLine({
    progress: 30,
    text: getString('startup-progress', { args: { percent: 30, message: getString('startup-begin') } }),
  })

  // Per-window: system theme changes are observed through this window's
  // MediaQueryList, and removed again when it unloads.
  UIRegistrar.registerWindowThemeListener(win)

  popupWin.changeLine({
    progress: 100,
    text: getString('startup-progress', { args: { percent: 100, message: getString('startup-finish') } }),
  })
  popupWin.startCloseTimer(1000)

  // Display a key-rejection warning that was deferred until a window existed.
  flushPendingSemanticScholarWarning()

  // Tell users whose configuration includes Semantic Scholar when this runtime
  // can't support it. Does nothing in the normal full-capability runtime.
  maybeShowProactiveDegradedNotice()
}

function onMainWindowUnload(win: Window): void {
  // Only this window's resources. `ztoolkit.unregisterAll()` used to run here,
  // which tore down registrations still needed by any other open window; it now
  // runs once, at shutdown.
  UIRegistrar.unregisterWindowThemeListener(win)
  removeTabIconStyle(win)
  closeSemanticScholarWarning()
  closeDegradedNotice()
  addon.data.dialog?.window?.close()
}

/** Run every teardown step even when one throws; log failures and continue. */
function runTeardownSteps(steps: readonly (() => void)[]): void {
  for (const step of steps) {
    try {
      step()
    } catch (e) {
      ztoolkit.log('Orbit teardown step failed', e)
    }
  }
}

function onShutdown(): void {
  // Set before teardown so reentrant callbacks already see the plugin as dead.
  addon.data.alive = false
  // Cancel work before unregistering UI. Every step has to run: if one throws and
  // the delete below is skipped, the stale Zotero[addonInstance] makes the
  // index.ts guard keep the old instance when the plugin is re-enabled.
  runTeardownSteps([
    () => cancelAutomaticUpdate(),
    () => cancelMonthlyCleanup(),
    () => cancelManualUpdate(),
    // Cancel in-flight Crossref/INSPIRE requests too; without a deadline they
    // could otherwise outlive the plugin.
    () => abortInFlightLookups(),
    () => UIRegistrar.unregisterNotifier(),
    () => unregisterCitationPane(),
    () => unregisterLibraryIndexNotifier(),
    () => void flushCache(),
    () => shutdownSemanticScholarClient(),
    () => closeDegradedNotice(),
    () => ztoolkit.unregisterAll(),
    () => UIRegistrar.unregisterThemeObservers(),
    () => addon.data.dialog?.window?.close(),
  ])
  // Remove addon object
  // @ts-expect-error addon instance is injected at runtime
  delete Zotero[addon.data.config.addonInstance]
}

/**
 * Dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this function clear.
 * @param type event type
 * @param data event data
 */
function onPrefsEvent(type: string, data: Record<string, any>) {
  switch (type) {
    case 'load':
      void registerPrefsScripts(data.window)
      break
    case 'validateDatabases':
      validateDatabaseOrderUI(data.window)
      break
    case 'validateApiKey':
      void validateApiKeyUI(data.window)
      break
    default:
      return
  }
}

function onDialogEvents(type: string) {
  switch (type) {
    case 'updateCitationCounts':
      UX.updateSelectedItemsCitationCounts()
      break
    case 'retallyOutdatedCitations':
      // Surface the degraded runtime at action time. Does nothing in full mode.
      notifySemanticScholarUnavailable()
      void startAutomaticUpdate(false, 'manual') // false = show progress UI
      break
    default:
      break
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
  onDialogEvents,
}
