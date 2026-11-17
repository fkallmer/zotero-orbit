# Open

Orbit's own list. The one this file used to hold was Dae Houlihan's, and its
items were about Citation Tally.

## Worth doing

- Offer the OpenAlex provider back to Citation Tally. Open an issue there first.
- The graph seeds from one item only. A graph over a whole collection is a
  different shape of question and a much larger set of requests.

## Known limits

- Library matching is by identifier: DOI, arXiv ID or PMID. A reference that
  arrives with none of them is not recognised even when it is on the shelf; a
  title match would produce false positives, and a wrongly drawn ring is worse
  than a missing one. Cita's guarded rule (exact normalized title, year within
  one, a shared author, no conflicting identifier) would close part of that
  gap, shown as a weaker mark.
- References from OpenAlex carry only a DOI, so their PMIDs go unused; arXiv
  preprints there still match through the `10.48550` DOI.
