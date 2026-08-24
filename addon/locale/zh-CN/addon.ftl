# Chinese translations only.
#
# Every message not listed here falls back to en-US, which is what Fluent does
# for a missing id. The file used to carry English text under a zh-CN name for
# most of its entries -- a claim of a translation that was never made, and one
# that a Chinese reader would have discovered by using it.
startup-begin = 引用计数正在加载
startup-finish = 引用计数已就绪
menuitem-update-citation-tallies =
    .label = 更新引用计数
menuitem-retally-outdated-citations =
    .label = 重新统计过期引用
prefs-title = 引用计数

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

# Semantic Scholar API key
semantic-scholar-key-rejected = Semantic Scholar 拒绝了您的 API 密钥。引用计数已停止使用它，稍后会自动重试。
semantic-scholar-unavailable = Semantic Scholar 不可用，已被关闭。其他引用数据库仍可正常使用。

# Column and tooltip
column-citations = 引用

# Item pane section
# Attribute-only, like Zotero's own section strings (section-tags, sidenav-info).
# A Fluent message with a *value* is written into the element's textContent,
# which wipes the collapsible-section's internal structure -- header icon,
# twisty and body all disappear and only the bare text remains.

# Explanations, shown by the info toggle. Precision matters more than brevity
# here: several of these look like metrics they are not.
# Read with getString() and set as a title attribute by hand, so this one
# needs a value -- unlike the header strings, which Fluent applies itself.

# Citation graph tab
# Singular: labels one work in the card and the detail strip.
# Plural: the legend, where each carries a count.
