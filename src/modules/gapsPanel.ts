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

import { formatScore, gapSections, seedsOfGap } from './gapsPanel.core'

import type { CollectionNetwork, Gap, NetworkWork, OpenAlexId } from './collectionTypes'
import type { ImportOutcome } from './doiImport'

export interface GapsPanelHandlers {
  /** False hides every Import button: a read-only library, or nowhere to import to. */
  canImport: boolean
  /** Runs the import, confirmation included. Should resolve, not reject; a rejection reads as 'error'. */
  onImport: (gap: Gap) => Promise<ImportOutcome>
  onFocus: (openAlexId: OpenAlexId) => void
  onShowItem: (itemID: number) => void
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

export function renderGapsPanel(doc: Document, net: CollectionNetwork, handlers: GapsPanelHandlers): HTMLElement {
  const root = el(doc, 'div', 'orbit-gaps')
  root.style.cssText = 'display:flex;flex-direction:column;gap:12px;font-size:12px;line-height:1.4'

  const { reference, citing } = gapSections(net.gaps)
  if (!reference.length && !citing.length) {
    const empty = el(doc, 'div', 'orbit-gaps-empty', getString('gaps-empty'))
    empty.style.opacity = '0.7'
    root.append(empty)
  } else {
    if (reference.length) root.append(section(doc, net, 'reference', reference, handlers))
    if (citing.length) root.append(section(doc, net, 'citing', citing, handlers))
  }

  if (net.probable.length) root.append(probableSection(doc, net.probable, handlers))
  return root
}

function section(
  doc: Document,
  net: CollectionNetwork,
  direction: Gap['direction'],
  gaps: Gap[],
  handlers: GapsPanelHandlers,
): HTMLElement {
  const wrap = el(doc, 'section', 'orbit-gaps-section')
  wrap.setAttribute('data-direction', direction)
  const heading = el(
    doc,
    'div',
    'orbit-gaps-heading',
    getString(direction === 'reference' ? 'gaps-heading-reference' : 'gaps-heading-citing'),
  )
  heading.style.cssText = 'font-weight:600;margin:0 0 4px'
  wrap.append(heading)
  const list = el(doc, 'ol', 'orbit-gaps-list')
  list.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px'
  for (const gap of gaps) list.append(gapRow(doc, net, gap, handlers))
  wrap.append(list)
  return wrap
}

function gapRow(doc: Document, net: CollectionNetwork, gap: Gap, handlers: GapsPanelHandlers): HTMLElement {
  const row = el(doc, 'li', 'orbit-gap')
  row.setAttribute('data-openalex', gap.openAlexId)
  row.setAttribute('data-rank', String(gap.rank))
  row.style.cssText = 'display:flex;gap:8px;align-items:baseline'

  const rank = el(doc, 'span', 'orbit-gap-rank', String(gap.rank))
  rank.style.cssText = 'opacity:.6;min-width:2ch;text-align:right;flex:none'

  const body = el(doc, 'div', 'orbit-gap-body')
  body.style.cssText = 'flex:1;min-width:0'
  const title = link(doc, gap.title || gap.openAlexId, () => handlers.onFocus(gap.openAlexId), 'orbit-gap-title')
  body.append(title)

  const meta = el(doc, 'div', 'orbit-gap-meta')
  meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 10px;opacity:.75'
  meta.append(
    el(doc, 'span', 'orbit-gap-year', gap.year === null ? getString('gaps-year-unknown') : String(gap.year)),
    el(
      doc,
      'span',
      'orbit-gap-cited',
      gap.citedByCount === null
        ? getString('gaps-citations-unknown')
        : getString('gaps-citations', { args: { count: gap.citedByCount } }),
    ),
  )
  const score = el(doc, 'span', 'orbit-gap-score', getString('gaps-score', { args: { score: formatScore(gap.score) } }))
  score.setAttribute('title', getString('gaps-score-hint'))
  score.style.cursor = 'help'
  meta.append(score)
  body.append(meta)

  const seeds = seedsOfGap(gap, net)
  const seedList = el(doc, 'ul', 'orbit-gap-seeds')
  seedList.style.cssText = 'margin:2px 0 0;padding-left:16px'
  for (const seed of seeds) {
    const entry = el(doc, 'li')
    entry.append(link(doc, seed.title || seed.openAlexId, () => handlers.onShowItem(seed.itemID), 'orbit-gap-seed'))
    seedList.append(entry)
  }
  const count = gap.seeds.length
  const seedToggle = disclosure(
    doc,
    getString(gap.direction === 'reference' ? 'gaps-cited-by' : 'gaps-cites', { args: { count } }),
    seedList,
    false,
    'orbit-gap-seeds-toggle',
  )
  seedToggle.setAttribute('data-count', String(count))
  const seedLine = el(doc, 'div')
  seedLine.style.opacity = '0.75'
  seedLine.append(seedToggle)
  body.append(seedLine, seedList)

  row.append(rank, body)
  if (handlers.canImport && gap.doi) row.append(importControl(doc, gap, handlers))
  return row
}

function importControl(doc: Document, gap: Gap, handlers: GapsPanelHandlers): HTMLElement {
  const wrap = el(doc, 'div', 'orbit-gap-import-wrap')
  wrap.style.cssText = 'flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px'
  const button = el(doc, 'button', 'orbit-gap-import', getString('import-button')) as HTMLButtonElement
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
