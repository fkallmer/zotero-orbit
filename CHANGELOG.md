# Changelog

All notable changes to Orbit. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) as far as a 0.x plugin can.

## [Unreleased]

### Fixed

- **One failing database no longer costs an item all its counts.** Each
  database is now looked up on its own. Before, an error in one lookup (for
  example Semantic Scholar) threw away the counts already fetched from the
  others, so an item could end with no count at all and the run reported
  "updated 0 items".
- **Lookup errors are logged with their message and stack.** They were logged
  as `{}`, which hid the cause.

## [0.3.1] — 2026-11-18

### Changed

- **Clearer cluster names.** A cluster is named after the narrower of the
  OpenAlex topic or subfield that at least half of its items share, so a broad
  group reads "Molecular Biology" rather than a topic a third of it carries.
  Names are unique and at most 45 characters. Networks analysed before keep
  their topic names until analysed again; their duplicates are resolved on
  load.
- **Readable large networks.** In a crowded collection graph every mark
  shrinks by the same share (never below half), discs turn slightly
  translucent with thinner rings, small marks are drawn over large ones, and
  the ranked gaps over everything. Small collections look as before.
- **The citing step shows its progress** page by page, with the works found so
  far, instead of standing still for minutes per group.
- **The gaps list follows the cluster filter.** Picking clusters in the legend
  narrows the list, and the numbered marks, to the works those clusters lean
  on, ranked again among them. Every row carries dots in the colours of the
  clusters that cite it, and with clusters picked, a light wash of the
  picked cluster's colour behind it. Unticking "Only works of the picked
  clusters" keeps every work in the list and washes only those mostly cited
  by the picked clusters. The
  chosen view and order survive picking clusters.
- **The OpenAlex budget shows during an analysis**, under the progress bar, so
  a long run can be watched spending it.

### Added

- **Rate-limit notice.** When a source makes Orbit wait, the progress window
  says which one and for how long, counting down; for Semantic Scholar without
  an API key it suggests adding one.

- **The Citations column shows what is still to come.** During an update,
  rows waiting their turn show "…" beside their old counts, and each row
  drops it as it is done.
- **No count is no longer a blank.** A row Orbit looked up and found nothing
  for shows "–", and its tooltip names the sources that reported it missing,
  or says it had no DOI or other identifier to look up.

### Fixed

- A cached network without a cluster assignment is analysed again rather than
  breaking the graph.

### Internal

- All 93 ESLint warnings fixed with real types for Zotero and Gecko values.
- The release checklist names the update-channel step that 0.3.0 missed.

## [0.3.0] — 2026-11-18

The collection release: Orbit now reads a whole collection, or a whole
library, as one citation network — and because it knows what you already
hold, it can say what is missing and file it for you.

### Added

- **Collection and library graphs.** Right-click a collection, or use
  `Tools → Citation graph for this library`, to draw every item in it as one
  network: the works they share, how they cite each other, and — with an
  OpenAlex API key — the works that cite several of them.
- **Clusters.** Items are grouped by the references they share (bibliographic
  coupling, Leiden algorithm via `networkanalysis-ts`) and each group is named
  after its most common OpenAlex topic, with no two clusters sharing a name.
  Clicking a cluster in the legend shows only it; more clicks add others.
- **Gaps list.** Works several of your items cite but your library does not
  hold, ranked by how many of your items lean on them, discounted for fame.
  Each shows its authors, which of your items cite it, and can be sorted by
  score, year, citations or reference count; the top ten are numbered in the
  graph.
- **Most referenced view.** Every work at least two of your items cite, held
  or not, including your own items that others in the collection cite.
- **OpenAlex budget display.** The size dialog and the graph show what is left
  of today's OpenAlex budget and when it resets.
- **Import by DOI.** One click (with confirmation) files a missing work into
  the analysed collection through Zotero's own DOI lookup. Works already in the
  library are added to the collection instead of imported twice.
- **Add to library from a paper graph.** A work's card in a single-paper graph
  offers the same DOI import, and asks which collection (or none) it goes into,
  starting with the one open in Zotero.
- **Export and hand-off.** VOSviewer JSON, GraphML (keeps citation direction,
  for Gephi), the gaps as CSV and RIS, and links that open the collection in
  Local Citation Network and Inciteful.
- **Library matching by arXiv ID and PMID**, not only by DOI — read from the
  DOI field, Archive ID, arxiv.org URLs and `DOI:`/`arXiv:`/`PMID:` lines in
  Extra, including the category Zotero's arXiv translator appends.
- **Probable matches by title.** When no identifier matches, an exactly equal
  normalized title, a year within one, and a shared author (surname and
  initial) mark a work as _probably_ held — a dashed collar in the graph, ○ in
  the item pane. Any conflicting identifier rules a match out.
- **OpenAlex API key** setting, sent as a bearer header and never in a URL.
- **Collection size limit** setting: above N items (300 by default), cap,
  ask first with a request estimate, or always analyse everything.
- **Save buttons** for the OpenAlex key and the collection settings.

### Changed

- The contact address now only buys Crossref's faster pool; OpenAlex no longer
  documents one, and its limits are set by the API key instead.
- The record cache holds up to 6,000 entries (was 2,000).
- Network marks are sized on a logarithmic scale of their reference count.
- Hover, zoom and pan redraw only what changed, and labels follow their marks
  while the view moves.
- The selected row in the item list keeps a readable citation count.

### Fixed

- The library graph always came up empty, and a collection graph drew only its
  first item.
- An item added while the library index was being built could stay unmarked
  until the next unrelated edit.
- Items whose type has no DOI field were left out of the library index
  entirely.

### Security

- CSV exports write titles that a spreadsheet would run as a formula as text.
- Build tooling: adm-zip 0.6.1, brace-expansion 5.0.13 and minimatch 11 close
  the open Dependabot alerts. None of these ship in the plugin.

## [0.2.22] — 2026-08-25

First release under the Orbit name, forked from
[Citation Tally](https://github.com/daeh/zotero-citation-tally).

### Added

- OpenAlex and Google Scholar as citation sources, beside Crossref, Semantic
  Scholar and INSPIRE.
- An item pane section with the OpenAlex record: citations per year, the
  field-weighted citation impact and its percentile, open access, journal
  metrics, authors with ORCIDs, institutions, funding, retraction warnings,
  and the reference list from Semantic Scholar.
- A sortable field-weighted citation impact column.
- A citation graph tab for one paper: what it cites and what cites it, with
  selectable axes and the citations among its neighbours.

[0.3.1]: https://github.com/fkallmer/zotero-orbit/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/fkallmer/zotero-orbit/compare/v0.2.22...v0.3.0
[0.2.22]: https://github.com/fkallmer/zotero-orbit/releases/tag/v0.2.22
