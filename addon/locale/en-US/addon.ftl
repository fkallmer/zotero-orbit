startup-begin = Orbit is loading
startup-finish = Orbit is ready
startup-progress = [{ $percent }%] { $message }
menuitem-update-citation-tallies =
    .label = Update Citation Tallies
menuitem-retally-outdated-citations =
    .label = Retally outdated item citations
menuitem-update-fwci =
    .label = Update field-weighted impact
menuitem-refresh-fwci-library =
    .label = Fill in missing field-weighted impact
prefs-title = Orbit

# Progress window messages
progress-getting-citation-tallies = Getting citation tallies
progress-no-valid-items = No valid items selected for citation tally update.
progress-items-updated = Citation tallies updated for { $count } items.
progress-item-counter = Item { $current } of { $total }

# Field-weighted impact refresh. Asked in batches of fifty, so the counter
# moves in jumps rather than one item at a time.
progress-fwci-starting = Asking OpenAlex for field-weighted impact
progress-fwci-counter = { $current } of { $total } works
progress-fwci-nothing-to-do = Field-weighted impact is already up to date.
progress-fwci-already-running = A field-weighted impact refresh is already running.
progress-fwci-done = Field-weighted impact found for { $count } works.
progress-fwci-stopped = Stopped early; field-weighted impact found for { $count } works. Try again later.

# Auto-update messages
auto-update-title = { $addonName } - Autoupdating (Click to Hide)
auto-update-updating-outdated = Updating { $count } outdated citations...
auto-update-updating-item = Updating item { $current } of { $total }
auto-update-connection-retry = Connection issue, retrying... ({ $current }/{ $max })
auto-update-stopped = Auto update stopped: { $error }
auto-update-completed = Auto update completed: { $updated }/{ $total } items updated

# Appended to a progress line while a citation source makes Orbit wait after
# telling it to slow down (HTTP 429). $progress is the line it is appended to,
# $wait is rate-limit-wait-duration, $source a database display name.
rate-limit-wait-duration = { $unit ->
    [minutes] { $amount } min
   *[seconds] { $amount } s
  }
rate-limit-waiting = { $progress } — { $source } is rate-limiting Orbit, waiting { $wait }.
rate-limit-waiting-semanticscholar = { $progress } — Semantic Scholar is rate-limiting Orbit, waiting { $wait }.
rate-limit-waiting-semanticscholar-no-key = { $progress } — Semantic Scholar is rate-limiting Orbit, waiting { $wait }. A free API key (Settings → Orbit) raises the limit.

# Database display names
database-crossref = Crossref
database-googlescholar = Google Scholar
database-inspire = INSPIRE
database-openalex = OpenAlex
database-semanticscholar = SemanticScholar

# Semantic Scholar API key
semantic-scholar-key-rejected = Semantic Scholar rejected your API key. Orbit has stopped using it and will try again later.
semantic-scholar-unavailable = Semantic Scholar isn't available and has been turned off. The other citation databases still work.

# Column and tooltip
column-citations = Citations
tooltip-citation-tallies = { $displayName }: { $count }
tooltip-openalex-by-title = { $displayName }: { $count } (work found by title; may be another edition)
column-pending = Waiting to be updated
column-not-found = No citation count: not found at { $sources }
column-no-identifier = No citation count: no DOI or other identifier to look it up by

# Gaps list (gaps-*, P8). Add strings below this line only.
gaps-heading-reference = Cited by your items
gaps-heading-citing = Citing your items
gaps-empty = No gaps: every work that several of your items cite, or that cites several of them, is already in your library.
gaps-year-unknown = no year
gaps-citations = { $count ->
    [one] 1 citation
   *[other] { $count } citations
  }
gaps-citations-unknown = citations unknown
gaps-references = { $count ->
    [one] 1 reference
   *[other] { $count } references
  }
