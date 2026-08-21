import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildScholarUrl,
  extractResultTitle,
  hasCitationResults,
  hasRecaptcha,
  parseScholarCount,
  stripTitleMarkup,
  TITLE_MATCH_THRESHOLD,
  titleSimilarity,
} from '../src/modules/googleScholarClient.core.ts'
import { stripCitationLines } from '../src/utils/extraField.ts'

describe('stripTitleMarkup', () => {
  it('removes the markup Zotero stores in titles', () => {
    assert.equal(stripTitleMarkup('Effects of <i>E. coli</i> on H<sub>2</sub>O'), 'Effects of E. coli on H2O')
  })

  it('collapses the whitespace the markup leaves behind', () => {
    assert.equal(stripTitleMarkup('A  <b>bold</b>\n  claim'), 'A bold claim')
  })
})

describe('buildScholarUrl', () => {
  const base = { endpoint: 'https://scholar.google.com', title: 'Attention is all you need', authors: [] }

  it('quotes the title so a loose match cannot return a different paper', () => {
    const url = new URL(buildScholarUrl(base))
    assert.equal(url.searchParams.get('q'), '"Attention is all you need"')
    assert.equal(url.searchParams.get('as_occt'), 'title')
  })

  it('leaves the title unquoted when fuzzy matching is asked for', () => {
    const url = new URL(buildScholarUrl({ ...base, fuzzyTitle: true }))
    assert.equal(url.searchParams.get('q'), 'Attention is all you need')
  })

  it('joins surnames with + and caps them at five', () => {
    const authors = ['Vaswani', 'Shazeer', 'Parmar', 'Uszkoreit', 'Jones', 'Gomez', 'Kaiser']
    const url = new URL(buildScholarUrl({ ...base, authors, matchAuthors: true }))
    assert.equal(url.searchParams.get('as_sauthors'), 'Vaswani+Shazeer+Parmar+Uszkoreit+Jones')
  })

  it('omits the author parameter when not requested', () => {
    const url = new URL(buildScholarUrl({ ...base, authors: ['Vaswani'] }))
    assert.equal(url.searchParams.get('as_sauthors'), null)
  })

  it('brackets the publication year when a date range is requested', () => {
    const url = new URL(buildScholarUrl({ ...base, year: 2017, dateRange: true }))
    assert.equal(url.searchParams.get('as_ylo'), '2015')
    assert.equal(url.searchParams.get('as_yhi'), '2019')
  })

  it('ignores a date range when the item has no usable year', () => {
    const url = new URL(buildScholarUrl({ ...base, dateRange: true }))
    assert.equal(url.searchParams.get('as_ylo'), null)
  })

  it('tolerates an endpoint with or without a trailing slash', () => {
    const withSlash = buildScholarUrl({ ...base, endpoint: 'https://scholar.google.de/' })
    const without = buildScholarUrl({ ...base, endpoint: 'https://scholar.google.de' })
    assert.equal(withSlash, without)
    assert.ok(withSlash.startsWith('https://scholar.google.de/scholar?'))
  })

  it('escapes a title that would otherwise break the query string', () => {
    const url = new URL(buildScholarUrl({ ...base, title: 'Law & Order: "policy" #3' }))
    assert.equal(url.searchParams.get('q'), '"Law & Order: "policy" #3"')
  })

  it('refuses to search with an empty title', () => {
    assert.throws(() => buildScholarUrl({ ...base, title: '   ' }), /without a title/)
  })
})

describe('hasRecaptcha', () => {
  it('detects the injected challenge', () => {
    assert.equal(hasRecaptcha('<script src="//www.google.com/recaptcha/api.js?onload=cb"></script>'), true)
  })

  it('does not fire on a bare script include', () => {
    assert.equal(hasRecaptcha('<script src="//www.google.com/recaptcha/api.js"></script>'), false)
  })
})

describe('parseScholarCount', () => {
  it('reads the count out of the Cited by link', () => {
    assert.equal(parseScholarCount('<a href="/scholar?cites=123">Cited by 1981</a>'), 1981)
  })

  it('returns 0 for a result that is present but uncited', () => {
    assert.equal(parseScholarCount('<h3 class="gs_rt"><a>Some obscure paper</a></h3>'), 0)
  })

  it('returns null when nothing matched, rather than claiming zero citations', () => {
    // This is the distinction that makes a scraper trustworthy: "not found"
    // must not be recorded as "found, and uncited".
    assert.equal(parseScholarCount('<div id="gs_res_ccl_mid"></div>'), null)
  })

  it('returns null when the count is not a number', () => {
    assert.equal(parseScholarCount('<a>Cited by many</a>'), null)
  })

  it('honours a localised Cited by prefix', () => {
    assert.equal(parseScholarCount('<a>Zitiert durch: 42</a>', 'Zitiert durch:'), 42)
  })
})

