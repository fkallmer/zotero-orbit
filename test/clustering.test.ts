import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clusterByCoupling, labelClusters } from '../src/modules/clustering.core.ts'

import type { CouplingEdge } from '../src/modules/collectionTypes.ts'

/** Every pair within each group coupled with `weight`. */
function cliques(groups: string[][], weight: number): CouplingEdge[] {
  const edges: CouplingEdge[] = []
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]].sort()
        edges.push({ a, b, shared: weight })
      }
    }
  }
  return edges
}

// Two dense communities joined by one weak bridge, plus an isolated seed.
const big = ['W10', 'W11', 'W12', 'W13', 'W14']
const small = ['W20', 'W21', 'W22', 'W23']
const seeds = [...big, ...small, 'W99']
const edges = [...cliques([big, small], 5), { a: 'W10', b: 'W20', shared: 1 }]

describe('clusterByCoupling', () => {
  it('separates two communities, larger one first', () => {
    const result = clusterByCoupling(seeds, edges)
    for (const id of big) assert.equal(result.get(id), 0, id)
    for (const id of small) assert.equal(result.get(id), 1, id)
  })

  it('gives isolated seeds null and every seed an entry', () => {
    const result = clusterByCoupling(seeds, edges)
    assert.equal(result.size, seeds.length)
    assert.equal(result.get('W99'), null)
  })

  it('is deterministic across runs and input orders', () => {
    const first = [...clusterByCoupling(seeds, edges)].sort()
    for (let run = 0; run < 3; run++) {
      const shuffled = [...edges].reverse().map((edge) => ({ a: edge.b, b: edge.a, shared: edge.shared }))
      assert.deepEqual([...clusterByCoupling([...seeds].reverse(), shuffled)].sort(), first)
    }
  })

  it('orders equal-sized clusters by their smallest member', () => {
    const result = clusterByCoupling(
      ['W5', 'W6', 'W1', 'W2'],
      [
        ...cliques(
          [
            ['W5', 'W6'],
            ['W1', 'W2'],
          ],
          3,
        ),
      ],
    )
    assert.equal(result.get('W1'), 0)
    assert.equal(result.get('W2'), 0)
    assert.equal(result.get('W5'), 1)
    assert.equal(result.get('W6'), 1)
  })

  it('returns all null without edges, and ignores edges to unknown seeds', () => {
    const none = clusterByCoupling(['W1', 'W2'], [])
    assert.deepEqual([...none.values()], [null, null])
    const stray = clusterByCoupling(['W1', 'W2'], [{ a: 'W1', b: 'W3', shared: 4 }])
    assert.deepEqual([...stray.values()], [null, null])
  })

  it('clusters a single coupled pair', () => {
    const result = clusterByCoupling(['W1', 'W2'], [{ a: 'W1', b: 'W2', shared: 3 }])
    assert.equal(result.get('W1'), 0)
    assert.equal(result.get('W2'), 0)
  })
})

describe('labelClusters', () => {
  const topics: Record<string, string> = {
    W1: 'Neural networks',
    W2: 'Neural networks',
    W3: 'Graph theory',
    W4: 'Graph theory',
    W5: 'Astrophysics',
  }
  const topicOf = (id: string) => (topics[id] ? { id: `T-${topics[id]}`, name: topics[id] } : null)
  const fallback = (id: number) => `Cluster ${id + 1}`

  it('names a cluster after its majority topic, with its share', () => {
    const assignment = new Map<string, number | null>([
      ['W1', 0],
      ['W2', 0],
      ['W5', 0],
      ['W9', 0],
      ['W8', null],
    ])
    const [cluster] = labelClusters(assignment, topicOf, fallback)
    assert.equal(cluster.label, 'Neural networks')
    assert.equal(cluster.topicShare, 0.5)
    assert.deepEqual(cluster.members, ['W1', 'W2', 'W5', 'W9'])
  })

  it('breaks a tie alphabetically', () => {
    const assignment = new Map<string, number | null>([
      ['W1', 0],
      ['W3', 0],
    ])
    assert.equal(labelClusters(assignment, topicOf, fallback)[0].label, 'Graph theory')
  })

  it('falls back when no member has a topic, and orders clusters by id', () => {
    const assignment = new Map<string, number | null>([
      ['W8', 1],
      ['W9', 1],
      ['W3', 0],
      ['W4', 0],
    ])
    const clusters = labelClusters(assignment, topicOf, fallback)
    assert.deepEqual(
      clusters.map((cluster) => [cluster.id, cluster.label, cluster.topicShare]),
      [
        [0, 'Graph theory', 1],
        [1, 'Cluster 2', 0],
      ],
    )
  })
})
