# Orbit

Citation counts, context and a citation graph for Zotero items.

Orbit shows how often a work has been cited according to Crossref, INSPIRE,
OpenAlex, Semantic Scholar and Google Scholar side by side — the disagreement
between them is often the interesting part. It adds an item pane section with
the OpenAlex record behind those numbers, the works a paper cites, and a graph
tab plotting a paper's references and citing works against year and citation
count.

Requires Zotero 10.

## Building

`yarn build` produces `.scaffold/build/orbit.xpi`. Every build raises the patch
version, because Zotero keys an installed plugin by version and two builds
sharing one are, to it, the same plugin.

OpenAlex offers a faster request pool to callers who identify themselves. Put
an address in `.orbit-contact` (untracked) or set `ORBIT_CONTACT`, and it is
substituted into the build. Leave it unset and Orbit uses the common pool,
which is slower but works. The address is deliberately not in this repository:
it identifies whoever runs the build, and a fork must not go on sending an
address that is not theirs.

## Origin

Orbit is a fork of [Citation Tally](https://github.com/daeh/zotero-citation-tally)
by Dae Houlihan, and is licensed AGPL-3.0 like the original. The citation-count
column, the provider framework and the preferences are that project's work; the
OpenAlex and Google Scholar providers, the item pane section and the graph tab
are added here.

## Plugin Functions

- **Automatic Citation Tracking** - Fetches citation counts when new items are added to your library
- **Smart Auto-Updates** - Keeps citation data current with configurable update schedules
- **Visual Integration** - Adds a sortable "Citations" column to your Zotero library view
- **Multiple Databases** - Shows counts from Crossref, OpenAlex, Semantic Scholar, Google Scholar and INSPIRE side by side
- **Intelligent Rate Limiting** - Respects API limits with adaptive throttling
- **Persistent Storage** - Stores citation data in item's Extra field for sync compatibility

Please post any bugs, questions, or feature requests in [Orbit's issues](https://github.com/fkallmer/zotero-orbit/issues). They do not belong on Citation Tally's tracker: the two are separate plugins now, and its maintainer did not write the parts you are most likely to be reporting on.

## Installation

- Download the plugin (the `.xpi` file) from the [latest release](https://github.com/fkallmer/zotero-orbit/releases/latest)
- Open Zotero
- From `Tools → Plugins`
- Select `Install Plugin From File...` from the gear icon ⛭
- Choose the `.xpi` file you downloaded (e.g. `orbit.xpi`)
- Restart Zotero

> [!NOTE]
> Orbit requires Zotero 10 and has no releases before it. For Zotero 7, 8 or 9,
> use [Citation Tally](https://github.com/daeh/zotero-citation-tally/releases),
> which Orbit is forked from -- without the OpenAlex and Google Scholar
> providers, the item pane section or the graph tab, which are added here.

## Setup and Configuration

Citation Tally tallies bibliographic items as you add them. It does not automatically backfill items already in your libraries. To update existing items in My Library, run `Tools → Retally outdated item citations`, which scans for counts that are missing or older than the configured cutoff. For editable items in other libraries, select them, right-click, and choose "Update Citation Tallies".

### Initial Setup

- After installation, restart the Zotero app. The plugin adds a "Citations" column to your Zotero library view.

  - If you don't see the column, right-click the column titles and check "Citations".

    ![show Citations column](docs/assets/readme/show-column.png)

- Configure the plugin from `Zotero → Settings → Citation Tally` on macOS, or `Edit → Settings → Citation Tally` on Windows and Linux.

### Automatic Behavior

- **New Items**: Citation counts are fetched for newly added bibliographic items with DOIs or arXiv IDs, in My Library or a group library you can edit. Feed items are skipped. This is on by default.
- **Auto-Updates**: Missing and outdated counts in My Library can be refreshed the next time Zotero starts. This is off by default.

### Manual Actions

- **Update Selected Items**: Right-click → "Update Citation Tallies"

  - **_NB_** Selected-item updates bypass the retry schedule, and can update editable items outside My Library

- **Update All Outdated**: Tools menu → "Retally outdated item citations"

  - Scans My Library for counts that are missing or older than the configured cutoff. This runs whether or not automatic updates are switched on.

### Configuration Options

<details>

<summary>Citation Databases</summary>

- **Databases**: Which databases to use. Their counts appear in the Citations column in the order you list them, separated by `|`. Hover a cell to see which database each number came from.
  - Default: `crossref, semanticscholar`
  - For physics papers you might prefer `inspire, crossref, semanticscholar`

</details>

<details>

<summary>Automatic Updates</summary>

- **Fetch tallies for new items**: On by default. Turn it off to stop counts being fetched as you add items.
- **Automatic updates**: Off by default. Set it to refresh missing and outdated counts in My Library the next time Zotero starts.
- **Consider citations outdated after**: How old a count can be before it is considered outdated — 3, 6, 12, or 24 months. The default is 6. This applies both to startup updates and to `Tools → Retally outdated item citations`.

</details>

<details>

<summary>Display Options</summary>

- **Colors**: On by default. Each database's count gets its own color when more than one database is shown; turn it off to display every count in the default color.

</details>

<details>

<summary>API Keys</summary>

- **Semantic Scholar API key** (optional, but recommended): Enter a key under `Settings → Citation Tally → API keys`. Without one, requests share Semantic Scholar's anonymous pool with every other client using it, so lookups are slower and less reliable.
  - Request a key at [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api).
  - Zotero stores the key unencrypted in its local preferences. Citation Tally sends it only to Semantic Scholar.
  - If Semantic Scholar rejects the key twice in a row, the plugin stops using it, carries on anonymously, and tries it again after a cooldown. A single rejection triggers one confirming request rather than pausing the key.

</details>

### Troubleshooting

<details>

<summary>Common Issues</summary>

- **No citation data found**: Citation Tally looks items up by DOI or arXiv ID only, not by title, ISBN, PMID, or a database's own record ID. Journal articles and conference papers usually carry a DOI; web pages, theses, and datasets often carry neither identifier.
- **Updates are slow**: Each database paces its own requests and the plugin backs off further when a server throttles it, so a large update can take a while. See [Rate Limiting](#rate-limiting) and [Retries](#retries).
- **Semantic Scholar has been turned off**: If Zotero's plugin runtime doesn't provide the web APIs the Semantic Scholar client needs, Citation Tally disables that database, shows a notice, and carries on with the other databases you have configured.
- **Network issues**: Ensure Zotero has internet access and your firewall isn't blocking requests to academic databases.

</details>

### Advanced Behavior

<details>

<summary>Retries, rate limiting, and identifiers</summary>

#### Retries

Startup updates and `Tools → Retally outdated item citations` both scan My Library, and both back off when a database comes up empty: 7 days after the first failure, then 30, then 90, then 180 days for every attempt after that. API errors hit during a scan follow the same schedule.

#### Rate Limiting

Crossref and INSPIRE each start at one request per second, and are throttled independently. A rate-limit error multiplies the delay by 1.5, up to ten times the base; each success eases it back by 0.9, never below the base.

Semantic Scholar runs its own scheduler: at least 1 second between requests made with an API key, and at least 3 seconds without one. Transient failures back off exponentially with full jitter, never sooner than the server's `Retry-After`.

#### Other Behavior

- If an item has no usable identifier for a database, a library scan skips that item–database pair for the rest of the Zotero session. Selected-item updates do not consult this cache.
- A library scan does not start updating items if Zotero is already offline, and stops before the next item if Zotero goes offline during the run.
- Retry records for deleted items are cleared out shortly after startup and every 30 days. Counts already written to the Extra field are left alone.

#### Supported Identifiers

Crossref needs a DOI. INSPIRE and Semantic Scholar can also use an arXiv ID.

Citation Tally reads the DOI field, then looks for an arXiv ID in Archive ID, Report Number, Extra, URL, and Call Number, in that order.

</details>

## Supported Databases

- **[Crossref](https://www.crossref.org/)**: DOI registration agency; broad coverage of journal and conference publications
- **[Semantic Scholar](https://www.semanticscholar.org/)**: Academic search index run by AI2, with citation graph data
- **[INSPIRE](https://inspirehep.net/)**: High-energy physics literature

## Related Projects

- **[ZoteroCitationCountsManager](https://github.com/FrLars21/ZoteroCitationCountsManager)** by FrLars21
- **[zotero-citationcounts](https://github.com/eschnett/zotero-citationcounts)** by eschnett

## Notes

[GitHub](https://github.com/fkallmer/zotero-orbit): Source code repository, forked from [Citation Tally](https://github.com/daeh/zotero-citation-tally)

This extension uses the [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template).

## License

Distributed under the GNU Affero General Public License v3.0.

## Author

[![Personal Website](https://img.shields.io/badge/personal%20website-daeh.info-orange?style=for-the-badge)](https://daeh.info) [![Bluesky](https://img.shields.io/badge/bsky-@dae.bsky.social-skyblue?style=for-the-badge&logo=bluesky)](https://bsky.app/profile/dae.bsky.social)
