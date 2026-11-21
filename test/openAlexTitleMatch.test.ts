import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { buildTitleSearchUrl, normalizeTitleSearch, pickTitleMatch } from '../src/modules/openAlexTitleMatch.core.ts'

import type { TitleCandidateWork } from '../src/modules/openAlexTitleMatch.core.ts'

// Real OpenAlex responses to the search request, recorded 2026-11-21 for items
// in the maintainer's library that carry no DOI.
const fixture = (name: string): TitleCandidateWork[] =>
  normalizeTitleSearch(
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'openalex-title', `${name}.json`), 'utf8')),
  )

describe('buildTitleSearchUrl', () => {
  it('searches the title without punctuation OpenAlex would read as syntax, keeping accents', () => {
    const url = buildTitleSearchUrl('Numerik linearer Gleichungssysteme: direkte, iterative Verfahren | für alle')
    assert.ok(url)
    const filter = new URL(url).searchParams.get('filter')
    assert.equal(filter, 'title.search:Numerik linearer Gleichungssysteme direkte iterative Verfahren für alle')
  })

  it('refuses a title too short or generic to search for', () => {
    assert.equal(buildTitleSearchUrl('Introduction'), null)
    assert.equal(buildTitleSearchUrl(''), null)
  })
})

describe('pickTitleMatch on recorded searches', () => {
  it('finds a book by title and author in the same edition', () => {
    const match = pickTitleMatch(
      {
        title: 'Electromagnetic fields and energy',
        year: 1989,
        creators: [
          { lastName: 'Haus', firstName: 'Hermann A.' },
          { lastName: 'Melcher', firstName: 'James R.' },
        ],
      },
      fixture('haus-melcher'),
    )
    assert.ok(match)
    assert.equal(match.work.id, 'W1565680857')
    assert.equal(match.sameEdition, true)
  })

  it('takes another edition when that is all OpenAlex holds, and says so', () => {
    const match = pickTitleMatch(
      {
        title: 'Principles of corporate finance',
        year: 2023,
        creators: [
          { lastName: 'Brealey', firstName: 'Richard A.' },
          { lastName: 'Myers', firstName: 'Stewart C.' },
        ],
      },
      fixture('corporate-finance'),
    )
    assert.ok(match)
    assert.equal(match.sameEdition, false)
    assert.ok(match.work.authors.some((name) => /Brealey/i.test(name)))
  })

  it('picks the revision closest in year, then the most cited, among same-titled reports', () => {
    const match = pickTitleMatch(
      {
        title: 'Noncontact Measurement of the Exit Temperature of Sheet Metal in an Operating Rolling Mill',
        year: 1998,
        creators: [
          { lastName: 'Kahn', firstName: 'Arnold H.' },
          { lastName: 'Schaps', firstName: 'Stephen R.' },
        ],
      },
      fixture('nist'),
    )
    // Two 1998 revisions and a 1996 one; the 1998 record with a citation wins.
    assert.equal(match?.work.id, 'W4299099953')
    assert.equal(match?.sameEdition, true)
  })
})

describe('pickTitleMatch guards', () => {
  const work = (over: Partial<TitleCandidateWork>): TitleCandidateWork => ({
    id: 'W1',
    doi: null,
    title: 'Electromagnetic fields and energy',
    year: 1989,
    citedByCount: 10,
    authors: ['Hermann A. Haus'],
    ...over,
  })
  const query = {
    title: 'Electromagnetic fields and energy',
    year: 1989,
    creators: [{ lastName: 'Haus', firstName: 'Hermann' }],
  }

  it('needs the same title, not a longer one', () => {
    assert.equal(pickTitleMatch(query, [work({ title: 'Electromagnetic fields and energy in plasmas' })]), null)
  })

  it('needs an author agreeing on surname and initial', () => {
    assert.equal(pickTitleMatch(query, [work({ authors: ['Jane Haus'] })]), null)
    assert.equal(pickTitleMatch(query, [work({ authors: ['Hermann A. Melcher'] })]), null)
  })

  it('does not guess for an item whose authors have no first names', () => {
    assert.equal(pickTitleMatch({ ...query, creators: [{ lastName: 'COMSOL AB', firstName: '' }] }, [work({})]), null)
  })

  it('refuses a generic title', () => {
    assert.equal(pickTitleMatch({ ...query, title: 'Introduction' }, [work({ title: 'Introduction' })]), null)
  })

  it('among editions prefers the closest year, then the most cited', () => {
    const editions = [
      work({ id: 'W10', year: 1975, citedByCount: 900 }),
      work({ id: 'W11', year: 1990, citedByCount: 5 }),
      work({ id: 'W12', year: 1990, citedByCount: 50 }),
    ]
    assert.equal(pickTitleMatch(query, editions)?.work.id, 'W12')
  })

  it('without a year on the item, takes the most cited edition', () => {
    const editions = [work({ id: 'W10', year: 1975, citedByCount: 900 }), work({ id: 'W11', year: 1990 })]
    const match = pickTitleMatch({ ...query, year: null }, editions)
    assert.equal(match?.work.id, 'W10')
    assert.equal(match?.sameEdition, false)
  })
})

describe('normalizeTitleSearch', () => {
  it('skips malformed entries and strips id and DOI prefixes', () => {
    const works = normalizeTitleSearch({
      results: [
        null,
        { id: 'https://openalex.org/A1', display_name: 'An author, not a work' },
        {
          id: 'https://openalex.org/W5',
          doi: 'https://doi.org/10.1/X',
          display_name: 'A title',
          publication_year: 2001,
          cited_by_count: 3,
          authorships: [{ author: { display_name: 'Ann Lee' } }, { author: {} }],
        },
      ],
    })
    assert.deepEqual(works, [
      { id: 'W5', doi: '10.1/X', title: 'A title', year: 2001, citedByCount: 3, authors: ['Ann Lee'] },
    ])
  })

  it('returns nothing for a body without results', () => {
    assert.deepEqual(normalizeTitleSearch({ error: 'x' }), [])
    assert.deepEqual(normalizeTitleSearch(null), [])
  })
})
