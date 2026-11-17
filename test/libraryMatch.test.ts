/**
 * Which identifiers make a library item and a cited work the same paper.
 *
 * A wrongly drawn "in your library" mark sends the reader to the wrong paper,
 * which is worse than no mark. So half of this file is about what must *not*
 * become an identifier.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { findInLibrary, itemKeys, normalizeDoi, workKeys } from '../src/modules/libraryMatch.core.ts'

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
