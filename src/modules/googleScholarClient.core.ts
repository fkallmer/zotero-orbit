/**
 * Pure Google Scholar logic: URL construction and HTML parsing.
 *
 * Kept free of Zotero dependencies so `node --test` can exercise it against
 * recorded fixtures, mirroring `semanticScholarClient.core`.
 *
 * Scholar is the odd provider here. It has no API, so this scrapes the search
 * results page, and it identifies works by title and author rather than by DOI
 * or arXiv id. That is exactly why it earns a place next to the others: it is
 * the only source that reaches books, chapters, theses, reports and
 * non-English literature, none of which carry a DOI. The cost is that the
 * result is a best-effort string match, not an identifier lookup, and that
 * Scholar answers sustained traffic with a CAPTCHA.
 */

export const GOOGLE_SCHOLAR_DATABASE = 'googlescholar'

/** Scholar's own label in front of the number we are after. */
export const CITED_BY_PREFIX = 'Cited by'

export interface ScholarQuery {
  /** Base endpoint, e.g. `https://scholar.google.com`. */
  endpoint: string
  title: string
  /** Creator surnames, already ordered as Zotero returns them. */
  authors: readonly string[]
  /** Publication year, if the item has a usable one. */
  year?: number
  /** Match the title loosely instead of as a quoted phrase. */
  fuzzyTitle?: boolean
  /** Add `as_sauthors`, narrowing the search to the first few surnames. */
  matchAuthors?: boolean
  /** Restrict to year +/- 2, for titles that recur across the literature. */
  dateRange?: boolean
}

/** At most this many surnames go into `as_sauthors`; more only hurts recall. */
const MAX_AUTHORS_IN_QUERY = 5

/** How far either side of the publication year `dateRange` reaches. */
const YEAR_RANGE_SLACK = 2

/**
 * Strip HTML from a title.
 *
 * Zotero stores markup in titles (`<i>`, `<sub>`, entities). Passing that to
 * Scholar breaks the phrase match outright, so it has to come out. Callers in
 * a DOM context can hand in a real parser; the regex fallback keeps this
 * module usable from plain Node.
 */
export function stripTitleMarkup(title: string, parse?: (html: string) => string): string {
  const text = parse ? parse(title) : title.replace(/<[^>]*>/g, '')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Build the Scholar search URL.
 *
 * `as_occt=title` restricts matching to titles and `num=1` asks for a single
 * result -- we only ever read the first hit, and a smaller page is a smaller
 * imposition on Scholar.
 */
export function buildScholarUrl(query: ScholarQuery): string {
  const title = stripTitleMarkup(query.title)
  if (!title) throw new Error('Cannot search Google Scholar without a title')

  // An unquoted title matches loosely and routinely returns a different paper.
  // Quoting is the safer default; `fuzzyTitle` is the opt-out for hand-entered
  // records whose titles do not match the published one exactly.
  const titleTerm = query.fuzzyTitle ? title : `"${title}"`

  const params = new URLSearchParams({
    hl: 'en',
    q: titleTerm,
    as_epq: '',
    as_occt: 'title',
    num: '1',
  })

  if (query.matchAuthors && query.authors.length > 0) {
    // Scholar expects surnames joined by `+` in this parameter, not spaces.
    params.set('as_sauthors', query.authors.slice(0, MAX_AUTHORS_IN_QUERY).join('+'))
  }

  if (query.dateRange && Number.isInteger(query.year)) {
    const year = query.year as number
    params.set('as_ylo', String(year - YEAR_RANGE_SLACK))
    params.set('as_yhi', String(year + YEAR_RANGE_SLACK))
  }

  const base = query.endpoint.endsWith('/') ? query.endpoint : `${query.endpoint}/`
  return `${base}scholar?${params.toString()}`
}

/**
 * Did Scholar answer with a CAPTCHA rather than results?
 *
 * The bare script include appears on ordinary pages too; only the `onload`
 * form actually injects the challenge iframe.
 */
export function hasRecaptcha(html: string): boolean {
  return html.includes('google.com/recaptcha/api.js?onload')
}

/** Does the page carry a result block at all? */
export function hasCitationResults(html: string): boolean {
  return (
    html.includes('class="gs_r gs_or gs_scl"') ||
    html.includes('class="gs_fl gs_flb gs_invis"') ||
    html.includes('class="gs_fl gs_flb"')
  )
}

/**
 * Read the citation count out of a Scholar results page.
 *
 * Three outcomes, and the distinction matters to the caller:
 *   - a number: the work was found and Scholar reports that many citations
 *   - `0`: the work was found but carries no "Cited by" link, i.e. uncited
 *   - `null`: no result block at all, so the search matched nothing
 *
 * Conflating the last two is what makes a scraper report "0 citations" for
 * every item it simply failed to find.
 */
export function parseScholarCount(html: string, citedByPrefix: string = CITED_BY_PREFIX): number | null {
  const prefix = `>${citedByPrefix}`
  const start = html.indexOf(prefix)

  if (start === -1) {
    // `gs_rt` marks a result title. Present but no "Cited by" means the work is
    // in Scholar and genuinely uncited.
    return html.includes('class="gs_rt"') ? 0 : null
  }

  const end = html.indexOf('<', start)
  if (end === -1) return null

  const count = Number.parseInt(html.slice(start + prefix.length, end).trim(), 10)
  return Number.isNaN(count) ? null : count
}
