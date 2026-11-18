/**
 * The list a single-paper graph offers when the reader files a work.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { importChoices } from '../src/modules/importChoice.core.ts'

const COLLECTIONS = [
  { id: 3, name: 'Methods', parentID: 1 },
  { id: 1, name: 'Thesis', parentID: null },
  { id: 2, name: 'Background', parentID: null },
  { id: 4, name: 'Methods', parentID: 2 },
]

describe('importChoices', () => {
  it('lists the library first, then every collection by its path', () => {
    assert.deepEqual(importChoices('My Library', COLLECTIONS), [
      { collectionID: null, label: 'My Library' },
      { collectionID: 2, label: 'Background' },
      { collectionID: 4, label: 'Background › Methods' },
      { collectionID: 1, label: 'Thesis' },
      { collectionID: 3, label: 'Thesis › Methods' },
    ])
  })

  it('puts the collection open in Zotero first', () => {
    const choices = importChoices('My Library', COLLECTIONS, 3)
    assert.deepEqual(choices[0], { collectionID: 3, label: 'Thesis › Methods' })
    assert.equal(choices.length, 5)
    assert.equal(choices[1].collectionID, null)
  })

  it('ignores a preferred collection it does not know', () => {
    assert.equal(importChoices('My Library', COLLECTIONS, 99)[0].collectionID, null)
  })

  it('offers only the library when there are no collections', () => {
    assert.deepEqual(importChoices('Group', []), [{ collectionID: null, label: 'Group' }])
  })

  it('stops at a parent it does not hold, and at a cycle', () => {
    const choices = importChoices('L', [
      { id: 5, name: 'Orphan', parentID: 42 },
      { id: 6, name: 'A', parentID: 7 },
      { id: 7, name: 'B', parentID: 6 },
    ])
    assert.deepEqual(
      choices.map((choice) => choice.label),
      ['L', 'A › B', 'B › A', 'Orphan'],
    )
  })
})
