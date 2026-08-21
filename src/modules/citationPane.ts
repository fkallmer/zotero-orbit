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
import { getPref } from '../utils/prefs'
import { readCache } from '../utils/recordCache'
import { toS2PaperRefs } from '../utils/s2Identifiers'

import { buildChartModel, renderChartSvg } from './citationChart.core.ts'
import { Core, getDatabaseColors, getOperationName, Helpers, updateItem } from './citationTally'
import { buildScholarUrl } from './googleScholarClient.core.ts'
import { getDoiIndex, normalizeDoi } from './libraryIndex'
import { fetchJournalMetrics, fetchReferences, fetchScholarlyRecord } from './openAlexEnrichment'
import { s2DetailsCacheKey } from './s2Details'

import type { JournalMetrics, ScholarlyRecord } from './openAlexClient.core.ts'
import type { S2Details } from './semanticScholarClient.core'

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
  s2: S2Details | null
  /** From Semantic Scholar when it has them, from OpenAlex when it does not. */
  references: PaneReference[]
  /** Normalized DOI -> item id, for the references the user already holds. */
  inLibrary: Map<string, number>
}

/** How many references to list before collapsing the rest into a count. */
const REFERENCES_SHOWN = 8

/** The pane before anything has been fetched, and after a failure. */
function emptyPaneData(): PaneData {
  return { record: null, journal: null, s2: null, references: [], inLibrary: new Map() }
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

/** Marks the explanation blocks the info toggle shows and hides. */
const HINT_ATTR = 'data-citationtally-hint'

/**
 * A `label: value` line, optionally with an explanation.
 *
 * The hint is always in the DOM and hidden, not built on demand: a value like
 * "2-year mean citedness: 4.18" is unreadable to anyone who does not already
 * know the term, and the explanation has to be one click away rather than one
 * search away.
 */
function row(doc: Document, label: string, value: string, hint?: string): HTMLElement {
  const wrap = el(doc, 'div')

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
  wrap.append(line)

  if (hint) {
    // Hovering works too, for anyone who never finds the toggle.
    key.setAttribute('title', hint)
    key.style.cursor = 'help'
    const note = el(doc, 'div', undefined, hint)
    note.setAttribute(HINT_ATTR, '1')
    note.style.cssText = 'display:none;opacity:.6;font-size:11px;line-height:1.35;padding:0 0 4px 0'
    wrap.append(note)
  }
  return wrap
}

/**
 * The heading for a block, with a toggle that reveals every explanation in the
 * pane.
 */
function headingWithInfo(doc: Document, text: string, body: HTMLElement): HTMLElement {
  // The label goes in its own span: a bare text node beside an element in a
  // flex row becomes an anonymous item and lays out unpredictably.
  const node = el(doc, 'div', 'citationtally-heading')
  node.style.cssText = 'display:flex;align-items:center;gap:6px;font-weight:600;margin:10px 0 3px'
  node.append(el(doc, 'span', undefined, text))

  // Beside the heading rather than pushed to the far edge -- at the far right
  // it reads as unrelated furniture and goes unnoticed.
  const toggle = el(doc, 'span', undefined, 'i')
  toggle.setAttribute('title', getString('pane-info-toggle'))
  toggle.setAttribute('role', 'button')
  toggle.setAttribute('tabindex', '0')
  toggle.style.cssText =
    'cursor:pointer;opacity:.75;font-style:italic;font-weight:600;font-size:10px;width:13px;height:13px;' +
    'line-height:13px;text-align:center;border:1px solid currentColor;border-radius:50%;flex:none'
  const flip = () => {
    const notes = [...body.querySelectorAll<HTMLElement>(`[${HINT_ATTR}]`)]
    const show = notes.some((note) => note.style.display === 'none')
    for (const note of notes) note.style.display = show ? 'block' : 'none'
    toggle.style.opacity = show ? '1' : '.55'
  }
  toggle.addEventListener('click', flip)
  toggle.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') flip()
  })

  node.append(toggle)
  return node
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
 * Where a given source shows this work, or null if it cannot be addressed.
 *
 * Each link goes to that provider's own page for the paper rather than to a
 * generic resolver: the point of showing four numbers side by side is being
 * able to go and see where each one comes from.
 */