gaps-authors-two = { $first } & { $second }
gaps-authors-many = { $first } et al.
gaps-view-missing = Missing ({ $count })
gaps-view-referenced = Most referenced ({ $count })
referenced-intro = Works at least two of your items cite, held or not: what the collection rests on.
referenced-empty = No work is cited by two or more of your items.
referenced-held-seed = ✓ One of your items
referenced-held-exact = ✓ In your library
referenced-held-probable = ○ Probably in your library
gaps-scope-picked = Only works of the picked clusters
gaps-sort-label = Sort by
gaps-sort-score = Score
gaps-sort-year = Year
gaps-sort-citations = Citations
gaps-sort-references = References
gaps-score = score { $score }
gaps-score-hint = How many of your items it is connected to, divided by the base-10 logarithm of ten plus its citation count. The divisor is 1 for an uncited work (or an unknown count), 2 at ninety citations and 3 at a thousand, so fame lowers the score without cancelling it: a niche work several of your items share ranks above a classic everyone cites, but a work many of your items lean on stays high however well known it is.
gaps-cited-by = { $count ->
    [one] cited by 1 of your items
   *[other] cited by { $count } of your items
  }
gaps-cites = { $count ->
    [one] cites 1 of your items
   *[other] cites { $count } of your items
  }
gaps-probable-heading = Probably in your library ({ $count })
gaps-probable-hint = Matched by title, year and first author rather than by an identifier. Check before importing these: the library most likely holds them already.
gaps-show-item = Show item

# Import by DOI (import-*, P8). Add strings below this line only.
import-button = Import
import-button-hint = Look up { $doi } and add it to your library
import-running = Importing…
import-done = ✓ In your library
import-confirm-title = Add to your library?
import-confirm-body = Look up this work by its DOI and add it to “{ $target }”?
    { $title } ({ $year })
    DOI: { $doi }
import-confirm-no-year = no year
import-choose-body = Look up this work by its DOI and add it where?
    { $title } ({ $year })
    DOI: { $doi }
import-failed-read-only = This library cannot be edited.
import-failed-no-translator = No translator can look up DOIs.
import-failed-no-result = The DOI lookup found nothing.
import-failed-error = The import failed.

# Item pane section
# Attribute-only, like Zotero's own section strings (section-tags, sidenav-info).
# A Fluent message with a *value* is written into the element's textContent,
# which wipes the collapsible-section's internal structure -- header icon,
# twisty and body all disappear and only the bare text remains.
pane-header =
  .label = Citation Details
pane-sidenav =
  .tooltiptext = Citation Details
pane-refresh =
  .tooltiptext = Refresh from OpenAlex
pane-loading = Loading OpenAlex data...
pane-refreshing = Refreshing all sources...
pane-refresh-failed = Refresh failed. See the debug output for details.
pane-no-openalex = No OpenAlex record for this item. Works without a DOI or arXiv ID cannot be looked up there.
pane-retracted = This work has been retracted.
pane-heading-citations = Citations
pane-divergence-note = The sources disagree substantially. Databases that index by DOI cannot see books, chapters or non-English work, where Google Scholar often can.
pane-label-fwci = Field-weighted impact
pane-label-percentile = Percentile
pane-heading-history = Citations per year
pane-heading-access = Open Access
pane-label-oa-status = Status
pane-link-fulltext = Open full text
pane-label-apc = Publication charge
pane-heading-journal = Journal
pane-label-journal = Name
pane-label-mean-citedness = 2-year mean citedness
pane-label-h-index = h-index
pane-label-i10-index = i10-index
pane-label-doaj = In DOAJ
pane-value-yes = yes
pane-value-no = no
pane-heading-authors = Authors
pane-heading-institutions = Institutions
pane-heading-funding = Funding

# Explanations, shown by the info toggle. Precision matters more than brevity
# here: several of these look like metrics they are not.
# Read with getString() and set as a title attribute by hand, so this one
# needs a value -- unlike the header strings, which Fluent applies itself.
pane-info-toggle = Explain these values
pane-hint-fwci = Citations compared to other works of the same age and field. 1.0 is the field average, 2.0 is twice as cited as typical. Comparable across disciplines, unlike a raw count.
pane-hint-percentile = Where this work sits among everything published that year. 90–99 means it is in the top tenth by citations.
pane-hint-mean-citedness = OpenAlex's 2-year mean citedness for the journal: average citations to articles from the two preceding years. Comparable in spirit to a Journal Impact Factor, but computed from open data — not Clarivate's JIF, and not interchangeable with it.
pane-hint-h-index = The journal has published this many articles that each have at least that many citations. Rewards a sustained body of cited work rather than a few outliers.
pane-hint-i10-index = How many articles in the journal have at least 10 citations each.
pane-hint-doaj = Whether the journal is listed in the Directory of Open Access Journals, a vetted index of open access journals with reviewed editorial standards.
pane-hint-apc = The article processing charge the publisher lists for open access. What was actually paid is shown when the record has it.

