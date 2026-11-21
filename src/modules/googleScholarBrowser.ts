/*! @license
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from the fix proposed for zotero-google-scholar-citation-count in
 * https://github.com/justinribeiro/zotero-google-scholar-citation-count/pull/73
 * (papatistos), MPL-2.0: loading the search in Zotero's HiddenBrowser with
 * JavaScript on, reading the page through the PageData actor, discarding a
 * reply that arrives after a navigation, and only showing a window when the
 * challenge needs a person.
 *
 * MPL-2.0 is file-level: this file stays under it while the rest of Orbit is
 * AGPL-3.0, which section 3.3 of the MPL expressly allows.
 */

/**
 * Reach Scholar's results when Google puts a check in front of them.
 *
 * `Zotero.HTTP` runs no JavaScript, so a JavaScript interstitial never lets it
 * through. A hidden browser does, and the cookies it earns are Zotero's own,
 * so later plain requests may pass again. A real CAPTCHA still needs a person;
 * for that the page opens in Zotero's viewer and is read once solved.
 *
 * Everything here returns null on failure, never "no result": not reaching
 * Scholar says nothing about the item.
 */

import { challengeNeedsPerson, isSameScholarSearch } from './googleScholarClient.core'

/** A Scholar page as a browser saw it. */
export interface ScholarBrowserPage {
  html: string
  url: string
}

export type BackgroundOutcome = { kind: 'page'; page: ScholarBrowserPage } | { kind: 'needs_person' } | null

const BACKGROUND_DEADLINE_MS = 20_000
const VIEWER_DEADLINE_MS = 120_000
const POLL_MS = 500
const PAGE_READ_TIMEOUT_MS = 3_000

interface WindowGlobalLike {
  documentURI: { spec: string }
  getActor(name: string): { sendQuery(message: string): Promise<unknown> }
}

interface BrowserLike {
  browsingContext?: { currentWindowGlobal?: WindowGlobalLike | null } | null
}

interface HiddenBrowserLike extends BrowserLike {
  load(url: string): Promise<boolean>
  destroy(): void
}

type HiddenBrowserCtor = new (options: { allowJavaScript: boolean }) => HiddenBrowserLike

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Zotero's HiddenBrowser module. `ChromeUtils` is a global in the privileged
 * scope the bundle runs in; the main window's copy is the fallback.
 */
function loadHiddenBrowserCtor(): HiddenBrowserCtor | null {
  type ChromeUtilsLike = { importESModule(url: string): { HiddenBrowser?: HiddenBrowserCtor } }
  const scoped = (globalThis as { ChromeUtils?: ChromeUtilsLike }).ChromeUtils
  const fromWindow = (Zotero.getMainWindow() as unknown as { ChromeUtils?: ChromeUtilsLike } | null)?.ChromeUtils
  const chromeUtils = scoped ?? fromWindow
  if (!chromeUtils) return null
  try {
    return chromeUtils.importESModule('chrome://zotero/content/HiddenBrowser.mjs').HiddenBrowser ?? null
  } catch (err) {
    Zotero.debug(`Orbit: HiddenBrowser unavailable: ${String(err)}`)
    return null
  }
}

/** Read the browser's current document, or null if it moved on meanwhile. */
async function readPage(browser: BrowserLike | null | undefined): Promise<ScholarBrowserPage | null> {
  const global = browser?.browsingContext?.currentWindowGlobal
  if (!global) return null
  const url = global.documentURI.spec
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const html = await Promise.race([
      global.getActor('PageData').sendQuery('documentHTML'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Scholar page read timed out')), PAGE_READ_TIMEOUT_MS)
      }),
    ])
    // Never pair one page's HTML with another page's URL.
    if (browser?.browsingContext?.currentWindowGlobal !== global) return null
    return typeof html === 'string' ? { html, url } : null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Poll `browser` until it shows the results for `requestedURL`. `accept`
 * decides whether a page on that URL is already the answer (and not, say, the
 * interstitial still running); `onOther` may end the wait early.
 */
async function waitForResults(
  browser: () => BrowserLike | null | undefined,
  requestedURL: string,
  deadlineMs: number,
  accept: (page: ScholarBrowserPage) => boolean,
  stop: (page: ScholarBrowserPage | null) => 'needs_person' | 'closed' | null,
): Promise<BackgroundOutcome> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    let page: ScholarBrowserPage | null = null
    try {
      page = await readPage(browser())
    } catch {
      // Navigation can briefly make the document unreadable.
    }
    if (page && isSameScholarSearch(page.url, requestedURL) && accept(page)) return { kind: 'page', page }
    const verdict = stop(page)
    if (verdict === 'needs_person') return { kind: 'needs_person' }
    if (verdict === 'closed') return null
    await sleep(POLL_MS)
  }
  return null
}

/**
 * Load the search in a hidden browser with JavaScript on, so an interstitial
 * can finish. Returns the results page, `needs_person` for a real CAPTCHA, or
 * null if nothing usable arrived in time.
 */
export async function loadScholarInBackground(
  requestedURL: string,
  accept: (page: ScholarBrowserPage) => boolean,
): Promise<BackgroundOutcome> {
  const HiddenBrowser = loadHiddenBrowserCtor()
  if (!HiddenBrowser) return null
  const browser = new HiddenBrowser({ allowJavaScript: true })
  try {
    if (!(await browser.load(requestedURL))) return null
    return await waitForResults(
      () => browser,
      requestedURL,
      BACKGROUND_DEADLINE_MS,
      accept,
      (page) => (page && challengeNeedsPerson(page.html) ? 'needs_person' : null),
    )
  } catch (err) {
    Zotero.debug(`Orbit: Scholar hidden browser failed: ${String(err)}`)
    return null
  } finally {
    browser.destroy()
  }
}

/**
 * Open the search in Zotero's viewer so a person can solve the CAPTCHA, and
 * read the results from that same document once they appear. Repeating the
 * request instead can land straight back on the challenge.
 */
export async function solveScholarInViewer(
  requestedURL: string,
  accept: (page: ScholarBrowserPage) => boolean,
): Promise<ScholarBrowserPage | null> {
  const viewer = Zotero.openInViewer(requestedURL, { allowJavaScript: true }) as unknown as
    (Window & { closed: boolean }) | null | undefined
  if (!viewer) return null
  const outcome = await waitForResults(
    () => viewer.document?.querySelector('browser') as unknown as BrowserLike | null,
    requestedURL,
    VIEWER_DEADLINE_MS,
    accept,
    () => (viewer.closed ? 'closed' : null),
  )
  if (outcome?.kind === 'page') {
    try {
      viewer.close()
    } catch {
      // Already gone.
    }
    return outcome.page
  }
  return null
}
