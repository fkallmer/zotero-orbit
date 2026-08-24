import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  buildSourceUrl,
  buildWorkUrl,
  normalizeSource,
  mailtoSuffix,
  normalizeWork,
  toChronologicalSeries,
  toLookupDoi,
} from '../src/modules/openAlexClient.core.ts'

/** Recorded from the live API, not hand-written, so field drift shows up here. */
const workFixture: unknown = JSON.parse(readFileSync(new URL('./fixtures/openalex-work.json', import.meta.url), 'utf8'))
const sourceFixture: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/openalex-source.json', import.meta.url), 'utf8'),
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
