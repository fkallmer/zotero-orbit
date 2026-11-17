# Changelog

All notable changes to Orbit. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) as far as a 0.x plugin can.

## [Unreleased] — 0.3.0

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
  after its most common OpenAlex topic. The legend filters by cluster.
- **Gaps list.** Works several of your items cite but your library does not
  hold, ranked by how many of your items lean on them, discounted for fame.
  Each shows which of your items cite it.
- **Import by DOI.** One click (with confirmation) files a missing work into
  the analysed collection through Zotero's own DOI lookup. Works already in the
  library are added to the collection instead of imported twice.
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

### Changed

- The contact address now only buys Crossref's faster pool; OpenAlex no longer
  documents one, and its limits are set by the API key instead.
- The record cache holds up to 6,000 entries (was 2,000).

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

[Unreleased]: https://github.com/fkallmer/zotero-orbit/compare/v0.2.22...HEAD
[0.2.22]: https://github.com/fkallmer/zotero-orbit/releases/tag/v0.2.22
