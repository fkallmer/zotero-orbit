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
// The address Crossref and OpenAlex are given for their polite pools. Empty
// means anonymous, which both providers support. See utils/contact.
pref('openAlexContact', '')
// Sent to OpenAlex only, as a bearer token, never in a URL. Optional: without
// one OpenAlex allows a smaller daily budget, and the collection graph cannot
// page through the works that cite it.
pref('openAlexApiKey', '')
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
pref('graphLinkDirection', 'both')
// Collection and library graphs. Above the limit, 'cap' analyses the first N,
// 'warn' asks first, 'all' never asks. See collectionTypes.SeedPolicy.
pref('networkSeedLimit', 300)
pref('networkSeedPolicy', 'warn')
pref('graphNetworkCiting', false)
pref('graphShowGaps', true)

// Set once the settings and cache from the Citation Tally name have been
// taken over. See utils/adoptLegacyState.
pref('adoptedLegacyState', false)
