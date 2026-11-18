import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { setOpenAlexContact } from '../src/modules/openAlexClient.core.ts'
import {
  buildCitingAnyUrl,
  buildWorksListUrl,
  CITING_SELECT,
  LIST_PAGE_MAX,
  normalizeNetworkWorks,
  OR_FILTER_MAX,
  pageMeta,
  SEED_SELECT,
  SHARED_SELECT,
} from '../src/modules/openAlexNetwork.core.ts'

/**
 * Recorded from the live API with SEED_SELECT and CITING_SELECT, then trimmed:
 * two results each, five referenced works each, authorships without
 * affiliations. `referenced_works_count` is the untrimmed figure.
 */
const seedsFixture: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/openalex-network-seeds.json'), 'utf8'),
)
const citingFixture: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/openalex-network-citing.json'), 'utf8'),
)

function params(url: string): URLSearchParams {
  return new URL(url).searchParams
}

const hundredIds = Array.from({ length: 100 }, (_, at) => `W${1000 + at}`)

afterEach(() => setOpenAlexContact(''))

describe('the limits', () => {
  it('match what OpenAlex documents', () => {
    assert.equal(LIST_PAGE_MAX, 100)
    assert.equal(OR_FILTER_MAX, 100)
  })
})

describe('buildWorksListUrl', () => {
  it('puts a hundred ids in one OR filter, a full page and the select', () => {
    const url = buildWorksListUrl('openalex_id', hundredIds, SHARED_SELECT)
    const query = params(url)
    assert.ok(url.startsWith('https://api.openalex.org/works?'))
    assert.equal(query.get('filter'), `openalex_id:${hundredIds.join('|')}`)
    assert.equal(query.get('per-page'), '100')
    assert.equal(query.get('select'), SHARED_SELECT)
  })

  it('throws past a hundred values rather than sending a request OpenAlex rejects', () => {
    assert.throws(() => buildWorksListUrl('openalex_id', [...hundredIds, 'W1'], SHARED_SELECT), RangeError)
  })

  it('strips the OpenAlex prefix from ids', () => {
    const url = buildWorksListUrl('openalex_id', ['https://openalex.org/W2064675550', ' W2919115771 '], SEED_SELECT)
    assert.equal(params(url).get('filter'), 'openalex_id:W2064675550|W2919115771')
  })

  it('normalizes DOIs to bare and lower-case, and keeps the separator literal', () => {
    const url = buildWorksListUrl(
      'doi',
      ['https://doi.org/10.1038/NATURE14539', 'doi:10.1162/neco.1997.9.8.1735', '10.1000/a|b'],
      SEED_SELECT,
    )
    // The pipe inside the third DOI is encoded; the separators are not.
    assert.match(url, /filter=doi:10\.1038%2Fnature14539\|10\.1162%2Fneco\.1997\.9\.8\.1735\|10\.1000%2Fa%7Cb&/)
  })

  it('reduces PubMed URLs to their digits', () => {
    const url = buildWorksListUrl('ids.pmid', ['https://pubmed.ncbi.nlm.nih.gov/9377276', '26017442'], SEED_SELECT)
    assert.equal(params(url).get('filter'), 'ids.pmid:9377276|26017442')
  })

  it('carries the contact only when one is set', () => {
    assert.equal(params(buildWorksListUrl('doi', ['10.1/x'], SEED_SELECT)).get('mailto'), null)
    setOpenAlexContact('someone@example.org')
    assert.equal(params(buildWorksListUrl('doi', ['10.1/x'], SEED_SELECT)).get('mailto'), 'someone@example.org')
  })
})

describe('buildCitingAnyUrl', () => {
  it('asks for works citing any of a hundred seeds, first page by `*`', () => {
    const url = buildCitingAnyUrl(hundredIds, '*', CITING_SELECT)
    const query = params(url)
    assert.equal(query.get('filter'), `cites:${hundredIds.join('|')}`)
    assert.equal(query.get('per-page'), '100')
    assert.equal(query.get('cursor'), '*')
    assert.equal(query.get('select'), CITING_SELECT)
  })

  it('passes a recorded cursor through intact', () => {
    const cursor = pageMeta(citingFixture).nextCursor
    assert.ok(cursor)
    const url = buildCitingAnyUrl(['https://openalex.org/W2919115771'], cursor, CITING_SELECT)
    // A cursor ends in `==`; unencoded it would be split as a parameter.
    assert.equal(params(url).get('cursor'), cursor)
    assert.equal(params(url).get('filter'), 'cites:W2919115771')
  })

  it('throws past a hundred seeds', () => {
    assert.throws(() => buildCitingAnyUrl([...hundredIds, 'W1'], '*', CITING_SELECT), RangeError)
  })

  it('carries the contact only when one is set', () => {
    assert.equal(params(buildCitingAnyUrl(['W1'], '*', CITING_SELECT)).get('mailto'), null)
    setOpenAlexContact('someone@example.org')
    assert.equal(params(buildCitingAnyUrl(['W1'], '*', CITING_SELECT)).get('mailto'), 'someone@example.org')
  })
})