function sourceUrl(database: string, item: Zotero.Item, record: ScholarlyRecord | null): string | null {
  const doi = Helpers.getAllItemIdentifiers(item).find((id) => id.type === 'doi')?.id ?? null

  switch (database) {
    case 'openalex':
      // The record carries its own canonical URL; the DOI form is the fallback
      // for when the pane has counts but no record yet.
      return record?.openAlexId ?? (doi ? `https://openalex.org/works/doi:${encodeURIComponent(doi)}` : null)
    case 'crossref':
      return doi ? `https://search.crossref.org/search/works?q=${encodeURIComponent(doi)}&from_ui=yes` : null
    case 'semanticscholar':
      // The api host redirects a DOI to the canonical paper page. The obvious
      // `semanticscholar.org/paper/<doi>` does not resolve at all -- that path
      // expects Semantic Scholar's own paper id.
      return doi ? `https://api.semanticscholar.org/${doi}` : null
    case 'inspire':
      return doi ? `https://inspirehep.net/literature?q=${encodeURIComponent(doi)}` : null
    case 'googlescholar': {
      // The same query the provider ran, so the page shows the hit the count
      // was read from rather than a fresh guess.
      const title = item.getField('title')
      if (!title) return null
      try {
        return buildScholarUrl({
          endpoint: getPref('googleScholarEndpoint') || 'https://scholar.google.com',
          title,
          authors: (item.getCreators() || []).map((creator) => creator.lastName).filter(Boolean),
          matchAuthors: true,
        })
      } catch {
        return null
      }
    }
    default:
      return null
  }
}

/**
 * The counts the plugin already stored, plus a note when they disagree.
 *
 * Sources are drawn in DATABASE_DISPLAY_ORDER and always carry their name.
 * The colour swatch is a secondary cue: no five-colour palette separates every
 * pair for every form of colour vision, so identity never rests on it.
 */