pane-heading-references = References
pane-label-references = Cited works
pane-label-references-held = In your library
pane-reference-in-library = Already in your library
pane-reference-probable-in-library = Probably in your library (matched by title)
pane-reference-probable-count = Probably in your library
pane-references-more = and { $count } more
pane-hint-references = Works this paper cites, as far as Semantic Scholar resolved them — consistently more than OpenAlex finds, and still fewer than the printed bibliography. Treat it as a floor, not a count.
pane-label-influential = Influential citations
pane-hint-influential = Citations where Semantic Scholar judges the citing work built on this one, rather than mentioning it in passing. At ten citations, one influential versus eight is the whole story.

column-fwci = Field-weighted impact
pane-references-none = Semantic Scholar lists no references for this work.
pane-references-elided = The publisher has asked Semantic Scholar not to serve this work's reference list through its API — { $count } references exist and are visible on the Semantic Scholar site. OpenAlex had none for this work either.
pane-reference-cited-by = Citations of this cited work

# Collection and library network (network-*, P4/P9). Add strings below this line only.
network-failed = The analysis stopped because OpenAlex did not answer, even after a few tries. Try again in a minute. A free OpenAlex API key (Settings → Orbit) raises its limits.
network-budget = OpenAlex today: US$ { $remaining } of { $limit } left
network-budget-reset = OpenAlex today: US$ { $remaining } of { $limit } left, resets in { $hours ->
    [one] 1 hour
   *[other] { $hours } hours
  }
# Name of a topic cluster none of whose papers has an OpenAlex topic. $number counts from 1.
network-cluster-fallback = Cluster { $number }
# The steps of an analysis, under the progress bar.
network-step-seeds = Reading your items' identifiers
network-step-lookup = Looking your items up in OpenAlex
network-step-references = Resolving the works they cite in common
network-step-citing = Finding works that cite several of them
network-step-library = Checking your library
network-step-clusters = Grouping them into topics
# $step is one of the network-step-* strings above.
network-step-count = { $step } ({ $done } of { $total })
# The citing step, page by page: $group of $total groups, $pages pages into this one, $found works so far.
network-step-pages = { $step } (group { $group } of { $total }, page { $pages }, { $found } works so far)
network-scope-gone = This collection no longer exists.
network-scope-empty = There are no regular items here to analyse.
network-none-resolved = None of the { $count } items could be found in OpenAlex. An item needs a DOI, an arXiv ID or a PMID to be looked up.
# Asked in the tab when a collection holds more items than the limit in the settings.
network-confirm-title = A large analysis
network-confirm-body = “{ $name }” holds { $count } items, more than the { $limit } set in Orbit's settings.
# $usd is in US dollars; $share is a percentage of OpenAlex's daily budget, possibly "<1".
network-confirm-estimate-all = All { $count }: about { $requests } OpenAlex requests, US$ { $usd }, { $share } % of today's budget.
network-confirm-estimate-cap = The first { $limit }: about { $requests } OpenAlex requests, US$ { $usd }, { $share } % of today's budget.
network-confirm-all = Analyse all { $count }
network-confirm-cap = Analyse the first { $limit }
network-confirm-cancel = Cancel
network-cancelled = Not analysed.
network-ask-again = Choose again
network-capped = Analysing { $analysed } of { $total } items, as set in Orbit's settings.
network-legend-unclustered = Unclustered
network-legend-cluster-hint = Show only this topic; click more topics to add them, click a chosen one again to take it out
network-legend-gaps = Not in your library
network-legend-held = Also in your library
network-legend-citing = Citing works
network-legend-citing-add = Add citing works
network-citing-needs-key = needs an OpenAlex API key
network-role-seed = Your item
network-probably-in-library = Probably in your library
network-center-seeds = Centre on your items
network-export = Export and open…
network-card-import = Import
network-card-cited-by = Cited by (OpenAlex)
network-card-connected-papers = Connected Papers
network-import-done = “{ $title }” is in { $target } now.
network-coverage-unresolved = { $count ->
    [one] 1 item not found in OpenAlex
   *[other] { $count } items not found in OpenAlex
  }
