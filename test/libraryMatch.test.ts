/**
 * Which identifiers make a library item and a cited work the same paper.
 *
 * A wrongly drawn "in your library" mark sends the reader to the wrong paper,
 * which is worse than no mark. So half of this file is about what must *not*
 * become an identifier.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  creatorAuthor,
  findInLibrary,
  itemKeys,
  matchInLibrary,
  normalizeDoi,
  normalizeTitle,
  parseAuthor,
  titleKey,
  workKeys,
} from '../src/modules/libraryMatch.core.ts'

import type { LibraryMatcher, TitleCandidate } from '../src/modules/libraryMatch.core.ts'

describe('normalizeDoi', () => {
  it('drops resolver prefixes, case and surrounding space', () => {
    assert.equal(normalizeDoi('10.1000/ABC'), '10.1000/abc')
    assert.equal(normalizeDoi('  10.1000/abc \n'), '10.1000/abc')
    assert.equal(normalizeDoi('https://doi.org/10.1000/ABC'), '10.1000/abc')
    assert.equal(normalizeDoi('http://dx.doi.org/10.1000/abc'), '10.1000/abc')
    assert.equal(normalizeDoi('doi:10.1000/abc'), '10.1000/abc')
  })
})

describe('itemKeys: where an item has identifiers', () => {
  it('reads the DOI field', () => {
    assert.deepEqual(itemKeys({ doi: 'https://doi.org/10.1/ABC' }), ['doi:10.1/abc'])
  })

  it('reads a DOI line in Extra, for types without a DOI field', () => {
    assert.deepEqual(itemKeys({ extra: 'Publisher: X\nDOI: 10.1/abc\n' }), ['doi:10.1/abc'])
  })

  it('reads arXiv from archiveID, an arxiv.org URL and an Extra line, without version or case', () => {
    assert.deepEqual(itemKeys({ archiveID: 'arXiv:1706.03762' }), ['arxiv:1706.03762'])
    assert.deepEqual(itemKeys({ url: 'https://arxiv.org/abs/1706.03762v5' }), ['arxiv:1706.03762'])
    assert.deepEqual(itemKeys({ url: 'http://arxiv.org/pdf/hep-th/9711200v3' }), ['arxiv:hep-th/9711200'])
    assert.deepEqual(itemKeys({ extra: 'arXiv: 1706.03762v2' }), ['arxiv:1706.03762'])
    // What Zotero's arXiv translator writes: the id, then the category.
    assert.deepEqual(itemKeys({ extra: 'arXiv:1810.04805 [cs.CL]\nversion: 2' }), ['arxiv:1810.04805'])
    assert.deepEqual(itemKeys({ extra: 'arXiv:1107.4612 [astro-ph.CO]' }), ['arxiv:1107.4612'])
    assert.deepEqual(itemKeys({ extra: 'arXiv:math/0211159' }), ['arxiv:math/0211159'])
  })

  it('reads arXiv from the DOI arXiv mints, and keeps the DOI too', () => {
    assert.deepEqual(itemKeys({ doi: '10.48550/arXiv.1706.03762' }), [
      'doi:10.48550/arxiv.1706.03762',
      'arxiv:1706.03762',
    ])
  })

  it('reads a PMID line in Extra', () => {
    assert.deepEqual(itemKeys({ extra: 'PMID: 9377276\nPMCID: PMC123' }), ['pmid:9377276'])
  })

  it('collects every identifier an item has, once each', () => {
    assert.deepEqual(
      itemKeys({
        doi: '10.1162/neco.1997.9.8.1735',
        extra: 'PMID: 9377276\nDOI: 10.1162/NECO.1997.9.8.1735',
        archiveID: 'arXiv:1706.03762',
        url: 'https://arxiv.org/abs/1706.03762',
      }),
      ['doi:10.1162/neco.1997.9.8.1735', 'arxiv:1706.03762', 'pmid:9377276'],
    )
  })

  it('has none for an item without identifiers', () => {
    assert.deepEqual(itemKeys({}), [])
    assert.deepEqual(itemKeys({ doi: '', extra: '', archiveID: '', url: '' }), [])
  })
})

describe('itemKeys: what must not become an identifier', () => {
  it("ignores Orbit's own Citations lines and other numbers in Extra", () => {
    const extra = [
      'Citations: 2021 (Crossref) [2026-11-17]',
      '1706.03762 citations (Semantic Scholar/arXiv) [2026-11-17]',
      'Original Date: 2017.06123',
    ].join('\n')
    assert.deepEqual(itemKeys({ extra }), [])
  })

  it('does not take an arXiv-shaped number out of a DOI that is not an arXiv DOI', () => {
    assert.deepEqual(itemKeys({ doi: '10.1109/cvpr.2016.90123' }), ['doi:10.1109/cvpr.2016.90123'])
  })

  it('does not read arXiv from an archiveID of another archive', () => {
    assert.deepEqual(itemKeys({ archiveID: 'JSTOR:1706.03762' }), [])
  })

  it('does not read arXiv from a URL that is not arxiv.org', () => {
    assert.deepEqual(itemKeys({ url: 'https://example.org/papers/1706.03762' }), [])
  })

  it('does not read an Extra line whose value carries more than the identifier', () => {
    assert.deepEqual(itemKeys({ extra: 'arXiv: 1706.03762 and 1810.04805' }), [])
    assert.deepEqual(itemKeys({ extra: 'arXiv: 1706.03762 [cs.CL] and more' }), [])
    assert.deepEqual(itemKeys({ extra: 'PMID: 12345 (retracted)' }), [])
  })

  it('does not read a label in the middle of a line', () => {
    assert.deepEqual(itemKeys({ extra: 'see arXiv: 1706.03762' }), [])
    assert.deepEqual(itemKeys({ extra: 'Note: PMID: 9377276' }), [])
  })

  it('does not take a PMID that is not digits', () => {
    assert.deepEqual(itemKeys({ extra: 'PMID: PMC9377276' }), [])
  })
})

describe('workKeys', () => {
  it('orders DOI before arXiv before PubMed', () => {
    assert.deepEqual(workKeys({ pmid: '9377276', arxiv: '1706.03762', doi: '10.1/A' }), [
      'doi:10.1/a',
      'arxiv:1706.03762',
      'pmid:9377276',
    ])
  })

  it('derives arXiv from an arXiv DOI without listing it twice', () => {
    assert.deepEqual(workKeys({ doi: '10.48550/arXiv.1706.03762', arxiv: '1706.03762' }), [
      'doi:10.48550/arxiv.1706.03762',
      'arxiv:1706.03762',
    ])
  })

  it('drops values that are not identifiers', () => {
    assert.deepEqual(workKeys({ doi: '  ', arxiv: 'not an id', pmid: 'PMC1' }), [])
    assert.deepEqual(workKeys({ doi: null, arxiv: null, pmid: null }), [])
    assert.deepEqual(workKeys({}), [])
  })
})

describe('findInLibrary', () => {
  const index = new Map([
    ['doi:10.1/published', 1],
    ['arxiv:1706.03762', 2],
    ['pmid:9377276', 3],
  ])

  it('finds a work by any identifier it shares with an item', () => {
    assert.equal(findInLibrary(index, { doi: 'https://doi.org/10.1/PUBLISHED' }), 1)
    assert.equal(findInLibrary(index, { doi: null, arxiv: '1706.03762v7' }), 2)
    assert.equal(findInLibrary(index, { pmid: '9377276' }), 3)
    assert.equal(findInLibrary(index, { doi: '10.48550/arXiv.1706.03762' }), 2)
  })

  it('prefers the DOI when identifiers point at different items', () => {
    // A published version and its preprint, both on the shelf: the DOI names
    // the version that was cited.
    assert.equal(findInLibrary(index, { doi: '10.1/published', arxiv: '1706.03762' }), 1)
  })

  it('falls back to arXiv when the DOI is not in the library', () => {
    // The published version was cited, the preprint is on the shelf. Same
    // paper, so it counts.
    assert.equal(findInLibrary(index, { doi: '10.1/elsewhere', arxiv: '1706.03762' }), 2)
  })

  it('finds nothing for a work that shares no identifier', () => {
    assert.equal(findInLibrary(index, { doi: '10.1/other', arxiv: '1810.04805', pmid: '1' }), null)
    assert.equal(findInLibrary(index, {}), null)
  })
})

describe('normalizeTitle and titleKey', () => {
  it('folds accents, case, punctuation, markup and spacing', () => {
    assert.equal(normalizeTitle('Étude  sur les réseaux—NEURONAUX!'), 'etude sur les reseaux neuronaux')
    assert.equal(normalizeTitle('  The <i>E. coli</i> genome: a survey '), 'the e coli genome a survey')
    assert.equal(normalizeTitle('Long Short-Term Memory'), 'long short term memory')
    // Compatibility forms: a ligature and full-width digits fold to plain ones.
    assert.equal(normalizeTitle('Eﬃcient models in 2００'), 'efficient models in 200')
  })

  it('keeps letters of every script, not only Latin', () => {
    assert.equal(normalizeTitle('Über Größe & Maß'), 'uber große maß')
    assert.equal(normalizeTitle('Модели языка'), 'модели языка')
  })

  it('refuses titles too short or generic to identify a work', () => {
    assert.equal(titleKey('Introduction'), null)
    assert.equal(titleKey('Editorial'), null)
    assert.equal(titleKey('Book Reviews'), null)
    // Three words, but under twenty characters.
    assert.equal(titleKey('A New Model'), null)
    // Twenty characters, but two words.
    assert.equal(titleKey('Thermodynamics Revisited'), null)
    assert.equal(titleKey(''), null)
    assert.equal(titleKey(null), null)
    assert.equal(titleKey('Attention Is All You Need'), 'attention is all you need')
  })
})

describe('parseAuthor', () => {
  it('reads "Given Family"', () => {
    assert.deepEqual(parseAuthor('Ashish Vaswani'), { surname: 'vaswani', initial: 'a' })
    assert.deepEqual(parseAuthor('J. R. R. Tolkien'), { surname: 'tolkien', initial: 'j' })
    assert.deepEqual(parseAuthor('J. Smith'), { surname: 'smith', initial: 'j' })
  })

  it('reads "Family, Given"', () => {
    assert.deepEqual(parseAuthor('Smith, John'), { surname: 'smith', initial: 'j' })
    assert.deepEqual(parseAuthor('Smith, J.'), { surname: 'smith', initial: 'j' })
    assert.deepEqual(parseAuthor('van der Berg, Jan'), { surname: 'van der berg', initial: 'j' })
  })

  it('keeps particles with the surname, and drops a generational suffix', () => {
    assert.deepEqual(parseAuthor('Jan van der Berg'), { surname: 'van der berg', initial: 'j' })
    assert.deepEqual(parseAuthor('Ludwig von Mises'), { surname: 'von mises', initial: 'l' })
    assert.deepEqual(parseAuthor('Martin Luther King Jr.'), { surname: 'king', initial: 'm' })
  })

  it('folds accents and keeps hyphenated surnames whole', () => {
    assert.deepEqual(parseAuthor('Émile Durkheim'), { surname: 'durkheim', initial: 'e' })
    assert.deepEqual(parseAuthor('Anna Müller-Lüdenscheidt'), { surname: 'muller ludenscheidt', initial: 'a' })
  })

  it('gives a single name no initial, and nothing for an empty one', () => {
    assert.deepEqual(parseAuthor('Plato'), { surname: 'plato', initial: null })
    assert.deepEqual(parseAuthor('Smith,'), { surname: 'smith', initial: null })
    assert.equal(parseAuthor(''), null)
    assert.equal(parseAuthor('  ,  '), null)
  })
})

describe('creatorAuthor', () => {
  it('folds a Zotero creator the same way as a parsed name', () => {
    assert.deepEqual(creatorAuthor('Müller', 'Jürgen'), parseAuthor('Jürgen Müller'))
    assert.deepEqual(creatorAuthor('van der Berg', 'J.'), parseAuthor('Jan van der Berg'))
    assert.deepEqual(creatorAuthor('World Health Organization', ''), {
      surname: 'world health organization',
      initial: null,
    })
    assert.equal(creatorAuthor('', 'Jan'), null)
  })
})

describe('matchInLibrary', () => {
  const TITLE = 'A Theory of Everything in Particular'
  const smith = { surname: 'smith', initial: 'j' }

  function candidate(itemID: number, overrides: Partial<TitleCandidate> = {}): TitleCandidate {
    return { itemID, year: 2010, authors: [smith], keys: [], ...overrides }
  }

  function matcher(candidates: TitleCandidate[], ids: [string, number][] = []): LibraryMatcher {
    return { ids: new Map(ids), titles: new Map([[normalizeTitle(TITLE), candidates]]) }
  }

  const work = { title: TITLE, year: 2010, authors: ['John Smith'] }

  describe('the identifier route', () => {
    it('is exact, and says which identifier matched', () => {
      const ids: [string, number][] = [
        ['doi:10.1/a', 1],
        ['arxiv:1706.03762', 2],
        ['pmid:9377276', 3],
      ]
      const m = matcher([], ids)
      assert.deepEqual(matchInLibrary(m, { doi: '10.1/A' }), { itemID: 1, confidence: 'exact', via: 'doi' })
      assert.deepEqual(matchInLibrary(m, { arxiv: '1706.03762v2' }), { itemID: 2, confidence: 'exact', via: 'arxiv' })
      assert.deepEqual(matchInLibrary(m, { pmid: '9377276' }), { itemID: 3, confidence: 'exact', via: 'pmid' })
      // An arXiv DOI the library holds only as an arXiv id.
      assert.deepEqual(matchInLibrary(m, { doi: '10.48550/arXiv.1706.03762' }), {
        itemID: 2,
        confidence: 'exact',
        via: 'arxiv',
      })
    })

    it('runs in findInLibrary order and wins over a title match', () => {
      const m = matcher([candidate(9)], [['doi:10.1/a', 1]])
      assert.deepEqual(matchInLibrary(m, { ...work, doi: '10.1/a' }), { itemID: 1, confidence: 'exact', via: 'doi' })
    })
  })

  describe('the title route', () => {
    it('is probable when title, year and an author agree', () => {
      assert.deepEqual(matchInLibrary(matcher([candidate(7)]), work), {
        itemID: 7,
        confidence: 'probable',
        via: 'title',
      })
    })

    it('ignores accents, punctuation and case in the title', () => {
      const m: LibraryMatcher = {
        ids: new Map(),
        titles: new Map([[normalizeTitle('Étude des réseaux neuronaux profonds'), [candidate(7)]]]),
      }
      const accented = { ...work, title: 'ETUDE des reseaux: neuronaux, profonds.' }
      assert.equal(matchInLibrary(m, accented)?.itemID, 7)
    })

    it('matches "Family, Given" against "Given Family", and particles in full', () => {
      assert.equal(matchInLibrary(matcher([candidate(7)]), { ...work, authors: ['Smith, J.'] })?.itemID, 7)
      const berg = candidate(8, { authors: [{ surname: 'van der berg', initial: 'j' }] })
      assert.equal(matchInLibrary(matcher([berg]), { ...work, authors: ['Jan van der Berg'] })?.itemID, 8)
    })

    it('allows a year either side, for online-first versus issue', () => {
      assert.equal(matchInLibrary(matcher([candidate(7, { year: 2011 })]), work)?.itemID, 7)
      assert.equal(matchInLibrary(matcher([candidate(7, { year: 2009 })]), work)?.itemID, 7)
    })

    it('needs only one shared author among several', () => {
      const others = { surname: 'doe', initial: 'a' }
      const m = matcher([candidate(7, { authors: [others, smith] })])
      assert.equal(matchInLibrary(m, { ...work, authors: ['Ann Roe', 'John Smith'] })?.itemID, 7)
    })

    it('accepts identifiers on both sides that agree, or on one side only', () => {
      const withDoi = candidate(7, { keys: ['doi:10.1/a', 'pmid:1'] })
      // Not in `ids` (as with a duplicate the index kept the other copy of), so
      // the title route is reached; the identifiers agree.
      assert.equal(matchInLibrary(matcher([withDoi]), { ...work, doi: '10.1/a' })?.confidence, 'probable')
      assert.equal(matchInLibrary(matcher([withDoi]), work)?.itemID, 7)
      assert.equal(matchInLibrary(matcher([candidate(7)]), { ...work, doi: '10.1/a' })?.itemID, 7)
      // A different namespace on each side is no disagreement.
      assert.equal(matchInLibrary(matcher([withDoi]), { ...work, arxiv: '1706.03762' })?.itemID, 7)
    })
  })

  describe('what must not match by title', () => {
    it('a year off by two', () => {
      assert.equal(matchInLibrary(matcher([candidate(7, { year: 2012 })]), work), null)
      assert.equal(matchInLibrary(matcher([candidate(7, { year: 2008 })]), work), null)
    })

    it('a year missing on either side', () => {
      assert.equal(matchInLibrary(matcher([candidate(7, { year: null })]), work), null)
      assert.equal(matchInLibrary(matcher([candidate(7)]), { ...work, year: null }), null)
      assert.equal(matchInLibrary(matcher([candidate(7)]), { title: TITLE, authors: ['John Smith'] }), null)
    })

    it('the same surname with a different initial', () => {
      assert.equal(matchInLibrary(matcher([candidate(7)]), { ...work, authors: ['K. Smith'] }), null)
    })

    it('a surname with no initial on one side', () => {
      // A bare "Smith" is too common to vouch for a match, from either side.
      assert.equal(matchInLibrary(matcher([candidate(7)]), { ...work, authors: ['Smith'] }), null)
      const bare = candidate(7, { authors: [{ surname: 'smith', initial: null }] })
      assert.equal(matchInLibrary(matcher([bare]), work), null)
    })

    it('no authors on either side', () => {
      assert.equal(matchInLibrary(matcher([candidate(7)]), { ...work, authors: [] }), null)
      assert.equal(matchInLibrary(matcher([candidate(7)]), { ...work, authors: null }), null)
      assert.equal(matchInLibrary(matcher([candidate(7, { authors: [] })]), work), null)
    })

    it('a conflicting DOI', () => {
      const m = matcher([candidate(7, { keys: ['doi:10.1/a'] })])
      assert.equal(matchInLibrary(m, { ...work, doi: '10.1/b' }), null)
    })

    it('a conflicting PMID', () => {
      const m = matcher([candidate(7, { keys: ['pmid:111'] })])
      assert.equal(matchInLibrary(m, { ...work, pmid: '222' }), null)
    })

    it('a conflicting arXiv id', () => {
      const m = matcher([candidate(7, { keys: ['arxiv:1706.03762'] })])
      assert.equal(matchInLibrary(m, { ...work, arxiv: '1810.04805' }), null)
    })

    it('a journal DOI against the arXiv DOI of the preprint', () => {
      // Strict on purpose: two DOIs are two registered works, even when one
      // is the preprint of the other.
      const m = matcher([candidate(7, { keys: ['doi:10.48550/arxiv.1706.03762', 'arxiv:1706.03762'] })])
      assert.equal(matchInLibrary(m, { ...work, doi: '10.1/journal' }), null)
    })

    it('two library items that both fit', () => {
      assert.equal(matchInLibrary(matcher([candidate(7), candidate(8)]), work), null)
    })

    it('but one fitting item beside one ruled out is still a match', () => {
      assert.equal(matchInLibrary(matcher([candidate(7), candidate(8, { year: 1990 })]), work)?.itemID, 7)
    })

    it('a different title, however close', () => {
      assert.equal(matchInLibrary(matcher([candidate(7)]), { ...work, title: `${TITLE}, Part II` }), null)
    })

    it('short generic titles, even with everything else agreeing', () => {
      const m: LibraryMatcher = { ids: new Map(), titles: new Map([['introduction', [candidate(7)]]]) }
      assert.equal(matchInLibrary(m, { ...work, title: 'Introduction' }), null)
    })

    it('a work with no title', () => {
      assert.equal(matchInLibrary(matcher([candidate(7)]), { ...work, title: null }), null)
    })
  })
})