describe('hasCitationResults', () => {
  it('recognises the result container', () => {
    assert.equal(hasCitationResults('<div class="gs_r gs_or gs_scl">'), true)
  })

  it('reports nothing for an empty page', () => {
    assert.equal(hasCitationResults('<html><body></body></html>'), false)
  })
})

describe('stripCitationLines', () => {
  it('removes a stamp whose source label is empty', () => {
    // Regression: a dispatch branch that failed to resolve its display name
    // wrote `Citations: 1 () [...]`. That matches no database title, so it
    // survived every later update.
    const lines = [
      'GSCC: 0000014 2026-08-21T19:29:39.972Z 0',
      'Citations: 1 () [2026-08-21]',
      'Citations: 1 (Crossref) [2026-08-21]',
    ]
    const { kept, removed } = stripCitationLines(lines, ['Crossref'])
    assert.ok(removed.includes('Citations: 1 () [2026-08-21]'))
    assert.ok(removed.includes('Citations: 1 (Crossref) [2026-08-21]'))
    // The GSCC line goes too, by the legacy pattern below.
    assert.deepEqual(kept, [])
  })

  it('leaves a stamp from a database that is not currently configured', () => {
    const lines = ['Citations: 7 (INSPIRE) [2026-08-21]']
    const { kept } = stripCitationLines(lines, ['Crossref'])
    assert.deepEqual(kept, lines)
  })
})

describe('legacy GSCC stamps', () => {
  it('removes the standalone plugin stamp this fork supersedes', () => {
    const lines = ['GSCC: 0000014 2026-08-21T19:29:39.972Z 0', 'Citations: 14 (Google Scholar) [2026-08-21]']
    const { kept } = stripCitationLines(lines, ['Google Scholar'])
    assert.deepEqual(kept, [])
  })

  it('leaves unrelated Extra content alone', () => {
    const lines = ['Citation Key: chenMITNetGANEnhanced2024', 'PMID: 12345678', 'GSCC is mentioned in prose here']
    const { kept } = stripCitationLines(lines, ['Google Scholar'])
    assert.deepEqual(kept, lines)
  })
})

describe('extractResultTitle', () => {
  it('reads the title out of the result heading', () => {
    const html = '<h3 class="gs_rt"><a href="/x">Attention is all you need</a></h3>'
    assert.equal(extractResultTitle(html), 'Attention is all you need')
  })

  it('drops the query-term highlighting Scholar injects', () => {
    const html = '<h3 class="gs_rt"><a><b>Magnetic</b> induction tomography</a></h3>'
    assert.equal(extractResultTitle(html), 'Magnetic induction tomography')
  })

  it('drops Scholar’s own [BOOK] and [PDF] annotations', () => {
    const html = '<h3 class="gs_rt"><span class="gs_ct1">[BOOK]</span><a>Mathematik für Ingenieure</a></h3>'
    assert.equal(extractResultTitle(html), 'Mathematik für Ingenieure')
  })

  it('decodes entities', () => {
    assert.equal(extractResultTitle('<h3 class="gs_rt"><a>Law &amp; Order</a></h3>'), 'Law & Order')
  })

  it('returns null when there is no result heading', () => {
    assert.equal(extractResultTitle('<div id="gs_res_ccl_mid"></div>'), null)
  })
})

describe('titleSimilarity', () => {
  it('scores an exact match as 1', () => {
    assert.equal(titleSimilarity('Attention is all you need', 'Attention is all you need'), 1)
  })

  it('ignores case, punctuation and diacritics', () => {
    assert.equal(titleSimilarity('Mathematik für Ingenieure!', 'MATHEMATIK FUR INGENIEURE'), 1)
  })

  it('does not penalise a result that adds a subtitle', () => {
    // Scholar routinely returns the fuller published title.
    assert.equal(titleSimilarity('MITNet', 'MITNet: GAN Enhanced Magnetic Induction Tomography'), 1)
  })

  it('scores a genuinely different work below the threshold', () => {
    const score = titleSimilarity(
      'Deep Learning for Image Reconstruction in Electrical Tomography',
      'Sparse regularisation methods for geophysical inversion',
    )
    assert.ok(score < TITLE_MATCH_THRESHOLD, `expected < ${TITLE_MATCH_THRESHOLD}, got ${score}`)
  })

  it('rejects a neighbouring volume of the same textbook', () => {
    // The case that motivated this: same series, different work.
    const score = titleSimilarity(
      'Mathematik für Ingenieure und Naturwissenschaftler Band 2 Differentialgleichungen',
      'Mathematik für Ingenieure und Naturwissenschaftler',
    )
    assert.ok(score < TITLE_MATCH_THRESHOLD, `expected < ${TITLE_MATCH_THRESHOLD}, got ${score}`)
  })

  it('scores an empty item title as 0 rather than dividing by zero', () => {
    assert.equal(titleSimilarity('', 'anything'), 0)
  })
})
