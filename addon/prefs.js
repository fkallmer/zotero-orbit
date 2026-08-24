pref('databaseOrderExposed', 'crossref,semanticscholar')
pref('databaseOrder', 'crossref,semanticscholar')
pref('fetchOnAdd', 'true')
pref('autoUpdate', 'never')
pref('autoUpdateCutoff', '6')
pref('useColors', 'color')
pref('ignoredItems', '{}')
pref('rateLimits', '{"crossref":1000,"semanticscholar":3000,"inspire":1000,"openalex":200,"googlescholar":3000}')
// Regional Scholar mirrors exist; a user behind one needs to point at it.
pref('googleScholarEndpoint', 'https://scholar.google.com')
pref('semanticScholarApiKey', '')
// Diagnostics. A real boolean, not the 'true'/'false' strings the older prefs
// above use -- that is a wart worth not extending. No UI: set it in Zotero's
// Config Editor (extensions.zotero.orbit.debugLogging) when asked for
// a log.
pref('debugLogging', false)
// Remembered per user; see citationScale for why neither axis fits both cases.
pref('graphScale', 'log')
pref('graphAxisX', 'year')
pref('graphAxisY', 'citations')
pref('graphShowReferences', true)
pref('graphShowCitations', true)
pref('graphLibraryFilter', 'all')
pref('graphHighlightHops', 1)

// Set once the settings and cache from the Citation Tally name have been
// taken over. See utils/adoptLegacyState.
pref('adoptedLegacyState', false)
