import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { semanticScholarUrl } from '../src/modules/graphTab.ts'

import {
  buildFwciByDoiUrl,
  buildSourceUrl,
  buildWorkUrl,
  FWCI_SELECT,
  normalizeFwciBatch,
  normalizeSource,
  mailtoSuffix,
  normalizeWork,
  REFERENCE_CHUNK,
  toChronologicalSeries,
  toLookupDoi,
} from '../src/modules/openAlexClient.core.ts'

/** Recorded from the live API, not hand-written, so field drift shows up here. */
const workFixture: unknown = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/openalex-work.json'), 'utf8'))
const sourceFixture: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/openalex-source.json'), 'utf8'),
)

describe('toLookupDoi', () => {
  it('passes a DOI through unchanged', () => {
    assert.equal(toLookupDoi({ type: 'doi', id: '10.1038/nature12373', source: 'DOI' }), '10.1038/nature12373')
  })

  it('rewrites an arXiv id to the DOI arXiv mints', () => {
    // OpenAlex has no arXiv filter at all -- this rewrite is the only route in.
    assert.equal(toLookupDoi({ type: 'arxiv', id: '1412.6980', source: 'Extra' }), '10.48550/arxiv.1412.6980')
  })

  it('drops the version suffix, which OpenAlex does not carry', () => {
    assert.equal(toLookupDoi({ type: 'arxiv', id: '1412.6980v9', source: 'Extra' }), '10.48550/arxiv.1412.6980')
  })
})

describe('buildWorkUrl', () => {
  it('keeps the DOI slash as a path separator and escapes the rest', () => {
    const url = new URL(buildWorkUrl('10.1109/JSEN.2024.3350742', 'cited_by_count'))
    assert.ok(url.pathname.endsWith('/works/doi:10.1109/JSEN.2024.3350742'))
    assert.equal(url.searchParams.get('select'), 'cited_by_count')
  })

  it('carries no mailto when the build was given no contact', () => {
    // The address is substituted at build time and absent here, which is the
    // state a fork of this repository builds in.
    const url = new URL(buildWorkUrl('10.1/x', 'cited_by_count'))
    assert.equal(url.searchParams.get('mailto'), null)
  })

  it('escapes a DOI suffix containing a query character', () => {
    const url = new URL(buildWorkUrl('10.1234/a?b=c', 'cited_by_count'))
    assert.ok(url.pathname.includes('a%3Fb%3Dc'))
  })
})

describe('mailtoSuffix', () => {
  it('names the contact when there is one', () => {
    // OpenAlex gives faster, higher limits to a request that identifies its
    // operator.
    assert.equal(mailtoSuffix('someone@example.org'), '&mailto=someone%40example.org')
  })

  it('produces nothing at all rather than an empty mailto', () => {
    // `&mailto=` claims a contact and names nobody, which is worse than not
    // claiming one.
    assert.equal(mailtoSuffix(''), '')
    assert.equal(mailtoSuffix('   '), '')
  })

  it('does not carry surrounding whitespace into the URL', () => {
    // The address comes from a file, and files end in a newline.
    assert.equal(mailtoSuffix('\n someone@example.org \n'), '&mailto=someone%40example.org')
  })
})

describe('buildSourceUrl', () => {
  it('accepts a bare source id', () => {
    assert.ok(buildSourceUrl('S189694085').includes('/sources/S189694085?'))
  })

  it('accepts the full OpenAlex URL form the work record actually carries', () => {
    assert.ok(buildSourceUrl('https://openalex.org/S189694085').includes('/sources/S189694085?'))
  })
})

