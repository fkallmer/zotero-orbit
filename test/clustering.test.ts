import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clusterByCoupling, labelClusters, MAX_LABEL_LENGTH } from '../src/modules/clustering.core.ts'

import type { CouplingEdge, PrimaryTopic } from '../src/modules/collectionTypes.ts'

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

describe('cluster names', () => {
  const topic = (name: string) => ({ id: name, name })

  it('gives two clusters sharing a top topic their own names', () => {
    const assignment = new Map<string, number | null>([
      ['A1', 0],
      ['A2', 0],
      ['A3', 0],
      ['B1', 1],
      ['B2', 1],
      ['B3', 1],
    ])
    const topics: Record<string, string> = {
      A1: 'CRISPR',
      A2: 'CRISPR',
      A3: 'Phage biology',
      B1: 'CRISPR',
      B2: 'CRISPR',
      B3: 'Base editing',
    }
    const clusters = labelClusters(
      assignment,
      (id) => topic(topics[id]),
      (id) => `Cluster ${id + 1}`,
    )
    assert.deepEqual(
      clusters.map((c) => c.label),
      ['CRISPR', 'Base editing'],
    )
    assert.equal(clusters[1]?.topicShare, 1 / 3)
  })

  it('numbers a cluster that has no topic left that is not already a name', () => {
    const assignment = new Map<string, number | null>([
      ['A1', 0],
      ['A2', 0],
      ['B1', 1],
      ['B2', 1],
    ])
    const clusters = labelClusters(
      assignment,
      () => topic('CRISPR'),
      (id) => `Cluster ${id + 1}`,
    )
    assert.deepEqual(
      clusters.map((c) => c.label),
      ['CRISPR', 'CRISPR (2)'],
    )
  })
})

