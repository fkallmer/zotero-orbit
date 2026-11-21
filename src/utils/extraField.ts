/**
 * Reading and rewriting the citation lines this plugin stores in an item's
 * Extra field.
 *
 * Extracted from `citationCounts.ts` so the pattern set can be tested directly:
 * the patterns are built from *localized* database names, and two defects lived
 * here undetected because there was no way to exercise them without Zotero.
 *
 * Keep this module free of runtime Zotero dependencies.
 */

/** The line format this plugin writes. */
export function formatCitationLine(title: string, count: number, isoDate: string): string {
  return `Citations: ${count} (${title}) [${isoDate}]`
}

/**
 * Escape a string for literal use inside a `RegExp`.
 *
 * Database display names come from FTL files, so a translator writing
 * `Semantic Scholar (S2)` or `Crossref+` would otherwise inject regex syntax
 * into every pattern below -- changing what they match, or throwing.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every citation-line format this plugin has ever written, so an update can
 * strip the previous line before appending the new one.
 *
 * `databaseTitles` are localized display names and are escaped before
 * interpolation.
 */
export function buildCitationLinePatterns(databaseTitles: readonly string[]): RegExp[] {
  const titlePattern = `(?:${databaseTitles.map((title) => escapeRegExp(title.trim())).join('|')})`
  const date = String.raw`\[\d{4}-\d{1,2}-\d{1,2}\]`

  return [
    // Current format.
    new RegExp(String.raw`^Citations: *\d+ *\(${titlePattern}\) *${date}`, 'i'),
    // A stamp whose source label is empty. No provider is called "", so such a
    // line can only come from a dispatch branch that forgot to resolve its
    // display name. It matches no title, so without this it would survive every
    // later update and sit in the Extra field forever.
    new RegExp(String.raw`^Citations: *\d+ *\( *\) *${date}`, 'i'),
    // Legacy formats, oldest last.
    new RegExp(String.raw`^Citation *Count: *\d+ *\(${titlePattern}\) *${date}`, 'i'),
    // The `\d+` here was written as `\d+` inside an untagged template literal,
    // where `\d` is an identity escape that cooks to a literal `d`. The pattern
    // therefore compiled as `d+` and matched runs of `d`, never a count, so
    // this legacy line was never stripped and accumulated alongside the
    // rewritten one.
    new RegExp(String.raw`^Citations \(${titlePattern}\): \d+`, 'i'),
    new RegExp(String.raw`^\d+ citations \(${titlePattern}\)`, 'i'),
    new RegExp(String.raw`^\d+ citations \(${titlePattern}\) ${date}`, 'i'),
    // Stamps from the standalone Google Scholar Citation Count plugin, whose
    // job this fork now does natively. Format: `GSCC: 0000068 <iso> <score>`.
    // Left alone they sit in the Extra field of every item that plugin ever
    // touched, next to a Google Scholar line saying the same thing.
    new RegExp(String.raw`^GSCC: *\d+(?:\s.*)?$`, 'i'),
    // Pre-localization names, which were never translated.
    new RegExp(
      String.raw`^\d+ citations \((?:Crossref\/DOI|Inspire\/DOI|Inspire\/arXiv|` +
        String.raw`Semantic Scholar\/DOI|Semantic Scholar\/arXiv)\) ${date}`,
      'i',
    ),
  ]
}

/** Drop every line this plugin recognizes as one of its own citation stamps. */
export function stripCitationLines(
  lines: readonly string[],
  databaseTitles: readonly string[],
): { kept: string[]; removed: string[] } {
  const patterns = buildCitationLinePatterns(databaseTitles)
  const kept: string[] = []
  const removed: string[] = []
  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) {
      removed.push(line)
    } else {
      kept.push(line)
    }
  }
  return { kept, removed }
}

/**
 * Insert `newItem` before the first line matching `pattern`, or append it.
 *
 * Used to keep the citation stamp above a Better BibTeX `Citation Key:` line.
 */
export function insertBeforeMatch(lines: string[], pattern: RegExp, newItem: string): void {
  const index = lines.findIndex((line) => pattern.test(line))
  if (index === -1) {
    lines.push(newItem)
  } else {
    lines.splice(index, 0, newItem)
  }
}

/** Matches a Better BibTeX citation key line. */
export const CITATION_KEY_PATTERN = /^Citation Key: \S+/i

/**
 * Where a new citation line goes: above the `OpenAlex:` line and the citation
 * key, so an update leaves the order of Extra as it found it.
 */
export const CITATION_LINE_ANCHOR = /^(?:Citation Key: \S+|OpenAlex:\s)/i

/**
 * The `OpenAlex: W…` line, in the format Cita and Zotero's own OpenAlex
 * translator use. Orbit writes it when it finds an item's work by title, so the
 * search runs once, and reads it wherever it needs the work. `OpenAlex: none`
 * is the user's way of saying a found work was wrong: no search, no match.
 */
const OPENALEX_LINE = /^OpenAlex:\s*(.*?)\s*$/i

export type OpenAlexLine = { kind: 'id'; id: string } | { kind: 'none' }

/** The OpenAlex line in Extra, if there is a usable one. */
export function readOpenAlexLine(extra: string | null | undefined): OpenAlexLine | null {
  for (const line of (extra ?? '').split('\n')) {
    const match = OPENALEX_LINE.exec(line.trim())
    if (!match) continue
    const value = match[1].replace(/^https?:\/\/openalex\.org\//i, '')
    if (/^none$/i.test(value)) return { kind: 'none' }
    if (/^W\d+$/i.test(value)) return { kind: 'id', id: value.toUpperCase() }
  }
  return null
}

/**
 * Extra with the OpenAlex line set to `id`: an existing line is replaced,
 * otherwise the line goes above a Better BibTeX citation key, or at the end.
 */
/** Extra without its OpenAlex line. */
export function withoutOpenAlexLine(lines: readonly string[]): string[] {
  return lines.filter((line) => !OPENALEX_LINE.test(line.trim()))
}

export function withOpenAlexLine(lines: readonly string[], id: string): string[] {
  const next = lines.filter((line) => !OPENALEX_LINE.test(line.trim()))
  insertBeforeMatch(next, CITATION_KEY_PATTERN, `OpenAlex: ${id}`)
  return next
}