network-coverage-citing-truncated = citing works incomplete


# Citation graph tab
graph-tab-title = Graph: { $name }
graph-placeholder-title = Citation graph
graph-placeholder-note = Scaffolding only — no data yet. If you can read this, the tab renders.
graph-seed-items = { $count } selected items
graph-seed-untitled = Untitled item
graph-seed-library = Library
menuitem-graph-library =
  .label = Citation graph for this library
menuitem-graph-selection =
  .label = Citation graph
graph-axes-note = Mark size is how many works each one cites. Arrows point from the citing work to the cited one; point at a mark to see the paths between it and the others. Click a legend entry to take that group out. Scroll to zoom, drag to pan; hold Shift to stretch the horizontal axis alone, Alt for the vertical.
graph-axis-x = Across
graph-axis-y = Up
graph-metric-year = Publication year
graph-metric-citations = Citations
graph-metric-references = References cited
graph-direction-year = More recently published
graph-direction-citations = More citations
graph-direction-references = Cites more works
graph-reload = Fetch it all again, past the cache
graph-zoom-in = Zoom in
graph-zoom-out = Zoom out
graph-zoom-reset = Fit everything back into view
graph-center-seed = Centre on this work
# Singular: labels one work in the card and the detail strip.
graph-role-seed = This work
graph-role-reference = Reference
graph-role-citing = Citation
# Plural: the legend, where each carries a count.
graph-legend-seed = This work
graph-legend-reference = References
graph-legend-citing = Citations
graph-in-library = In your library
graph-library-only = Only in your library
graph-library-missing = Not in your library
graph-card-title = Untitled work
graph-card-citations = { $count } citations
graph-card-references = cites { $count } works
graph-card-doi = Open DOI
graph-card-source = Semantic Scholar
graph-card-graph = Graph from here
graph-card-item = Show in library
graph-card-add = Add to library
graph-card-close = Close
graph-card-no-doi = No DOI, so there is nowhere to open it.
graph-no-values = None of the surrounding works carry both values the axes ask for, so there is nothing to place.
graph-dropped-no-value = { $count } not shown, missing a value
graph-loading = Gathering references and citing works…
graph-step-record = Looking this work up
graph-step-references = Reading its references
graph-step-citing = Finding what cites it
graph-step-library = Checking your library
graph-step-links = Tracing the paths between them
graph-highlight = Highlight
graph-links = Follow
graph-links-both = References and citations
graph-links-references = References only
graph-links-citations = Citations only
graph-links-hint = Which way to follow the paths out of the work under the pointer: what it cites, what cites it, or both.
graph-highlight-hint = How far along the citation paths to light up from the work under the pointer. One link is what it is directly connected to.
graph-highlight-hops = { $hops ->
    [one] 1 link
   *[other] { $hops } links
  }
graph-empty = No OpenAlex record for this item, so there is nothing to graph. Works without a DOI or arXiv ID cannot be looked up.
graph-scale-log = Scale: logarithmic
graph-scale-linear = Scale: linear
graph-scale-hint = Logarithmic keeps orders of magnitude readable; linear separates works that are cited similarly often.

# Exports and links to other tools (export-*, P6). Add strings below this line only.
export-vosviewer = Export network for VOSviewer…
export-graphml = Export network as GraphML…
export-gaps-csv = Export gaps as CSV…
export-gaps-ris = Export gaps as RIS…
export-open-lcn = Open in Local Citation Network
export-open-inciteful = Open in Inciteful
export-filter-vosviewer = VOSviewer JSON
export-filter-graphml = GraphML
export-filter-csv = CSV
export-filter-ris = RIS