function renderCounts(doc: Document, body: HTMLElement, item: Zotero.Item, data: PaneData): void {
  const record = data.record
  const stored = Core.getStoredCountsByDatabase(item)
  if (stored.length === 0 && record?.citedByCount === null) return

  body.append(headingWithInfo(doc, getString('pane-heading-citations'), body))
  const colors = getDatabaseColors()

  for (const { database, count } of stored) {
    const line = el(doc, 'div')
    line.style.display = 'flex'
    line.style.alignItems = 'center'
    line.style.gap = '6px'
    line.style.padding = '1px 0'

    const swatch = el(doc, 'span')
    swatch.style.cssText = `width:8px;height:8px;border-radius:2px;flex:none;background:${colors[database] ?? 'currentColor'}`
    const url = sourceUrl(database, item, record)
    const name = url
      ? link(doc, getOperationName(database), url)
      : el(doc, 'span', undefined, getOperationName(database))
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
    body.append(row(doc, getString('pane-label-fwci'), record.fwci.toFixed(2), getString('pane-hint-fwci')))
  }
  // Placed with the counts rather than in its own block: it qualifies the
  // Semantic Scholar number directly above it.
  if (data.s2?.influentialCitationCount !== null && data.s2?.influentialCitationCount !== undefined) {
    body.append(
      row(
        doc,
        getString('pane-label-influential'),
        String(data.s2.influentialCitationCount),
        getString('pane-hint-influential'),
      ),
    )
  }

  if (record?.percentile) {
    body.append(
      row(
        doc,
        getString('pane-label-percentile'),
        `${record.percentile.min}–${record.percentile.max}%`,
        getString('pane-hint-percentile'),
      ),
    )
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
    body.append(
      row(
        doc,
        getString('pane-label-apc'),
        `${record.apc.value.toLocaleString()} ${record.apc.currency}`,
        getString('pane-hint-apc'),
      ),
    )
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
    body.append(
      row(
        doc,
        getString('pane-label-mean-citedness'),
        journal.twoYearMeanCitedness.toFixed(2),
        getString('pane-hint-mean-citedness'),
      ),
    )
  }
  if (journal?.hIndex !== null && journal?.hIndex !== undefined) {
    body.append(
      row(doc, getString('pane-label-h-index'), journal.hIndex.toLocaleString(), getString('pane-hint-h-index')),
    )
  }
  if (journal?.i10Index !== null && journal?.i10Index !== undefined) {
    body.append(
      row(doc, getString('pane-label-i10-index'), journal.i10Index.toLocaleString(), getString('pane-hint-i10-index')),
    )
  }
  const inDoaj = journal?.isInDoaj ?? record.sourceIsInDoaj
  body.append(
    row(
      doc,
      getString('pane-label-doaj'),
      getString(inDoaj ? 'pane-value-yes' : 'pane-value-no'),
      getString('pane-hint-doaj'),
    ),
  )
  if (journal?.apcUsd !== null && journal?.apcUsd !== undefined && !record.apc) {
    body.append(
      row(doc, getString('pane-label-apc'), `${journal.apcUsd.toLocaleString()} USD`, getString('pane-hint-apc')),
    )
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

/** One reference, from whichever source resolved it. */
interface PaneReference {
  title: string | null
  doi: string | null
  year: number | null
  citedByCount: number | null
}

/**
 * What this work cites, which of it the user already has, and how heavily each
 * cited work is itself cited.
 *
 * Semantic Scholar first: measured across five papers it resolves consistently
 * more than OpenAlex. But publishers can tell it not to serve references
 * through the API -- IOP does, and the response says so outright while the
 * website shows them anyway -- so OpenAlex is the fallback, and for one such
 * paper it returned all 17 where S2 returned none.
 */
function renderReferences(doc: Document, body: HTMLElement, data: PaneData): void {
  const s2 = data.s2
  const refs = data.references
  const known = s2?.referenceCount ?? data.record?.referencedWorksCount ?? null

  if (refs.length === 0 && known === null) return

  body.append(heading(doc, getString('pane-heading-references')))

  if (refs.length === 0) {
    const note = el(
      doc,
      'div',
      undefined,
      s2?.elidedByPublisher
        ? getString('pane-references-elided', { args: { count: known ?? 0 } })
        : getString('pane-references-none'),
    )
    note.style.cssText = 'opacity:.7;line-height:1.35;padding:1px 0'
    body.append(note)
    return
  }

  const held = new Set<PaneReference>(
    refs.filter((ref) => ref.doi !== null && data.inLibrary.has(normalizeDoi(ref.doi))),
  )
  body.append(
    row(doc, getString('pane-label-references'), String(known ?? refs.length), getString('pane-hint-references')),
  )
  if (held.size > 0) body.append(row(doc, getString('pane-label-references-held'), String(held.size)))

  // Held first, then by how often each is cited: the ones worth opening rise
  // to the top instead of arriving in whatever order the source listed them.
  const ordered = [...refs].sort((a, b) => {
    const heldDiff = Number(held.has(b)) - Number(held.has(a))
    if (heldDiff !== 0) return heldDiff
    return (b.citedByCount ?? -1) - (a.citedByCount ?? -1)
  })

  const list = el(doc, 'div')
  list.style.cssText = 'margin-top:3px'
  for (const ref of ordered.slice(0, REFERENCES_SHOWN)) {
    const line = el(doc, 'div')
    line.style.cssText = 'display:flex;align-items:baseline;gap:6px;padding:1px 0;line-height:1.35'

    const mark = el(doc, 'span', undefined, held.has(ref) ? '\u2713' : '')
    mark.style.cssText = 'flex:none;width:9px;opacity:.65'
    if (held.has(ref)) mark.setAttribute('title', getString('pane-reference-in-library'))

    const label = `${ref.title ?? ref.doi ?? ''}${ref.year ? ` (${ref.year})` : ''}`
    const itemID = ref.doi ? data.inLibrary.get(normalizeDoi(ref.doi)) : undefined
    let name: HTMLElement
    if (itemID !== undefined) {
      // Selecting rather than opening: the point is to land on it in the
      // library, where everything else about it already is.
      name = el(doc, 'a', undefined, label)
      name.style.cursor = 'pointer'
      name.addEventListener('click', (event) => {
        event.preventDefault()
        void Zotero.getActiveZoteroPane()?.selectItem(itemID)
      })
    } else if (ref.doi) {
      name = link(doc, label, `https://doi.org/${ref.doi}`)
    } else {
      name = el(doc, 'span', undefined, label)
      name.style.opacity = '0.75'
    }
    name.style.flex = '1'
    name.style.minWidth = '0'

    const count = el(doc, 'span', undefined, ref.citedByCount === null ? '' : ref.citedByCount.toLocaleString())
    count.style.cssText = 'flex:none;opacity:.6;font-variant-numeric:tabular-nums'
    if (ref.citedByCount !== null) count.setAttribute('title', getString('pane-reference-cited-by'))

    line.append(mark, name, count)
    list.append(line)
  }
  body.append(list)

  const rest = ordered.length - REFERENCES_SHOWN
  if (rest > 0) {
    const more = el(doc, 'div', undefined, getString('pane-references-more', { args: { count: rest } }))
    more.style.cssText = 'opacity:.6;font-size:11px;padding:2px 0'
    body.append(more)
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

  renderCounts(doc, body, item, data)

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
  renderReferences(doc, body, data)
  renderFunding(doc, body, record)
}

async function loadData(item: Zotero.Item, force: boolean): Promise<PaneData> {
  const identifiers = Helpers.getAllItemIdentifiers(item)
  if (identifiers.length === 0) return emptyPaneData()

  const record = await fetchScholarlyRecord(identifiers, { force })
  const journal = record?.sourceId ? await fetchJournalMetrics(record.sourceId, { force }) : null

  // Written by the count path on its own lookup, so the pane pays nothing for
  // it -- and finds nothing until that lookup has run at least once.
  const s2 =
    toS2PaperRefs(identifiers)
      // Derived with toS2PaperRefs rather than rebuilt here: the client writes
      // under the ref it actually queried, which percent-encodes the id and
      // flips arXiv DOIs to the ARXIV scheme. Reconstructing that by hand
      // matches for a plain DOI and silently misses for everything else.
      .map((ref) => readCache<S2Details>(s2DetailsCacheKey(ref.paperId)))
      .find((found) => found !== null) ?? null

  // Semantic Scholar first, OpenAlex when it comes back empty -- which happens
  // both when it genuinely has nothing and when a publisher has told it not to
  // serve the list. Either way the fallback is the same.
  let references: PaneReference[] = (s2?.references ?? []).map((ref) => ({
    title: ref.title,
    doi: ref.doi,
    year: ref.year,
    citedByCount: ref.citedByCount,
  }))
  if (references.length === 0 && record) {
    references = (await fetchReferences(record, { force })).map((ref) => ({
      title: ref.title,
      doi: ref.doi,
      year: ref.year,
      citedByCount: ref.citedByCount,
    }))
  }

  const inLibrary = references.length > 0 ? await getDoiIndex(item.libraryID) : new Map<string, number>()
  return { record, journal, s2, references, inLibrary }
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
        renderInto(doc, body, item, emptyPaneData())
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
        onClick: ({ doc, body, item, setSectionSummary, setSectionButtonStatus }) => {
          void (async () => {
            // Disabled for the duration: these are network round trips to four
            // providers, and a second click would start a second set of them.
            setSectionButtonStatus('citationtally-refresh', { disabled: true })
            body.replaceChildren(el(doc, 'div', undefined, getString('pane-refreshing')))
            try {
              // Both halves, in the order the pane reads them. Refetching only
              // the OpenAlex record -- which is all this button used to do --
              // left the four counts exactly as they were, which is not what
              // anyone means by refreshing citation details.
              await updateItem(item)
              const data = await loadData(item, true)
              renderInto(doc, body, item, data)
              const summary = Core.getStoredCountsByDatabase(item)
                .map((entry) => String(entry.count))
                .join(' / ')
              if (summary) setSectionSummary(summary)
            } catch (err) {
              debugLog('Citation debug - Item pane refresh failed:', err)
              body.replaceChildren(el(doc, 'div', undefined, getString('pane-refresh-failed')))
            } finally {
              setSectionButtonStatus('citationtally-refresh', { disabled: false })
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
        renderInto(doc, body, item, emptyPaneData())
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
