/**
 * The gaps list: works the analysed items lean on that the library lacks.
 *
 * A gap is only interesting with its reasons beside it -- which of the user's
 * items cite it, and how much that says given how cited it is anyway -- so
 * each row carries its score with an explanation and expands to the items
 * behind it. Importing is offered in place, one row at a time; what an import
 * does, and whether to ask first, is the caller's (see doiImport.ts).
 *
 * The graph tab is a XUL document, so every element is created in the XHTML
 * namespace, as in citationPane.ts.
 */

import { getString } from '../utils/locale'

import { authorLine, formatScore, GAP_SORTS, gapSections, mostReferenced, seedsOfGap, sortGaps } from './gapsPanel.core'

import type { CollectionNetwork, Gap, NetworkWork, OpenAlexId } from './collectionTypes'
import type { ImportOutcome } from './doiImport'
import type { GapSort, ReferencedWork } from './gapsPanel.core'

export interface GapsPanelHandlers {
  /** False hides every Import button: a read-only library, or nowhere to import to. */
  canImport: boolean
  /** Runs the import, confirmation included. Should resolve, not reject; a rejection reads as 'error'. */
  onImport: (gap: Gap) => Promise<ImportOutcome>
  onFocus: (openAlexId: OpenAlexId) => void
  onShowItem: (itemID: number) => void
  /**
   * The clusters whose items cite a work, in the graph's colours, largest
   * share first. Drawn as dots before the byline, so a row says which topic
   * it belongs to the way its mark does. Optional: without it, no dots.
   */
  clustersOf?: (seeds: readonly OpenAlexId[]) => { colour: string; label: string; count: number }[]
  /**
   * The colour of the picked cluster a work belongs to, or null when no
   * cluster is picked or none of the picked ones cites it. Drawn as a light
   * wash behind the card.
   */
  highlightOf?: (seeds: readonly OpenAlexId[]) => string | null
  /**
   * With clusters picked: whether the list holds only their works, or all
   * works with theirs highlighted. Absent, no switch is shown.
   */
  scope?: { filtered: boolean; onChange: (filtered: boolean) => void }
  /**
   * The reader's choices, kept by the caller so a redraw (a cluster picked,
   * the scope switched) does not throw them away. The panel writes into it.
   */
  state?: { view?: 'missing' | 'referenced'; sort?: GapSort }
}