describe('cluster names from the topic hierarchy', () => {
  const fallback = (id: number) => `Cluster ${id + 1}`

  /** Topic, subfield and field by name; a missing rung stays missing, as in an old cache. */
  function hier(topic: string, subfield?: string, field?: string): PrimaryTopic {
    return {
      id: `T-${topic}`,
      name: topic,
      ...(subfield && { subfield: { id: `subfields/${subfield}`, name: subfield } }),
      ...(field && { field: { id: `fields/${field}`, name: field } }),
    }
  }

  /** Cluster `index` gets one member per entry, ids `C<index>-<n>`. */
  function build(groups: PrimaryTopic[][]) {
    const assignment = new Map<string, number | null>()
    const topics = new Map<string, PrimaryTopic>()
    groups.forEach((group, clusterId) =>
      group.forEach((topic, n) => {
        const id = `C${clusterId}-${n}`
        assignment.set(id, clusterId)
        topics.set(id, topic)
      }),
    )
    return { assignment, topicOf: (id: string) => topics.get(id) ?? null }
  }

  it('names a cluster by its subfield when no topic has a majority', () => {
    const { assignment, topicOf } = build([
      [
        hier('Topic Modeling', 'Artificial Intelligence', 'Computer Science'),
        hier('Topic Modeling', 'Artificial Intelligence', 'Computer Science'),
        hier('NLP Techniques', 'Artificial Intelligence', 'Computer Science'),
        hier('Neural Networks', 'Artificial Intelligence', 'Computer Science'),
        hier('Graph Drawing', 'Computer Graphics', 'Computer Science'),
      ],
    ])
    const [cluster] = labelClusters(assignment, topicOf, fallback)
    assert.equal(cluster.label, 'Artificial Intelligence')
    assert.equal(cluster.topicShare, 4 / 5)
  })

  it('goes up to the field when neither topic nor subfield has a majority', () => {
    const { assignment, topicOf } = build([
      [
        hier('Plant ecology', 'Ecology', 'Environmental Science'),
        hier('Aerosols', 'Atmospheric Science', 'Environmental Science'),
        hier('Soil carbon', 'Soil Science', 'Environmental Science'),
        hier('Bayesian methods', 'Statistics', 'Mathematics'),
      ],
    ])
    const [cluster] = labelClusters(assignment, topicOf, fallback)
    assert.equal(cluster.label, 'Environmental Science')
    assert.equal(cluster.topicShare, 3 / 4)
  })

  it('keeps a majority topic over its broader subfield', () => {
    const { assignment, topicOf } = build([
      [hier('CRISPR', 'Molecular Biology'), hier('CRISPR', 'Molecular Biology'), hier('Phage', 'Virology')],
    ])
    assert.equal(labelClusters(assignment, topicOf, fallback)[0].label, 'CRISPR')
  })

  it('names a scattered cluster by the name most members carry, narrowest on a tie', () => {
    // No level has a majority; the field covers the most papers.
    const { assignment, topicOf } = build([
      [
        hier('Plant ecology', 'Ecology', 'Environmental Science'),
        hier('Aerosols', 'Atmospheric Science', 'Environmental Science'),
        hier('Bayesian methods', 'Statistics', 'Mathematics'),
        hier('Graph theory', 'Discrete Mathematics', 'Mathematics'),
        hier('Lasers', 'Optics', 'Physics'),
      ],
    ])
    const [cluster] = labelClusters(assignment, topicOf, fallback)
    // Two fields at two each: the alphabetically first.
    assert.equal(cluster.label, 'Environmental Science')
    assert.equal(cluster.topicShare, 2 / 5)
  })

  it('names a scattered cluster by its most common topic when nothing broader covers more', () => {
    const { assignment, topicOf } = build([
      [
        hier('A', 'SA', 'FA'),
        hier('A', 'SB', 'FB'),
        hier('B', 'SC', 'FC'),
        hier('C', 'SD', 'FD'),
        hier('D', 'SE', 'FE'),
      ],
    ])
    const [cluster] = labelClusters(assignment, topicOf, fallback)
    assert.equal(cluster.label, 'A')
    assert.equal(cluster.topicShare, 2 / 5)
  })

  it('gives a shared name to the cluster it is truest of, not the larger one', () => {
    // The 299-paper case: a broad genomics cluster with some CRISPR papers, and
    // a smaller one that is nearly all CRISPR. Topics only, as in an old cache.
    const { assignment, topicOf } = build([
      [
        hier('CRISPR'),
        hier('CRISPR'),
        hier('CRISPR'),
        hier('Genomics'),
        hier('Genomics'),
        hier('Chromatin'),
        hier('Phylogeny'),
      ],
      [hier('CRISPR'), hier('CRISPR'), hier('CRISPR'), hier('CRISPR'), hier('Biosensors')],
    ])
    const clusters = labelClusters(assignment, topicOf, fallback)
    assert.deepEqual(
      clusters.map((c) => [c.label, c.topicShare]),
      [
        ['Genomics', 2 / 7],
        ['CRISPR', 4 / 5],
      ],
    )
  })

  it('moves the cluster that loses a topic to its subfield, not to a stray topic', () => {
    const { assignment, topicOf } = build([
      [
        hier('CRISPR', 'Molecular Biology'),
        hier('CRISPR', 'Molecular Biology'),
        hier('CRISPR', 'Molecular Biology'),
        hier('Genomics', 'Genetics'),
        hier('Chromatin', 'Molecular Biology'),
      ],
      [
        hier('CRISPR', 'Molecular Biology'),
        hier('CRISPR', 'Molecular Biology'),
        hier('CRISPR', 'Molecular Biology'),
        hier('Biosensors', 'Analytical Chemistry'),
      ],
    ])
    assert.deepEqual(
      labelClusters(assignment, topicOf, fallback).map((c) => c.label),
      ['Molecular Biology', 'CRISPR'],
    )
  })

  it('settles an equal claim by member count, then by cluster id', () => {
    const { assignment, topicOf } = build([
      [hier('X', 'S1'), hier('Y', 'S1')],
      [hier('X', 'S2'), hier('X', 'S2'), hier('Y', 'S2'), hier('Y', 'S2')],
    ])
    // Both carry X and Y at one half; the second cluster has more X papers.
    assert.deepEqual(
      labelClusters(assignment, topicOf, fallback).map((c) => c.label),
      ['Y', 'X'],
    )
  })

  it('shortens long names at a word, without a dangling connector', () => {
    const { assignment, topicOf } = build([
      [
        hier('Diabetes, Cardiovascular Risks, and Lipoproteins'),
        hier('Diabetes, Cardiovascular Risks, and Lipoproteins'),
      ],
      [
        hier('Supercalifragilisticexpialidociousnessesqueezedtogether'),
        hier('Supercalifragilisticexpialidociousnessesqueezedtogether'),
      ],
    ])
    const labels = labelClusters(assignment, topicOf, fallback).map((c) => c.label)
    assert.deepEqual(labels, [
      'Diabetes, Cardiovascular Risks\u2026',
      'Supercalifragilisticexpialidociousnessesquee\u2026',
    ])
    for (const label of labels) assert.ok(label.length <= MAX_LABEL_LENGTH, label)
  })

  it('keeps names unique and short when they only differ past the cut', () => {
    const long = 'Advanced Computational Methods for Large Scale Systems'
    const { assignment, topicOf } = build([
      [hier(`${long} Alpha`), hier(`${long} Alpha`)],
      [hier(`${long} Beta`), hier(`${long} Beta`)],
      [hier(`${long} Gamma`), hier(`${long} Gamma`)],
    ])
    const labels = labelClusters(assignment, topicOf, fallback).map((c) => c.label)
    assert.deepEqual(labels, [
      'Advanced Computational Methods for Large\u2026',
      'Advanced Computational Methods for Large\u2026 (2)',
      'Advanced Computational Methods for Large\u2026 (3)',
    ])
    assert.equal(new Set(labels).size, labels.length)
    for (const label of labels) assert.ok(label.length <= MAX_LABEL_LENGTH, label)
  })

  it('does not depend on the order of the assignment', () => {
    const { assignment, topicOf } = build([
      [hier('A', 'S'), hier('A', 'S'), hier('B', 'S')],
      [hier('A', 'S'), hier('B', 'S'), hier('B', 'T')],
      [hier('A', 'S'), hier('C', 'S')],
    ])
    const first = labelClusters(assignment, topicOf, fallback)
    const reversed = labelClusters(new Map([...assignment].reverse()), topicOf, fallback)
    assert.deepEqual(reversed, first)
    assert.equal(new Set(first.map((c) => c.label)).size, first.length)
  })
})