describe('normalizeNetworkWorks', () => {
  it('reads a seed page into bare ids, DOIs, PMIDs, authors and topics', () => {
    const works = normalizeNetworkWorks(seedsFixture)
    assert.equal(works.length, 2)
    const lstm = works.find((work) => work.openAlexId === 'W2064675550')
    assert.ok(lstm)
    assert.equal(lstm.doi, '10.1162/neco.1997.9.8.1735')
    assert.equal(lstm.pmid, '9377276')
    assert.equal(lstm.title, 'Long Short-Term Memory')
    assert.equal(lstm.year, 1997)
    assert.equal(typeof lstm.citedByCount, 'number')
    assert.equal(lstm.referenceCount, 34)
    assert.deepEqual(lstm.authors, ['Sepp Hochreiter', 'Jürgen Schmidhuber'])
    assert.equal(lstm.referencedWorks.length, 5)
    for (const id of lstm.referencedWorks) assert.match(id, /^W\d+$/)
    assert.deepEqual(lstm.primaryTopic, { id: 'T10320', name: 'Neural Networks and Applications' })
  })

  it('reads a citing page, which has no topic', () => {
    const works = normalizeNetworkWorks(citingFixture)
    assert.equal(works.length, 2)
    for (const work of works) {
      assert.match(work.openAlexId, /^W\d+$/)
      assert.equal(work.primaryTopic, null)
      assert.ok(work.authors.length > 0)
      assert.ok(work.referencedWorks.length > 0)
    }
  })

  it('gives empty fields, not missing ones, for what a select left out', () => {
    const [work] = normalizeNetworkWorks({ results: [{ id: 'https://openalex.org/W1' }] })
    assert.deepEqual(work, {
      openAlexId: 'W1',
      doi: null,
      pmid: null,
      title: null,
      year: null,
      citedByCount: null,
      referenceCount: null,
      authors: [],
      referencedWorks: [],
      primaryTopic: null,
    })
  })

  it('drops entries without an id and survives junk', () => {
    assert.deepEqual(normalizeNetworkWorks(null), [])
    assert.deepEqual(normalizeNetworkWorks({ results: 'nope' }), [])
    const works = normalizeNetworkWorks({
      results: [
        null,
        { display_name: 'no id' },
        {
          id: 'W2',
          doi: 'https://doi.org/10.1/ABC',
          authorships: [{ author: { display_name: '' } }, { author: null }, { author: { display_name: 'A B' } }],
          referenced_works: ['https://openalex.org/W3', 7, ''],
          primary_topic: { id: 'https://openalex.org/T1' },
          ids: { pmid: 'not-a-pmid' },
        },
      ],
    })
    assert.equal(works.length, 1)
    assert.equal(works[0].doi, '10.1/abc')
    assert.equal(works[0].pmid, null)
    assert.deepEqual(works[0].authors, ['A B'])
    assert.deepEqual(works[0].referencedWorks, ['W3'])
    assert.equal(works[0].primaryTopic, null)
  })
})

describe('pageMeta', () => {
  it('reads the total and the next cursor of a cursor page', () => {
    const meta = pageMeta(citingFixture)
    assert.equal(typeof meta.count, 'number')
    assert.ok((meta.count ?? 0) > 2)
    assert.equal(typeof meta.nextCursor, 'string')
  })

  it('has no cursor on a plain page', () => {
    assert.deepEqual(pageMeta(seedsFixture), { count: 2, nextCursor: null })
  })

  it('survives a body without meta', () => {
    assert.deepEqual(pageMeta(null), { count: null, nextCursor: null })
    assert.deepEqual(pageMeta({ meta: { count: 'x', next_cursor: null } }), { count: null, nextCursor: null })
  })
})