/** Dots in the clusters' colours, one per cluster citing the work. */
function clusterDots(doc: Document, seeds: readonly OpenAlexId[], handlers: GapsPanelHandlers): HTMLElement[] {
  const clusters = handlers.clustersOf?.(seeds) ?? []
  if (clusters.length === 0) return []
  const wrap = el(doc, 'span', 'orbit-gap-clusters')
  wrap.style.cssText = 'display:inline-flex;gap:3px;margin-right:6px;vertical-align:middle'
  for (const cluster of clusters) {
    const dot = el(doc, 'span', 'orbit-gap-cluster')
    dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${cluster.colour}`
    dot.setAttribute('title', `${cluster.label} (${cluster.count})`)
    wrap.append(dot)
  }
  return [wrap]
}

/** Spelled out, not built from the reason, so every id is findable in the source. */
const FAILURE_MESSAGES = {
  'read-only': 'import-failed-read-only',
  'no-translator': 'import-failed-no-translator',
  'no-result': 'import-failed-no-result',
  'error': 'import-failed-error',
} as const

const XHTML_NS = 'http://www.w3.org/1999/xhtml'

function el(doc: Document, tag: string, className?: string, text?: string): HTMLElement {
  const node = doc.createElementNS(XHTML_NS, tag) as HTMLElement
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Text that acts like a link: styled as one, reachable by keyboard. */
function link(doc: Document, text: string, onActivate: () => void, className?: string): HTMLElement {
  const node = el(doc, 'span', className, text)
  node.setAttribute('role', 'link')
  node.setAttribute('tabindex', '0')
  node.style.cssText = 'cursor:pointer;text-decoration:underline;text-decoration-style:dotted'
  node.addEventListener('click', onActivate)
  node.addEventListener('keydown', (event: Event) => {
    const key = (event as KeyboardEvent).key
    if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      onActivate()
    }
  })
  return node
}

/** A heading that shows and hides `body`. Collapsed when `open` is false. */
function disclosure(doc: Document, label: string, body: HTMLElement, open: boolean, className: string): HTMLElement {
  const setOpen = (node: HTMLElement, value: boolean) => {
    body.style.display = value ? '' : 'none'
    node.textContent = `${value ? '▾' : '▸'} ${label}`
    node.setAttribute('aria-expanded', String(value))
  }
  const toggle = link(doc, '', () => setOpen(toggle, body.style.display === 'none'), className)
  toggle.style.cssText = 'cursor:pointer;user-select:none'
  setOpen(toggle, open)
  return toggle
}

/** The neutral tints the panel is drawn with: readable on a light tab and a dark one. */
const TINT = {
  card: 'rgba(127,127,127,.07)',
  cardHover: 'rgba(127,127,127,.14)',
  chip: 'rgba(127,127,127,.16)',
  line: 'rgba(127,127,127,.25)',
} as const

/** How many rows get a filled badge: the ten the graph numbers on its marks. */
const NUMBERED = 10

export function renderGapsPanel(doc: Document, net: CollectionNetwork, handlers: GapsPanelHandlers): HTMLElement {
  const root = el(doc, 'div', 'orbit-gaps')
  root.style.cssText = 'display:flex;flex-direction:column;gap:10px;font-size:12px;line-height:1.4'

  const referenced = mostReferenced(net)
  const missingView = el(doc, 'div', 'orbit-gaps-view-missing')
  missingView.style.cssText = 'display:flex;flex-direction:column;gap:12px'
  const referencedView = el(doc, 'div', 'orbit-gaps-view-referenced')
  referencedView.style.cssText = 'display:none;flex-direction:column;gap:6px'

  root.append(
    viewSwitch(
      doc,
      [
        { id: 'missing', label: getString('gaps-view-missing', { args: { count: net.gaps.length } }) },
        { id: 'referenced', label: getString('gaps-view-referenced', { args: { count: referenced.length } }) },
      ],
      (id) => {
        missingView.style.display = id === 'missing' ? 'flex' : 'none'
        referencedView.style.display = id === 'referenced' ? 'flex' : 'none'
        if (handlers.state) handlers.state.view = id === 'referenced' ? 'referenced' : 'missing'
      },
      handlers.state?.view,
    ),
  )
  if (handlers.scope) root.append(scopeSwitch(doc, handlers.scope))

  const { reference, citing } = gapSections(net.gaps)
  if (!reference.length && !citing.length) {
    const empty = el(doc, 'div', 'orbit-gaps-empty', getString('gaps-empty'))
    empty.style.opacity = '0.7'
    missingView.append(empty)
  } else {
    const lists: { list: HTMLElement; gaps: Gap[] }[] = []
    const rows = new Map<OpenAlexId, HTMLElement>()
    const addSection = (direction: Gap['direction'], gaps: Gap[]): void => {
      const built = section(doc, net, direction, gaps, handlers, rows)
      lists.push({ list: built.list, gaps })
      missingView.append(built.wrap)
    }
    const applySort = (sort: GapSort): void => {
      if (handlers.state) handlers.state.sort = sort
      // The rows are moved, not rebuilt: an import running or done in a row
      // keeps its state, and the rank on each row stays its score rank, the
      // number the graph shows on the mark.
      for (const { list, gaps } of lists) {
        for (const gap of sortGaps(gaps, sort)) {
          const row = rows.get(gap.openAlexId)
          if (row) list.append(row)
        }
      }
    }
    const kept = handlers.state?.sort
    missingView.append(sortControl(doc, applySort, kept))
    if (reference.length) addSection('reference', reference)
    if (citing.length) addSection('citing', citing)
    // A redraw keeps the order the reader chose.
    if (kept && kept !== 'score') applySort(kept)
  }
  if (net.probable.length) missingView.append(probableSection(doc, net.probable, handlers))

  renderReferenced(doc, net, referenced, handlers, referencedView)
  root.append(missingView, referencedView)
  return root
}

/** Two or more views, one shown: a segmented control rather than tabs inside a tab. */
function viewSwitch(
  doc: Document,
  views: { id: string; label: string }[],
  onChoose: (id: string) => void,
  initial: string = views[0].id,
): HTMLElement {
  const wrap = el(doc, 'div', 'orbit-gaps-views')
  wrap.setAttribute('role', 'tablist')
  wrap.style.cssText = `display:flex;border:1px solid ${TINT.line};border-radius:7px;overflow:hidden;flex:none`
  const buttons: HTMLElement[] = []
  const select = (id: string): void => {
    for (const button of buttons) {
      const on = button.getAttribute('data-view') === id
      button.setAttribute('aria-selected', String(on))
      button.style.background = on ? TINT.chip : 'transparent'
      button.style.fontWeight = on ? '600' : '400'
    }
    onChoose(id)
  }
  for (const view of views) {
    const button = el(doc, 'button', 'orbit-gaps-view', view.label)
    button.setAttribute('role', 'tab')
    button.setAttribute('data-view', view.id)
    button.style.cssText =
      'flex:1;border:0;padding:5px 8px;font:inherit;font-size:12px;color:inherit;cursor:pointer;background:transparent'
    button.addEventListener('click', () => select(view.id))
    buttons.push(button)
    wrap.append(button)
  }
  select(views.some((view) => view.id === initial) ? initial : views[0].id)
  return wrap
}

/** A row as a card: tinted, a little lighter under the pointer. */
function card(doc: Document, tag: string, className: string): HTMLElement {
  const row = el(doc, tag, className)
  row.style.cssText =
    `display:flex;gap:9px;align-items:flex-start;padding:8px 9px;border-radius:8px;background-color:${TINT.card};` +
    'transition:background-color .12s'
  // The colour only, so a cluster highlight laid over it as an image stays.
  row.addEventListener('mouseenter', () => (row.style.backgroundColor = TINT.cardHover))
  row.addEventListener('mouseleave', () => (row.style.backgroundColor = TINT.card))
  return row
}

/** `#rrggbb` at an opacity; anything else unchanged, at full strength. */
function withAlpha(colour: string, alpha: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour)
  if (!match) return colour
  const [r, g, b] = match.slice(1).map((hex) => Number.parseInt(hex, 16))
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * A light wash of a picked cluster's colour behind the card, and a stripe of
 * it down the left edge: the row belongs to the topic picked in the legend.
 */
function highlight(row: HTMLElement, seeds: readonly OpenAlexId[], handlers: GapsPanelHandlers): void {
  const colour = handlers.highlightOf?.(seeds)
  if (!colour) return
  const wash = withAlpha(colour, 0.13)
  row.style.backgroundImage = `linear-gradient(${wash},${wash})`
  row.style.boxShadow = `inset 3px 0 0 ${colour}`
  row.setAttribute('data-highlight', colour)
}

/** The rank in a round badge; filled for the first ten, as the graph numbers them. */
function badge(doc: Document, rank: number, className: string): HTMLElement {
  const node = el(doc, 'span', className, String(rank))
  const filled = rank <= NUMBERED
  node.style.cssText =
    'flex:none;min-width:22px;height:22px;padding:0 4px;box-sizing:border-box;border-radius:11px;display:flex;' +
    'align-items:center;justify-content:center;font-size:11px;font-weight:700;border:1.5px solid currentColor;' +
    (filled ? `background:${TINT.chip};opacity:.95` : 'opacity:.55')
  return node
}

/** A small rounded figure: "3,052 citations", "67 references". */
function chip(doc: Document, className: string, text: string): HTMLElement {
  const node = el(doc, 'span', className, text)
  node.style.cssText = `background:${TINT.chip};border-radius:9px;padding:0 7px;font-size:11px;white-space:nowrap`
  return node
}

/** Title, then "Author · Year", the way the graph labels the mark. */
function heading(doc: Document, work: Pick<Gap, 'title' | 'openAlexId' | 'authors' | 'year'>, onFocus: () => void) {
  const title = link(doc, work.title || work.openAlexId, onFocus, 'orbit-gap-title')
  title.style.cssText +=
    ';font-weight:600;text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;' +
    'overflow:hidden'
  title.setAttribute('title', work.title)
  const byline = el(doc, 'div', 'orbit-gap-byline')
  byline.style.cssText = 'opacity:.72;margin-top:1px'
  const parts = [...authorSpan(doc, work)]
  const year = el(
    doc,
    'span',
    'orbit-gap-year',
    work.year === null ? getString('gaps-year-unknown') : String(work.year),
  )
  if (parts.length) parts.push(el(doc, 'span', undefined, ' · '))
  parts.push(year)
  byline.append(...parts)
  return { title, byline }
}

/** The citation and reference counts as chips; the gap's score beside them when it has one. */
function figures(doc: Document, work: Pick<Gap, 'citedByCount' | 'referenceCount'>, score?: number): HTMLElement {
  const meta = el(doc, 'div', 'orbit-gap-meta')
  meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:5px'
  meta.append(
    chip(
      doc,
      'orbit-gap-cited',
      work.citedByCount === null
        ? getString('gaps-citations-unknown')
        : getString('gaps-citations', { args: { count: work.citedByCount } }),
    ),
  )
  if (work.referenceCount !== null) {
    meta.append(
      chip(doc, 'orbit-gap-references', getString('gaps-references', { args: { count: work.referenceCount } })),
    )
  }
  if (score !== undefined) {
    const scoreChip = chip(doc, 'orbit-gap-score', getString('gaps-score', { args: { score: formatScore(score) } }))
    scoreChip.setAttribute('title', getString('gaps-score-hint'))
    scoreChip.style.cursor = 'help'
    meta.append(scoreChip)
  }
  return meta
}

/** "cited by 24 of your items", opening onto their titles. */
function citedBy(
  doc: Document,
  net: CollectionNetwork,
  seedIds: readonly OpenAlexId[],
  direction: Gap['direction'],
  handlers: GapsPanelHandlers,
): HTMLElement[] {
  const seeds = seedsOfGap({ seeds: [...seedIds] }, net)
  const seedList = el(doc, 'ul', 'orbit-gap-seeds')
  seedList.style.cssText = 'margin:3px 0 0;padding-left:16px'
  for (const seed of seeds) {
    const entry = el(doc, 'li')
    entry.append(link(doc, seed.title || seed.openAlexId, () => handlers.onShowItem(seed.itemID), 'orbit-gap-seed'))
    seedList.append(entry)
  }
  const count = seedIds.length
  const toggle = disclosure(
    doc,
    getString(direction === 'reference' ? 'gaps-cited-by' : 'gaps-cites', { args: { count } }),
    seedList,
    false,
    'orbit-gap-seeds-toggle',
  )
  toggle.setAttribute('data-count', String(count))
  const line = el(doc, 'div')
  line.style.cssText = 'opacity:.72;margin-top:4px'
  line.append(toggle)
  return [line, seedList]
}

/** The "most referenced" view: what the collection rests on, held or not. */
function renderReferenced(
  doc: Document,
  net: CollectionNetwork,
  works: ReferencedWork[],
  handlers: GapsPanelHandlers,
  into: HTMLElement,
): void {
  const intro = el(doc, 'div', 'orbit-referenced-intro', getString('referenced-intro'))
  intro.style.cssText = 'opacity:.72'
  into.append(intro)
  if (works.length === 0) {
    const empty = el(doc, 'div', 'orbit-referenced-empty', getString('referenced-empty'))
    empty.style.opacity = '0.7'
    into.append(empty)
    return
  }
  const gaps = new Map(net.gaps.map((gap) => [gap.openAlexId, gap]))
  const list = el(doc, 'ol', 'orbit-referenced-list')
  list.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px'
  for (const work of works) {
    const row = card(doc, 'li', 'orbit-referenced')
    row.setAttribute('data-openalex', work.openAlexId)
    row.setAttribute('data-held', work.held ?? 'none')
    const body = el(doc, 'div', 'orbit-gap-body')
    body.style.cssText = 'flex:1;min-width:0'
    const { title, byline } = heading(doc, work, () => handlers.onFocus(work.openAlexId))
    byline.prepend(...clusterDots(doc, work.seeds, handlers))
    body.append(title, byline, figures(doc, work), ...citedBy(doc, net, work.seeds, 'reference', handlers))
    row.append(badge(doc, work.rank, 'orbit-referenced-rank'), body)
    highlight(row, work.seeds, handlers)

    const gap = gaps.get(work.openAlexId)
    if (work.held !== null && work.itemID !== null) {
      row.append(heldControl(doc, work.held, work.itemID, handlers))
    } else if (gap && handlers.canImport && gap.doi) {
      row.append(importControl(doc, gap, handlers))
    }
    list.append(row)
  }
  into.append(list)
}

/** Where a held work is: in the library (or one of the analysed items), with a way to it. */
function heldControl(
  doc: Document,
  held: NonNullable<ReferencedWork['held']>,
  itemID: number,
  handlers: GapsPanelHandlers,
): HTMLElement {
  const wrap = el(doc, 'div', 'orbit-referenced-held')
  wrap.style.cssText = 'flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:11px'
  const label = {
    seed: 'referenced-held-seed',
    exact: 'referenced-held-exact',
    probable: 'referenced-held-probable',
  } as const
  const state = el(doc, 'span', 'orbit-referenced-state', getString(label[held]))
  state.style.cssText = 'opacity:.8;white-space:nowrap'
  wrap.append(
    state,
    link(doc, getString('gaps-show-item'), () => handlers.onShowItem(itemID), 'orbit-gaps-show-item'),
  )
  return wrap
}

/** The authors as a reference list names them; nothing when none are known. */
function authorSpan(doc: Document, gap: Pick<Gap, 'authors'>): HTMLElement[] {
  const line = authorLine(gap.authors)
  let text: string
  switch (line.kind) {
    case 'none':
      return []
    case 'one':
      text = line.first
      break
    case 'two':
      text = getString('gaps-authors-two', { args: { first: line.first, second: line.second } })
      break
    case 'many':
      text = getString('gaps-authors-many', { args: { first: line.first } })
      break
  }
  const span = el(doc, 'span', 'orbit-gap-authors', text)
  // The full list on hover, for when the first name is not enough.
  if (gap.authors.length > 1) span.setAttribute('title', gap.authors.join(', '))
  return [span]
}

/** Written out, not built from the sort name, so each string is findable. */
const SORT_LABEL = {
  score: 'gaps-sort-score',
  year: 'gaps-sort-year',
  citations: 'gaps-sort-citations',
  references: 'gaps-sort-references',
} as const satisfies Record<GapSort, string>

/** "Sort by" with the four orders; calls back with the one chosen. */
/** "Only the picked clusters" as a checkbox; unticked, every work shows and theirs are highlighted. */
function scopeSwitch(doc: Document, scope: NonNullable<GapsPanelHandlers['scope']>): HTMLElement {
  const wrap = el(doc, 'label', 'orbit-gaps-scope')
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;opacity:.85;cursor:pointer'
  const box = el(doc, 'input', 'orbit-gaps-scope-box') as HTMLInputElement
  box.setAttribute('type', 'checkbox')
  box.checked = scope.filtered
  box.addEventListener('change', () => scope.onChange(box.checked))
  wrap.append(box, el(doc, 'span', undefined, getString('gaps-scope-picked')))
  return wrap
}

function sortControl(doc: Document, onSort: (sort: GapSort) => void, initial?: GapSort): HTMLElement {
  const wrap = el(doc, 'label', 'orbit-gaps-sort')
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;opacity:.85'
  wrap.append(el(doc, 'span', undefined, getString('gaps-sort-label')))
  const select = el(doc, 'select', 'orbit-gaps-sort-select') as HTMLSelectElement
  select.style.cssText = 'font:inherit;font-size:12px'
  for (const sort of GAP_SORTS) {
    const option = el(doc, 'option', undefined, getString(SORT_LABEL[sort])) as HTMLOptionElement
    option.value = sort
    select.append(option)
  }
  if (initial) select.value = initial
  select.addEventListener('change', () => onSort(select.value as GapSort))
  wrap.append(select)
  return wrap
}

function section(
  doc: Document,
  net: CollectionNetwork,
  direction: Gap['direction'],
  gaps: Gap[],
  handlers: GapsPanelHandlers,
  rows: Map<OpenAlexId, HTMLElement>,
): { wrap: HTMLElement; list: HTMLElement } {
  const wrap = el(doc, 'section', 'orbit-gaps-section')
  wrap.setAttribute('data-direction', direction)
  const heading = el(
    doc,
    'div',
    'orbit-gaps-heading',
    getString(direction === 'reference' ? 'gaps-heading-reference' : 'gaps-heading-citing'),
  )
  heading.style.cssText = 'font-weight:600;margin:0 0 6px;font-size:12px;opacity:.85'
  wrap.append(heading)
  const list = el(doc, 'ol', 'orbit-gaps-list')
  list.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px'
  for (const gap of gaps) {
    const row = gapRow(doc, net, gap, handlers)
    rows.set(gap.openAlexId, row)
    list.append(row)
  }
  wrap.append(list)
  return { wrap, list }
}

function gapRow(doc: Document, net: CollectionNetwork, gap: Gap, handlers: GapsPanelHandlers): HTMLElement {
  const row = card(doc, 'li', 'orbit-gap')
  row.setAttribute('data-openalex', gap.openAlexId)
  row.setAttribute('data-rank', String(gap.rank))

  const body = el(doc, 'div', 'orbit-gap-body')
  body.style.cssText = 'flex:1;min-width:0'
  const { title, byline } = heading(doc, gap, () => handlers.onFocus(gap.openAlexId))
  byline.prepend(...clusterDots(doc, gap.seeds, handlers))
  body.append(title, byline, figures(doc, gap, gap.score), ...citedBy(doc, net, gap.seeds, gap.direction, handlers))

  row.append(badge(doc, gap.rank, 'orbit-gap-rank'), body)
  highlight(row, gap.seeds, handlers)
  if (handlers.canImport && gap.doi) row.append(importControl(doc, gap, handlers))
  return row
}

function importControl(doc: Document, gap: Gap, handlers: GapsPanelHandlers): HTMLElement {
  const wrap = el(doc, 'div', 'orbit-gap-import-wrap')
  wrap.style.cssText = 'flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px'
  const button = el(doc, 'button', 'orbit-gap-import', getString('import-button')) as HTMLButtonElement
  button.style.cssText =
    `font:inherit;font-size:11px;padding:2px 9px;border-radius:9px;border:1px solid ${TINT.line};` +
    'background:transparent;color:inherit;cursor:pointer;white-space:nowrap'
  button.setAttribute('data-state', 'idle')
  button.setAttribute('title', getString('import-button-hint', { args: { doi: gap.doi ?? '' } }))
  const note = el(doc, 'span', 'orbit-gap-import-error')
  note.style.cssText = 'font-size:11px;opacity:.75;max-width:16em;text-align:right'
  note.style.display = 'none'

  button.addEventListener('click', () => {
    if (button.disabled) return
    button.disabled = true
    button.setAttribute('data-state', 'running')
    button.textContent = getString('import-running')
    note.style.display = 'none'
    void handlers
      .onImport(gap)
      .catch((error: unknown): ImportOutcome => ({
        status: 'failed',
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      }))
      .then((outcome) => {
        if (outcome.status === 'cancelled') {
          button.disabled = false
          button.setAttribute('data-state', 'idle')
          button.textContent = getString('import-button')
          return
        }
        if (outcome.status === 'failed') {
          button.disabled = false
          button.setAttribute('data-state', 'failed')
          button.textContent = getString('import-button')
          note.textContent = getString(FAILURE_MESSAGES[outcome.reason])
          if (outcome.message) note.setAttribute('title', outcome.message)
          note.style.display = ''
          return
        }
        // Stays disabled: the work is in the library now, and a second click
        // could only file it again.
        button.setAttribute('data-state', 'done')
        button.setAttribute('data-item-id', String(outcome.itemID))
        button.textContent = getString('import-done')
      })
  })
  wrap.append(button, note)
  return wrap
}

function probableSection(doc: Document, probable: NetworkWork[], handlers: GapsPanelHandlers): HTMLElement {
  const wrap = el(doc, 'section', 'orbit-gaps-probable')
  wrap.setAttribute('data-count', String(probable.length))
  const list = el(doc, 'ul', 'orbit-gaps-probable-list')
  list.style.cssText = 'list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:4px'
  for (const work of probable) {
    const entry = el(doc, 'li', 'orbit-gaps-probable-item')
    entry.setAttribute('data-openalex', work.openAlexId)
    entry.style.cssText = 'display:flex;gap:8px;justify-content:space-between;align-items:baseline'
    const label = el(doc, 'span', undefined, work.year === null ? work.title : `${work.title} (${work.year})`)
    entry.append(label)
    const match = work.match
    if (match) {
      entry.append(
        link(doc, getString('gaps-show-item'), () => handlers.onShowItem(match.itemID), 'orbit-gaps-show-item'),
      )
    }
    list.append(entry)
  }
  const toggle = disclosure(
    doc,
    getString('gaps-probable-heading', { args: { count: probable.length } }),
    list,
    false,
    'orbit-gaps-probable-toggle',
  )
  toggle.setAttribute('title', getString('gaps-probable-hint'))
  toggle.style.fontWeight = '600'
  wrap.append(toggle, list)
  return wrap
}
