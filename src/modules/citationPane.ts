/**
 * The item pane section.
 *
 * The column is good for a number and bad for everything else, and it hides
 * the most interesting signal in the data: that the sources often disagree.
 * Crossref reporting 1 citation where Google Scholar reports 626 is not noise,
 * it is the coverage gap between DOI-indexed literature and everything else,
 * and it is worth surfacing rather than leaving to be noticed.
 *
 * Everything here is display-only. Nothing written by this module reaches the
 * Extra field, so a shared group library stays untouched.
 */

import { getLocaleID, getString } from '../utils/locale'
import { debugLog } from '../utils/log'

import { buildChartModel, renderChartSvg } from './citationChart.core.ts'
import { Core, getDatabaseColors, getOperationName, Helpers } from './citationTally'
import { fetchJournalMetrics, fetchScholarlyRecord } from './openAlexEnrichment'

import type { JournalMetrics, ScholarlyRecord } from './openAlexClient.core.ts'

const PANE_ID = 'citationtally-pane'

/**
 * Flag the sources as disagreeing once the largest is this many times the
 * smallest non-zero one.
 *
 * Chosen to stay quiet on ordinary variation -- Crossref undercounts relative
 * to Semantic Scholar on almost everything -- and to speak up when the gap is
 * the kind that means a source simply cannot see the work.
 */
const DIVERGENCE_RATIO = 3

let registeredPaneID: string | false = false

interface PaneData {
  record: ScholarlyRecord | null
  journal: JournalMetrics | null
}

/**
 * The item pane is a XUL document, where `createElement('div')` produces a
 * *XUL* element named "div": present in the DOM, laid out by nothing, drawn
 * never. The section rendered 28 nodes and showed a blank panel until this was
 * namespaced explicitly.
 */
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

