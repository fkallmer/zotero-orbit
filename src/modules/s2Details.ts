/**
 * Cache addressing for the Semantic Scholar extras.
 *
 * Its own module so the Zotero-bound client and the item pane agree on the key
 * without either importing the other: the client writes on every count lookup,
 * the pane reads.
 */

/** `identifier` is the paper ref the client queried, e.g. `DOI:10.3390/s19133005`. */
export function s2DetailsCacheKey(identifier: string): string {
  return `s2:${identifier.toLowerCase()}`
}
