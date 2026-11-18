/**
 * Where a work filed from a single-paper graph can go, as the list the
 * picker shows.
 *
 * A single-paper graph has no collection of its own, so the reader picks one
 * on every import: the library itself, or any collection in it, each shown
 * with its parents so two "Methods" collections stay apart.
 */

export interface CollectionInfo {
  id: number
  name: string
  parentID: number | null
}

export interface ImportChoice {
  /** null: the library itself, outside any collection. */
  collectionID: number | null
  label: string
}

/**
 * The library first, then every collection by its path ("Parent › Child"),
 * in alphabetical order. The preferred collection -- the one open in Zotero --
 * goes to the very top, since the picker starts on the first entry.
 */
export function importChoices(
  libraryName: string,
  collections: readonly CollectionInfo[],
  preferred: number | null = null,
): ImportChoice[] {
  const byId = new Map(collections.map((collection) => [collection.id, collection]))
  const pathOf = (collection: CollectionInfo): string => {
    const names: string[] = []
    const seen = new Set<number>()
    let current: CollectionInfo | undefined = collection
    // A parent outside the list ends the path; a cycle never should, but must not hang.
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      names.unshift(current.name)
      current = current.parentID === null ? undefined : byId.get(current.parentID)
    }
    return names.join(' › ')
  }

  const entries = collections
    .map((collection) => ({ collectionID: collection.id, label: pathOf(collection) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.collectionID - b.collectionID)
  const choices: ImportChoice[] = [{ collectionID: null, label: libraryName }, ...entries]

  const top = choices.findIndex((choice) => choice.collectionID === preferred && preferred !== null)
  if (top > 0) choices.unshift(...choices.splice(top, 1))
  return choices
}
