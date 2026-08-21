startup-begin = Citation Tally is loading
startup-finish = Citation Tally is ready
startup-progress = [{ $percent }%] { $message }
menuitem-update-citation-tallies =
    .label = Update Citation Tallies
menuitem-retally-outdated-citations =
    .label = Retally outdated item citations
prefs-title = Citation Tally
prefs-table-title = Title
prefs-table-detail = Detail

# Progress window messages
progress-getting-citation-tallies = Getting citation tallies
progress-no-valid-items = No valid items selected for citation tally update.
progress-items-updated = Citation tallies updated for { $count } items.
progress-item-counter = Item { $current } of { $total }

# Auto-update messages
auto-update-title = { $addonName } - Autoupdating (Click to Hide)
auto-update-updating-outdated = Updating { $count } outdated citations...
auto-update-updating-item = Updating item { $current } of { $total }
auto-update-connection-retry = Connection issue, retrying... ({ $current }/{ $max })
auto-update-stopped = Auto update stopped: { $error }
auto-update-completed = Auto update completed: { $updated }/{ $total } items updated

# Database display names
database-crossref = Crossref
database-googlescholar = Google Scholar
database-inspire = INSPIRE
database-openalex = OpenAlex
database-semanticscholar = SemanticScholar

# Semantic Scholar API key
semantic-scholar-key-rejected = Semantic Scholar rejected your API key. Citation Tally has stopped using it and will try again later.
semantic-scholar-unavailable = Semantic Scholar isn't available and has been turned off. The other citation databases still work.

# Column and tooltip
column-citations = Citations
tooltip-citation-tallies = { $displayName }: { $count }

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
