# XUL widgets (button, radio, menuitem) render from their `label` attribute and
# keep their indicator or arrow in internal content. Localize them with an
# attribute — a plain value makes Fluent write textContent, wiping that content.

# Citation databases
pref-citation-databases = Citation Databases (shown in this order)
pref-database-instructions = Enter 1-3 databases separated by commas
pref-database-options-label = Options:
pref-database-field =
    .placeholder = crossref, semanticscholar
pref-validate-button =
    .label = Validate
pref-database-duplicate = Duplicate databases found
pref-database-invalid = Invalid database(s): { $databases }
pref-database-count = Please enter 1-3 databases
pref-database-valid = ✓ Valid database configuration

# Automatic updates
pref-fetch-on-add = Fetch tallies for new items
pref-fetch-on-add-enabled =
    .label = Fetch tallies when items are added
pref-fetch-on-add-disabled =
    .label = Don't fetch tallies for new items
pref-auto-update-settings = Automatic Updates
pref-auto-update-description = Automatically update citation tallies for items in your library
pref-auto-update-never =
    .label = Never update automatically
pref-auto-update-startup =
    .label = Update outdated citations on startup
pref-auto-update-cutoff-label = Consider citations outdated after:
pref-auto-update-cutoff-3 =
    .label = 3 months
pref-auto-update-cutoff-6 =
    .label = 6 months
pref-auto-update-cutoff-12 =
    .label = 12 months
pref-auto-update-cutoff-24 =
    .label = 24 months

# Display
pref-color-settings = Display Options
pref-color-description = Color tallies in column
pref-use-colors =
    .label = Use colors for different databases
pref-no-colors =
    .label = Display without colors

# API keys
pref-apikeys-heading = API keys
pref-apikey-intro = Optional, but recommended. Without a key, requests share Semantic Scholar's anonymous pool with every other client using it, so lookups are slower and less reliable.
pref-apikey-storage = Stored unencrypted in Zotero's preferences.
pref-apikey-label = Semantic Scholar
pref-apikey-field =
    .placeholder = s2k-***
pref-apikey-valid = ✓ API key is valid
pref-apikey-invalid = ✗ Semantic Scholar rejected this key
pref-apikey-indeterminate = Couldn't check the key just now. Try again.
pref-apikey-error = Semantic Scholar returned an unexpected error
pref-apikey-empty = No key set (using anonymous access)
pref-apikey-checking = Checking…
pref-apikey-unavailable = Semantic Scholar is unavailable here
pref-apikey-cleaned = Removed invisible characters from the pasted key ({ $characters }).

# The polite-pool contact. Not a key, and not secret -- it is sent with every
# request on purpose.
pref-contact-heading = Contact address
pref-contact-intro = Optional. Crossref serves requests that say who is making them from a faster, more reliable pool. Yours is sent with Crossref and OpenAlex requests and with nothing else. OpenAlex no longer gives an address higher limits; for those, use the OpenAlex key below.
pref-contact-label = Email
pref-contact-field =
    .placeholder = you@example.org
pref-contact-in-use = ✓ Sent to Crossref and OpenAlex
pref-contact-unusable = ✗ That does not look like an email address, so nothing is sent
pref-contact-built-in = Using the address this copy was built with
pref-contact-anonymous = Not set — using the common pool, which is slower

pref-help = { $name } [Build { $version } { $time }]

# OpenAlex API key and collection network limits (pref-openalex-key-*, pref-network-*, P1). Add strings below this line only.
pref-openalex-key-intro = Optional, free from openalex.org. Without a key, OpenAlex allows $0.10 of requests a day; with one, $1. The collection graph needs a key to list the works that cite your items.
pref-openalex-key-label = OpenAlex key
pref-openalex-key-field =
    .placeholder = OpenAlex API key
pref-openalex-key-in-use = ✓ Sent to OpenAlex as a bearer token
pref-openalex-key-missing = Not set — OpenAlex's smaller daily budget; the collection graph cannot list works citing it
pref-openalex-key-cleaned = Removed invisible characters from the pasted key ({ $characters }).
pref-openalex-key-unusable = ✗ The key contains characters that cannot be sent ({ $characters }), so no key is sent

pref-network-heading = Collection graph
pref-network-description = Each item in a collection or library graph costs OpenAlex requests. Above this many items, Orbit does what you choose below.
pref-network-limit-label = Item limit (N)
pref-network-limit-field =
    .placeholder = 300
pref-network-limit-help = From 10 to 5000. Anything else resets to 300.
pref-network-policy-label = When a collection holds more than N items:
pref-network-policy-cap =
    .label = Analyse only the first N
pref-network-policy-warn =
    .label = Ask first, with an estimate
pref-network-policy-all =
    .label = Always analyse everything
pref-save-button =
    .label = Save
pref-saved = ✓ Saved