describe('toChronologicalSeries', () => {
  it('reverses OpenAlex’s newest-first ordering', () => {
    const series = toChronologicalSeries([
      { year: 2025, cited_by_count: 8 },
      { year: 2024, cited_by_count: 1 },
    ])
    assert.deepEqual(series, [
      { year: 2024, count: 1 },
      { year: 2025, count: 8 },
    ])
  })

  it('fills years OpenAlex omits entirely', () => {
    // The real MITNet record: 2022 and 2023 are simply absent. Left unfilled,
    // the chart would place 2021 next to 2024 and invent a history.
    const series = toChronologicalSeries([
      { year: 2026, cited_by_count: 1 },
      { year: 2025, cited_by_count: 8 },
      { year: 2024, cited_by_count: 1 },
      { year: 2021, cited_by_count: 2 },
    ])
    assert.deepEqual(
      series.map((point) => point.year),
      [2021, 2022, 2023, 2024, 2025, 2026],
    )
    assert.deepEqual(
      series.map((point) => point.count),
      [2, 0, 0, 1, 8, 1],
    )
  })

  it('returns an empty series for missing or malformed input', () => {
    assert.deepEqual(toChronologicalSeries(undefined), [])
    assert.deepEqual(toChronologicalSeries([{ nope: 1 }]), [])
  })
})

describe('normalizeWork', () => {
  it('reads the metrics off a real record', () => {
    const record = normalizeWork(workFixture)
    assert.ok(record)
    assert.equal(record.fwci, 1.2461)
    assert.deepEqual(record.percentile, { min: 90, max: 99 })
    assert.equal(record.isRetracted, false)
    assert.equal(record.sourceName, 'IEEE Sensors Journal')
    assert.equal(record.sourceId, 'https://openalex.org/S189694085')
  })

  it('reads open access as closed, with no full-text URL', () => {
    const record = normalizeWork(workFixture)
    assert.equal(record?.openAccess.isOa, false)
    assert.equal(record?.openAccess.status, 'closed')
    assert.equal(record?.openAccess.url, null)
  })

  it('carries ORCIDs and RORs through', () => {
    const record = normalizeWork(workFixture)
    assert.equal(record?.authors.length, 9)
    assert.equal(record?.authors[0].name, 'Zuohui Chen')
    assert.equal(record?.authors[0].orcid, 'https://orcid.org/0000-0003-1806-6676')
    assert.equal(record?.authors[0].institutions[0].ror, 'https://ror.org/02djqfd08')
  })

  it('returns null rather than a hollow record for junk input', () => {
    assert.equal(normalizeWork(null), null)
    assert.equal(normalizeWork('not an object'), null)
  })

  it('survives a record with every optional field missing', () => {
    const record = normalizeWork({ id: 'https://openalex.org/W1' })
    assert.ok(record)
    assert.equal(record.fwci, null)
    assert.equal(record.percentile, null)
    assert.deepEqual(record.countsByYear, [])
    assert.deepEqual(record.authors, [])
    assert.equal(record.openAccess.isOa, false)
  })

  it('prefers the APC actually paid over the one listed', () => {
    const record = normalizeWork({
      id: 'x',
      apc_list: { value: 3000, currency: 'USD' },
      apc_paid: { value: 1200, currency: 'EUR' },
    })
    assert.deepEqual(record?.apc, { value: 1200, currency: 'EUR' })
  })

  it('falls back to the best OA location when oa_url is absent', () => {
    const record = normalizeWork({
      id: 'x',
      open_access: { is_oa: true, oa_status: 'green' },
      best_oa_location: { pdf_url: 'https://example.org/paper.pdf' },
    })
    assert.equal(record?.openAccess.url, 'https://example.org/paper.pdf')
  })

  it('reads funding from grants as well as funders', () => {
    const record = normalizeWork({
      id: 'x',
      grants: [{ funder_display_name: 'DFG', award_id: 'AB 123/4' }],
    })
    assert.deepEqual(record?.funding, [{ funder: 'DFG', awardId: 'AB 123/4' }])
  })
})

