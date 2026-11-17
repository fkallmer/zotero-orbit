/**
 * Which identifiers make a library item and a cited work the same paper.
 *
 * Pure: the item side takes field strings, not a Zotero item, so `node --test`
 * covers every rule here without a stub.
 *
 * Matching used to be by DOI alone. A reference Semantic Scholar returns
 * without one was never recognised, even with the paper on the shelf, and
 * preprints are where that happens most. arXiv ids and PubMed ids close most
 * of that gap without the false positives a title match would bring, so long
 * as each is read only where it is unambiguous:
 *
 * - **DOI** from the DOI field, or from a `DOI:` line in Extra, which is where
 *   Zotero puts it for item types that have no DOI field.
 * - **arXiv** from `archiveID` (Zotero writes `arXiv:2101.00001` there), from
 *   an arxiv.org URL, from an `arXiv:` line in Extra (with or without the
 *   category the arXiv translator appends), and from the DOI arXiv
 *   mints itself, `10.48550/arXiv.<id>`. Never from a bare number found
 *   somewhere in a text field: a call number or Orbit's own `Citations:` line
 *   would then become an identifier.
 * - **PubMed** from a `PMID:` line in Extra, digits only.
 *
 * Keys are namespaced (`doi:`, `arxiv:`, `pmid:`) so the three share one map
 * and cannot collide.
 */

import { asArxivId, extractArxivIdFromUrl, stripArxivVersion } from '../utils/identifiers.ts'

/** The identifiers a cited work may arrive with. Any of them may be missing. */
export interface WorkIds {
  doi?: string | null
  arxiv?: string | null
  pmid?: string | null
}

/** The fields of a library item that can carry an identifier. */
export interface ItemFields {
  doi?: string
  extra?: string
  archiveID?: string
  url?: string
}

/**
 * DOIs are case-insensitive and travel with assorted prefixes. Both sides of
 * a comparison go through this, so `https://doi.org/10.1/X` and `10.1/x` meet.
 */
export function normalizeDoi(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()
}

/** The DOI arXiv registers for each of its papers carries the arXiv id. */
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i

function arxivKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const id = asArxivId(raw)
  // Versionless and lower-cased: a library holding v1 and a reference to v3
  // are the same paper, and old-style ids are case-insensitive.
  return id ? `arxiv:${stripArxivVersion(id).toLowerCase()}` : null
}

function doiKeys(raw: string | null | undefined): string[] {
  if (!raw) return []
  const doi = normalizeDoi(raw)
  if (doi === '') return []
  const keys = [`doi:${doi}`]
  const arxiv = arxivKey(ARXIV_DOI.exec(doi)?.[1])
  if (arxiv) keys.push(arxiv)
  return keys
}

function pmidKey(raw: string | null | undefined): string | null {
  const id = raw?.trim()
  return id && /^\d+$/.test(id) ? `pmid:${id}` : null
}

/**
 * The value of a `Label: value` line in Extra, one label per line.
 *
 * `suffix` is an optional tail allowed after the value and dropped: Zotero's
 * arXiv translator writes `arXiv:1810.04805 [cs.CL]`, the category in
 * brackets. Anything else after the value rejects the line.
 */
function extraLine(extra: string, label: string, suffix = ''): string | null {
  const tail = suffix ? `(?:[ \\t]+${suffix})?` : ''
  const match = new RegExp(`^${label}:[ \\t]*(\\S+)${tail}[ \\t]*$`, 'im').exec(extra)
  return match ? match[1] : null
}

/** The bracketed category list after an arXiv id: `[cs.CL]`, `[astro-ph.CO]`. */
const ARXIV_CATEGORY = String.raw`\[[^\]\n]*\]`

/** Every key under which this item should be found. */
export function itemKeys(fields: ItemFields): string[] {
  const keys = new Set<string>()
  const add = (key: string | null): void => {
    if (key) keys.add(key)
  }
  const extra = fields.extra ?? ''

  for (const key of doiKeys(fields.doi)) add(key)
  for (const key of doiKeys(extraLine(extra, 'DOI'))) add(key)

  const archive = /^arxiv:\s*(.+)$/i.exec(fields.archiveID?.trim() ?? '')
  add(arxivKey(archive?.[1]))
  add(arxivKey(fields.url ? extractArxivIdFromUrl(fields.url) : null))
  add(arxivKey(extraLine(extra, 'arXiv', ARXIV_CATEGORY)))

  add(pmidKey(extraLine(extra, 'PMID')))
  return [...keys]
}

/** The keys to look a cited work up under, most specific first. */
export function workKeys(ids: WorkIds): string[] {
  const keys = new Set<string>(doiKeys(ids.doi))
  const arxiv = arxivKey(ids.arxiv)
  if (arxiv) keys.add(arxiv)
  const pmid = pmidKey(ids.pmid)
  if (pmid) keys.add(pmid)
  return [...keys]
}

/**
 * The library item a cited work is, or `null`.
 *
 * DOI first, then arXiv, then PubMed. When two of a work's identifiers point
 * at different items -- a preprint and its published version, both on the
 * shelf -- the DOI wins, because it names the exact version that was cited.
 */
export function findInLibrary(index: ReadonlyMap<string, number>, ids: WorkIds): number | null {
  for (const key of workKeys(ids)) {
    const itemID = index.get(key)
    if (itemID !== undefined) return itemID
  }
  return null
}
