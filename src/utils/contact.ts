/**
 * Which address, if any, Orbit names as its operator.
 *
 * Crossref and OpenAlex both run a better-resourced pool for requests that
 * identify whoever is making them -- OpenAlex through a `mailto` parameter,
 * Crossref through the User-Agent. Naming nobody is a supported state: both
 * answer from the common pool, more slowly.
 *
 * The address used to come only from the build, which is wrong for a published
 * plugin in two directions at once. Every user's requests would identify
 * whoever built the release, and the release file itself would carry that
 * person's address to everyone who downloads it. So the preference comes first
 * and the build is only a fallback -- which is what a local build wants, and is
 * empty in a release.
 *
 * Keep this module free of runtime Zotero dependencies.
 */

/** Trim and drop the `mailto:` a user may paste in front of an address. */
export function normalizeContact(raw: string | undefined | null): string {
  return (raw ?? '')
    .trim()
    .replace(/^mailto:/i, '')
    .trim()
}

/**
 * Whether this is worth sending.
 *
 * Deliberately loose -- one `@`, something either side, a dot in the domain, no
 * spaces. The point is not to validate an address but to refuse the things that
 * are certainly not one, because `mailto=Falk` claims a contact and names
 * nobody, which is worse for the provider than an anonymous request.
 */
export function looksLikeContactEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

/**
 * The address to actually send.
 *
 * An empty preference falls back to the build, so a locally built plugin keeps
 * behaving as it did. A preference that is set but unusable resolves to nothing
 * rather than to the fallback: someone who typed an address meant to use theirs,
 * and quietly substituting another would send a stranger's address under their
 * name.
 */
export function effectiveContact(preferred: string | undefined | null, builtIn: string | undefined | null): string {
  const own = normalizeContact(preferred)
  if (own !== '') return looksLikeContactEmail(own) ? own : ''
  const fallback = normalizeContact(builtIn)
  return looksLikeContactEmail(fallback) ? fallback : ''
}

/** What the preferences pane says about the address as typed. */
export type ContactState = 'in-use' | 'unusable' | 'built-in' | 'anonymous'

export function contactState(preferred: string | undefined | null, builtIn: string | undefined | null): ContactState {
  const own = normalizeContact(preferred)
  if (own !== '') return looksLikeContactEmail(own) ? 'in-use' : 'unusable'
  return looksLikeContactEmail(normalizeContact(builtIn)) ? 'built-in' : 'anonymous'
}