describe('normalizeSource', () => {
  it('reads the journal metrics off a real record', () => {
    const journal = normalizeSource(sourceFixture)
    assert.ok(journal)
    assert.equal(journal.name, 'IEEE Sensors Journal')
    assert.equal(journal.hIndex, 202)
    assert.equal(journal.i10Index, 15525)
    assert.equal(journal.apcUsd, 2645)
    assert.equal(journal.isInDoaj, false)
    assert.ok(Math.abs((journal.twoYearMeanCitedness ?? 0) - 4.1834) < 0.001)
  })

  it('returns null when there is no id to key on', () => {
    assert.equal(normalizeSource({ display_name: 'Nameless' }), null)
  })
})

describe('semanticScholarUrl', () => {
  it('goes through the host that redirects to the paper page', () => {
    // `semanticscholar.org/paper/<doi>` answers with a page that is not the
    // paper; the api host redirects to the canonical one. Both were checked,
    // because a link that looks right and is not is worse than no link.
    assert.equal(semanticScholarUrl('10.3390/s19133005'), 'https://api.semanticscholar.org/10.3390/s19133005')
  })
})

describe('buildFwciByDoiUrl', () => {
  it('asks for a DOI OR-list and only the two fields the column needs', () => {
    const url = buildFwciByDoiUrl(['10.1038/nature12373', '10.48550/arXiv.2401.00001'])
    assert.ok(url.startsWith('https://api.openalex.org/works?filter=doi:'), url)
    // Lower-cased, so the filter matches what OpenAlex stores, and the reply
    // matches what fwciWritesForChunk asked for.
    assert.ok(url.includes('10.1038%2Fnature12373|10.48550%2Farxiv.2401.00001'), url)
    assert.ok(url.includes(`select=${encodeURIComponent(FWCI_SELECT)}`), url)
    assert.ok(url.includes(`per-page=${REFERENCE_CHUNK}`), url)
  })

  it('strips a resolver prefix pasted into a DOI field', () => {
    const url = buildFwciByDoiUrl(['https://doi.org/10.1/a', 'http://dx.doi.org/10.1/b'])
    assert.ok(url.includes('doi:10.1%2Fa|10.1%2Fb'), url)
  })

  it('carries no mailto when no contact was built in', () => {
    // __contact__ is absent in the tests, so this must not claim an empty one.
    assert.ok(!buildFwciByDoiUrl(['10.1/a']).includes('mailto'))
  })
})

describe('normalizeFwciBatch', () => {
  it('reads DOI and value, lower-casing and stripping the resolver', () => {
    const batch = normalizeFwciBatch({
      results: [
        { doi: 'https://doi.org/10.1038/NATURE12373', fwci: 2.5 },
        { doi: '10.1/plain', fwci: 0 },
      ],
    })
    assert.deepEqual(batch, [
      { doi: '10.1038/nature12373', fwci: 2.5 },
      { doi: '10.1/plain', fwci: 0 },
    ])
  })

  it('keeps a work whose FWCI is absent, as a null', () => {
    assert.deepEqual(normalizeFwciBatch({ results: [{ doi: '10.1/recent' }] }), [{ doi: '10.1/recent', fwci: null }])
    assert.deepEqual(normalizeFwciBatch({ results: [{ doi: '10.1/recent', fwci: null }] }), [
      { doi: '10.1/recent', fwci: null },
    ])
  })

  it('drops a result with no DOI to attribute it to', () => {
    assert.deepEqual(
      normalizeFwciBatch({
        results: [
          { id: 'W1', fwci: 4 },
          { doi: '', fwci: 4 },
        ],
      }),
      [],
    )
  })

  it('reads a non-numeric FWCI as no value rather than throwing', () => {
    assert.deepEqual(normalizeFwciBatch({ results: [{ doi: '10.1/a', fwci: 'high' }] }), [
      { doi: '10.1/a', fwci: null },
    ])
  })

  it('survives a body that is not a result list', () => {
    assert.deepEqual(normalizeFwciBatch(null), [])
    assert.deepEqual(normalizeFwciBatch({}), [])
    assert.deepEqual(normalizeFwciBatch({ results: 'nope' }), [])
    assert.deepEqual(normalizeFwciBatch({ results: [null, 3] }), [])
  })
})
