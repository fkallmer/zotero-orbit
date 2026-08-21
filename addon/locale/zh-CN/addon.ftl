startup-begin = 引用计数正在加载
startup-finish = 引用计数已就绪
startup-progress = [{ $percent }%] { $message }
menuitem-update-citation-tallies =
    .label = 更新引用计数
menuitem-retally-outdated-citations =
    .label = 重新统计过期引用
prefs-title = 引用计数
prefs-table-title = 标题
prefs-table-detail = 详情

# Progress window messages
progress-getting-citation-tallies = 正在获取引用计数
progress-no-valid-items = 未选择有效的项目来更新引用计数。
progress-items-updated = 已为 { $count } 个项目更新了引用计数。
progress-item-counter = 项目 { $current } / { $total }

# Auto-update messages
auto-update-title = { $addonName } - 自动更新中 (点击隐藏)
auto-update-updating-outdated = 正在更新 { $count } 个过期引用...
auto-update-updating-item = 正在更新项目 { $current } / { $total }
auto-update-connection-retry = 连接问题，正在重试... ({ $current }/{ $max })
auto-update-stopped = 自动更新已停止：{ $error }
auto-update-completed = 自动更新完成：{ $updated }/{ $total } 个项目已更新

# Database display names
database-crossref = Crossref
database-googlescholar = Google Scholar
database-inspire = INSPIRE
database-openalex = OpenAlex
database-semanticscholar = SemanticScholar

# Semantic Scholar API key
semantic-scholar-key-rejected = Semantic Scholar 拒绝了您的 API 密钥。引用计数已停止使用它，稍后会自动重试。
semantic-scholar-unavailable = Semantic Scholar 不可用，已被关闭。其他引用数据库仍可正常使用。

# Column and tooltip
column-citations = 引用
tooltip-citation-tallies = { $displayName }：{ $count }

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
