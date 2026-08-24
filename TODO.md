# Open

Orbit's own list. The one this file used to hold was Dae Houlihan's, and its
items were about Citation Tally.

## Before this can be published

- **The repository is private**, so the update feed in `manifest.json` resolves
  to a 404 and Zotero will never find an update. Going public also needs a
  release tagged `v<version>` with `orbit.xpi` attached, and one tagged
  `release` carrying `update.json`.
- **No screenshot of the Citations column.** It is Zotero's item tree, which
  cannot be rendered outside Zotero; the old one was Citation Tally's and is
  gone. Drop a real one at `docs/assets/readme/column.png`.

## Worth doing

- Offer the OpenAlex provider back to Citation Tally. Open an issue there first.
- INSPIRE is still in the configured databases for a library that is not
  physics; either use it or drop it from the default order.
- The graph seeds from one item only. A graph over a whole collection is a
  different shape of question and a much larger set of requests.
- `retryAge` and `temporalParse` fail in unmodified upstream too. Either fix
  them or say why they are expected to fail.

## Known limits

- Library matching is by DOI only. A reference Semantic Scholar returns without
  one is not recognised even when it is on the shelf; a title match would
  produce false positives, and a wrongly drawn ring is worse than a missing one.