function el(doc: Document, tag: string, className?: string, text?: string): HTMLElement {
  const node = doc.createElementNS(XHTML_NS, tag) as HTMLElement
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A `label: value` line. */
function row(doc: Document, label: string, value: string): HTMLElement {
  const line = el(doc, 'div', 'citationtally-row')
  line.style.display = 'flex'
  line.style.justifyContent = 'space-between'
  line.style.gap = '8px'
  line.style.padding = '1px 0'
  const key = el(doc, 'span', undefined, label)
  key.style.opacity = '0.7'
  const val = el(doc, 'span', undefined, value)
  val.style.textAlign = 'right'
  line.append(key, val)
  return line
}

function heading(doc: Document, text: string): HTMLElement {
  const node = el(doc, 'div', 'citationtally-heading', text)
  node.style.fontWeight = '600'
  node.style.marginTop = '10px'
  node.style.marginBottom = '3px'
  return node
}

function link(doc: Document, text: string, url: string): HTMLElement {
  const node = el(doc, 'a', undefined, text)
  node.setAttribute('href', url)
  node.style.cursor = 'pointer'
  node.addEventListener('click', (event) => {
    event.preventDefault()
    Zotero.launchURL(url)
  })
  return node
}

/**
 * The counts the plugin already stored, plus a note when they disagree.
 *
 * Sources are drawn in DATABASE_DISPLAY_ORDER and always carry their name.
 * The colour swatch is a secondary cue: no five-colour palette separates every
 * pair for every form of colour vision, so identity never rests on it.
 */
function renderCounts(doc: Document, body: HTMLElement, item: Zotero.Item, record: ScholarlyRecord | null): void {
  const stored = Core.getStoredCountsByDatabase(item)
  if (stored.length === 0 && record?.citedByCount === null) return

  body.append(heading(doc, getString('pane-heading-citations')))
  const colors = getDatabaseColors()

  for (const { database, count } of stored) {
    const line = el(doc, 'div')
    line.style.display = 'flex'
    line.style.alignItems = 'center'
    line.style.gap = '6px'
    line.style.padding = '1px 0'

    const swatch = el(doc, 'span')
    swatch.style.cssText = `width:8px;height:8px;border-radius:2px;flex:none;background:${colors[database] ?? 'currentColor'}`
    const name = el(doc, 'span', undefined, getOperationName(database))
    name.style.flex = '1'
    const value = el(doc, 'span', undefined, count.toLocaleString())

    line.append(swatch, name, value)
    body.append(line)
  }

  const counts = stored.map((entry) => entry.count).filter((count) => count > 0)
  if (counts.length >= 2) {
    const spread = Math.max(...counts) / Math.min(...counts)
    if (spread >= DIVERGENCE_RATIO) {
      const note = el(doc, 'div', undefined, getString('pane-divergence-note'))
      note.style.cssText = 'opacity:.75;font-size:11px;margin-top:4px;line-height:1.35'
      body.append(note)
    }
  }

  if (record?.fwci !== null && record?.fwci !== undefined) {
    body.append(row(doc, getString('pane-label-fwci'), record.fwci.toFixed(2)))
  }
  if (record?.percentile) {
    body.append(row(doc, getString('pane-label-percentile'), `${record.percentile.min}–${record.percentile.max}%`))
  }
}

function renderChart(doc: Document, body: HTMLElement, record: ScholarlyRecord): void {
  const model = buildChartModel(record.countsByYear, new Date().getFullYear())
  if (!model) return

  body.append(heading(doc, getString('pane-heading-history')))
  const colors = getDatabaseColors()
  const markup = renderChartSvg(
    model,
    { series: colors.openalex ?? 'currentColor', muted: 'currentColor' },
    `${PANE_ID}-${model.firstYear}-${model.lastYear}`,
  )

  // Parsed and imported rather than assigned to innerHTML. Zotero sanitizes
  // innerHTML and strips `xmlns` along with `role`; without the namespace the
  // element lands in the HTML namespace and is never drawn as SVG at all.
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = parsed.documentElement
  if (!root || root.nodeName === 'parsererror') {
    debugLog('Citation debug - Chart SVG did not parse')
    return
  }
  body.append(doc.importNode(root, true))
}

function renderOpenAccess(doc: Document, body: HTMLElement, record: ScholarlyRecord): void {
  body.append(heading(doc, getString('pane-heading-access')))
  const status = record.openAccess.status ?? (record.openAccess.isOa ? 'open' : 'closed')
  body.append(row(doc, getString('pane-label-oa-status'), status))
  if (record.openAccess.url) {
    const line = el(doc, 'div')
    line.style.padding = '1px 0'
    line.append(link(doc, getString('pane-link-fulltext'), record.openAccess.url))
    body.append(line)
  }
  if (record.apc) {
    body.append(row(doc, getString('pane-label-apc'), `${record.apc.value.toLocaleString()} ${record.apc.currency}`))
  }
}

function renderJournal(
  doc: Document,
  body: HTMLElement,
  record: ScholarlyRecord,
  journal: JournalMetrics | null,
): void {
  if (!record.sourceName && !journal) return
  body.append(heading(doc, getString('pane-heading-journal')))
  if (record.sourceName) body.append(row(doc, getString('pane-label-journal'), record.sourceName))
  if (journal?.twoYearMeanCitedness !== null && journal?.twoYearMeanCitedness !== undefined) {
    body.append(row(doc, getString('pane-label-mean-citedness'), journal.twoYearMeanCitedness.toFixed(2)))
  }
  if (journal?.hIndex !== null && journal?.hIndex !== undefined) {
    body.append(row(doc, getString('pane-label-h-index'), journal.hIndex.toLocaleString()))
  }
  if (journal?.i10Index !== null && journal?.i10Index !== undefined) {
    body.append(row(doc, getString('pane-label-i10-index'), journal.i10Index.toLocaleString()))
  }
  const inDoaj = journal?.isInDoaj ?? record.sourceIsInDoaj
  body.append(row(doc, getString('pane-label-doaj'), getString(inDoaj ? 'pane-value-yes' : 'pane-value-no')))
  if (journal?.apcUsd !== null && journal?.apcUsd !== undefined && !record.apc) {
    body.append(row(doc, getString('pane-label-apc'), `${journal.apcUsd.toLocaleString()} USD`))
  }
}

function renderAuthors(doc: Document, body: HTMLElement, record: ScholarlyRecord): void {
  if (record.authors.length === 0) return
  body.append(heading(doc, getString('pane-heading-authors')))
  for (const author of record.authors) {
    const line = el(doc, 'div')
    line.style.padding = '1px 0'
    line.append(el(doc, 'span', undefined, author.name))
    if (author.orcid) {
      line.append(doc.createTextNode(' '))
      line.append(link(doc, 'ORCID', author.orcid))
    }
    body.append(line)
  }

  const institutions = new Map<string, string | null>()
  for (const author of record.authors) {
    for (const inst of author.institutions) {
      if (!institutions.has(inst.name)) institutions.set(inst.name, inst.ror)
    }
  }
  if (institutions.size === 0) return

  body.append(heading(doc, getString('pane-heading-institutions')))
  for (const [name, ror] of institutions) {
    const line = el(doc, 'div')
    line.style.padding = '1px 0'
    line.append(el(doc, 'span', undefined, name))
    if (ror) {
      line.append(doc.createTextNode(' '))
      line.append(link(doc, 'ROR', ror))
    }
    body.append(line)
  }
}

function renderFunding(doc: Document, body: HTMLElement, record: ScholarlyRecord): void {
  if (record.funding.length === 0) return
  body.append(heading(doc, getString('pane-heading-funding')))
  for (const grant of record.funding) {
    body.append(row(doc, grant.funder, grant.awardId ?? ''))
  }
}

function renderInto(doc: Document, body: HTMLElement, item: Zotero.Item, data: PaneData): void {
  body.replaceChildren()
  body.style.cssText = 'font-size:12px;line-height:1.45;padding:2px 0'

  const { record, journal } = data

  // A retraction outranks every metric on the page.
  if (record?.isRetracted) {
    const warning = el(doc, 'div', undefined, getString('pane-retracted'))
    warning.style.cssText =
      'font-weight:600;padding:5px 7px;margin-bottom:6px;border-radius:4px;' +
      'background:color-mix(in srgb, currentColor 10%, transparent)'
    body.append(warning)
  }

  renderCounts(doc, body, item, record)

  if (!record) {
    const empty = el(doc, 'div', undefined, getString('pane-no-openalex'))
    empty.style.cssText = 'opacity:.7;margin-top:8px;line-height:1.35'
    body.append(empty)
    return
  }

  renderChart(doc, body, record)
  renderOpenAccess(doc, body, record)
  renderJournal(doc, body, record, journal)
  renderAuthors(doc, body, record)
  renderFunding(doc, body, record)
}

async function loadData(item: Zotero.Item, force: boolean): Promise<PaneData> {
  const identifiers = Helpers.getAllItemIdentifiers(item)
  if (identifiers.length === 0) return { record: null, journal: null }

  const record = await fetchScholarlyRecord(identifiers, { force })
  const journal = record?.sourceId ? await fetchJournalMetrics(record.sourceId, { force }) : null
  return { record, journal }
}

export function registerCitationPane(): void {
  if (registeredPaneID !== false) return

  // Tracks which item each render belongs to, so a slow fetch for a
  // previously selected item cannot paint over the current one.
  const inFlight = new WeakMap<HTMLElement, number>()

  // Deliberately the shape both official examples use -- Zotero 7 for
  // Developers and the plugin template this fork is built on -- and nothing
  // more. The first attempt registered the richest option set available,
  // including sectionButtons, and produced a header with no icon, no button
  // and no twisty. Features go back in one at a time, each verified.
  registeredPaneID = Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID('pane-header'),
      icon: `chrome://${addon.data.config.addonRef}/content/icons/pane16.svg`,
    },
    sidenav: {
      l10nID: getLocaleID('pane-sidenav'),
      icon: `chrome://${addon.data.config.addonRef}/content/icons/pane20.svg`,
    },
    onItemChange: ({ item, setEnabled }) => {
      setEnabled(item?.isRegularItem() === true)
    },
    onRender: ({ doc, body, item, setSectionSummary }) => {
      try {
        // Synchronous pass: show what is already stored, so the section has its
        // height and its most important content before any network call.
        renderInto(doc, body, item, { record: null, journal: null })
        body.append(el(doc, 'div', undefined, getString('pane-loading')))
        // Shown in the collapsed header. Built-in sections call
        // `setCount()`/`empty = false` on their section element; plugin
        // sections get no such prop, so a summary is the only way to say
        // anything at all while collapsed -- and the only proof from outside
        // that the section is alive rather than broken.
        const stored = Core.getStoredCountsByDatabase(item)
        setSectionSummary(
          stored.length > 0 ? stored.map((entry) => String(entry.count)).join(' / ') : getString('pane-loading'),
        )
      } catch (err) {
        debugLog('Citation debug - Item pane render failed:', err)
      }
    },
    sectionButtons: [
      {
        // The DOM dump showed `extra-buttons=citationtally-refresh` present on
        // the section all along, so this was never what kept the header from
        // building -- that was the Fluent message shape.
        type: 'citationtally-refresh',
        icon: 'chrome://zotero/skin/16/universal/sync.svg',
        l10nID: getLocaleID('pane-refresh'),
        onClick: ({ doc, body, item }) => {
          void (async () => {
            try {
              const data = await loadData(item, true)
              renderInto(doc, body, item, data)
            } catch (err) {
              debugLog('Citation debug - Item pane refresh failed:', err)
            }
          })()
        },
      },
    ],
    onAsyncRender: async ({ doc, body, item, setSectionSummary }) => {
      const token = item.id
      inFlight.set(body, token)
      try {
        const data = await loadData(item, false)
        if (inFlight.get(body) !== token) return
        renderInto(doc, body, item, data)
        const summary = Core.getStoredCountsByDatabase(item)
          .map((entry) => String(entry.count))
          .join(' / ')
        if (summary) setSectionSummary(summary)
      } catch (err) {
        debugLog('Citation debug - Item pane render failed:', err)
        if (inFlight.get(body) !== token) return
        renderInto(doc, body, item, { record: null, journal: null })
      }
    },
  })

  // Unconditional: registerSection returns false on a rejected option set and
  // only logs to the debug output, so without this a silent failure looks
  // exactly like a section that renders nothing.
  Zotero.debug(`Citation Tally: registerSection returned ${String(registeredPaneID)}`)
}

export function unregisterCitationPane(): void {
  if (registeredPaneID === false) return
  Zotero.ItemPaneManager.unregisterSection(registeredPaneID)
  registeredPaneID = false
}
