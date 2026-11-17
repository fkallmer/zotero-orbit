/**
 * The identifiers a Semantic Scholar reference keeps.
 *
 * Library matching can only use what the parser keeps, and it used to keep
 * the DOI alone. The key names are Semantic Scholar's own, taken from a live
 * response (`/paper/arXiv:1706.03762?fields=references.externalIds`): `DOI`,
 * `ArXiv`, `PubMed`, next to `MAG`, `DBLP`, `ACL` and `CorpusId`.
 */

import assert from 'node:assert/strict'
import { it } from 'node:test'

import { parseS2Details } from '../src/modules/semanticScholarClient.core.ts'

function details(references: unknown[]): string {
  return JSON.stringify({ citationCount: 1, references })
}

it('keeps the arXiv and PubMed ids of each reference', () => {
  const parsed = parseS2Details(
    details([
      {
        paperId: 'a',
        title: 'Long Short-Term Memory',
        externalIds: { DOI: '10.1162/neco.1997.9.8.1735', PubMed: '9377276', MAG: '2064675550', CorpusId: 1915014 },
      },
      { paperId: 'b', title: 'A preprint', externalIds: { ArXiv: '1409.0473', DBLP: 'journals/corr/x', CorpusId: 1 } },
    ]),
  )
  assert.ok(parsed)
  const [lstm, preprint] = parsed.references
  assert.equal(lstm?.doi, '10.1162/neco.1997.9.8.1735')
  assert.equal(lstm?.pmid, '9377276')
  assert.equal(lstm?.arxiv, null)
  assert.equal(preprint?.doi, null)
  assert.equal(preprint?.arxiv, '1409.0473')
  assert.equal(preprint?.pmid, null)
})

it('leaves the ids empty when a reference has none, or has them in the wrong shape', () => {
  const parsed = parseS2Details(
    details([
      { paperId: 'c', title: 'No ids' },
      { paperId: 'd', title: 'Odd ids', externalIds: { ArXiv: 1409.0473, PubMed: '' } },
    ]),
  )
  assert.ok(parsed)
  for (const ref of parsed.references) {
    assert.equal(ref.arxiv, null)
    assert.equal(ref.pmid, null)
  }
})
