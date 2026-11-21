import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  challengeNeedsPerson,
  classifyScholarPage,
  extractResultTitle,
  isSameScholarSearch,
  isScholarChallenge,
  isScholarNoResultsPage,
  parseScholarCount,
  TITLE_MATCH_THRESHOLD,
  titleSimilarity,
} from '../src/modules/googleScholarClient.core.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'scholar')
const sgsync = readFileSync(join(fixtures, 'sgsync-verifying.html'), 'utf8')
const unusualTraffic = readFileSync(join(fixtures, 'unusual-traffic-429.html'), 'utf8')

const SEARCH = 'https://scholar.google.com/scholar?hl=en&q=%22Introduction+to+Electrodynamics%22&num=1'
const SGSYNC_URL =
  'https://www.google.com/sgsync?url=https%3A%2F%2Fscholar.google.com%2Fscholar%3Fhl%3Den&sig=REDACTED&sg_fe=scife'

const RESULT_PAGE =
  '<div id="gs_res_ccl_mid"><div class="gs_r gs_or gs_scl"><h3 class="gs_rt"><a href="#">Introduction to Electrodynamics</a></h3>' +
  '<div class="gs_fl gs_flb"><a href="/scholar?cites=1">Cited by 9417</a></div></div></div>'

const NO_RESULTS_PAGE =
  '<div id="gs_res_ccl"><div id="gs_res_ccl_top"></div><div id="gs_res_ccl_mid">' +
  '<p>Your search - <b>"An invented title"</b> - did not match any articles.</p></div></div>'

describe('isScholarChallenge', () => {
  it('recognises the sgsync interstitial by its page', () => {
    assert.equal(isScholarChallenge(sgsync), true)
  })

  it('recognises the sgsync interstitial by where the response came from', () => {
    assert.equal(isScholarChallenge('<html></html>', SGSYNC_URL), true)
    assert.equal(isScholarChallenge('<html></html>', 'https://www.google.com/sorry/index?continue=x'), true)
  })

  it('recognises the "unusual traffic" reCAPTCHA sent with HTTP 429', () => {
    assert.equal(isScholarChallenge(unusualTraffic), true)
  })

  it('does not take a results page or an unrelated google.com path for a challenge', () => {
    assert.equal(isScholarChallenge(RESULT_PAGE, SEARCH), false)
    assert.equal(isScholarChallenge('<html></html>', 'https://www.google.com/search?q=sgsync'), false)
    assert.equal(isScholarChallenge('<html></html>', 'https://evilgoogle.com/sgsync'), false)
  })
})

describe('challengeNeedsPerson', () => {
  it('asks for a person only when there is a CAPTCHA to solve', () => {
    assert.equal(challengeNeedsPerson(unusualTraffic), true)
    assert.equal(challengeNeedsPerson(sgsync), false)
  })
})

describe('classifyScholarPage', () => {
  it('never reads a challenge as "no result"', () => {
    assert.equal(classifyScholarPage(sgsync, SGSYNC_URL), 'challenge')
    assert.equal(classifyScholarPage(unusualTraffic, SEARCH), 'challenge')
  })

  it('reads a page with a result block as results', () => {
    assert.equal(classifyScholarPage(RESULT_PAGE, SEARCH), 'results')
  })

  it("needs Scholar's own notice before saying there are no results", () => {
    assert.equal(classifyScholarPage(NO_RESULTS_PAGE, SEARCH), 'no_results')
    assert.equal(isScholarNoResultsPage(NO_RESULTS_PAGE), true)
  })

  it('treats any other page as unknown, not as "no result"', () => {
    assert.equal(classifyScholarPage('<html><body>Something else entirely</body></html>', SEARCH), 'unknown')
    // The notice text alone, outside a results page, is not enough.
    assert.equal(classifyScholarPage('<p>did not match any articles</p>', SEARCH), 'unknown')
  })
})

describe('isSameScholarSearch', () => {
  it('matches the results page for the same query despite added parameters', () => {
    assert.equal(isSameScholarSearch(`${SEARCH}&ntpr=`, SEARCH), true)
  })

  it('rejects another query, another path or another origin', () => {
    assert.equal(isSameScholarSearch(SEARCH.replace('Introduction', 'Intro'), SEARCH), false)
    assert.equal(isSameScholarSearch(SGSYNC_URL, SEARCH), false)
    assert.equal(isSameScholarSearch(SEARCH.replace('scholar.google.com', 'scholar.google.de'), SEARCH), false)
    assert.equal(isSameScholarSearch('not a url', SEARCH), false)
  })
})

describe('a real results page (citation-only hit, captured in Zotero)', () => {
  const page = readFileSync(join(fixtures, 'results-citation-only.html'), 'utf8')

  it('is read as results, not as a challenge or "no result"', () => {
    assert.equal(classifyScholarPage(page, `${SEARCH}&ntpr=&sgst=REDACTED`), 'results')
  })

  it('has no citation count, which reads as zero', () => {
    assert.equal(parseScholarCount(page), 0)
  })

  it('strips every leading marker from the result title', () => {
    assert.equal(extractResultTitle(page), 'Mathematik für Ingenieure und Naturwissenschaftler')
  })

  it('is rejected for a volume whose subtitle the hit lacks', () => {
    const wanted =
      'Mathematik für Ingenieure und Naturwissenschaftler Band 3: Vektoranalysis, Wahrscheinlichkeitsrechnung, Mathematische Statistik, Fehler- und Ausgleichsrechnung'
    assert.ok(titleSimilarity(wanted, extractResultTitle(page) ?? '') < TITLE_MATCH_THRESHOLD)
  })
})
