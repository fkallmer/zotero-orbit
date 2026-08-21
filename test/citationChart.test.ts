import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildChartModel, MIN_YEARS_FOR_CHART, renderChartSvg } from '../src/modules/citationChart.core.ts'

import type { YearCount } from '../src/modules/openAlexClient.core.ts'

const theme = { series: '#eda100', muted: '#6b6b6b' }

function series(...pairs: [number, number][]): YearCount[] {
  return pairs.map(([year, count]) => ({ year, count }))
}

describe('buildChartModel', () => {
  it('marks the current year as partial', () => {
    // The whole point: OpenAlex reports the running year mid-flight. One real
    // record shows 25 for 2026 against 3213 for 2025 -- drawn plainly that
    // reads as a collapse rather than as "we asked in August".
    const model = buildChartModel(series([2024, 100], [2025, 3213], [2026, 25]), 2026)
    assert.deepEqual(
      model?.bars.map((bar) => bar.partial),
      [false, false, true],
    )
  })

  it('marks nothing as partial when the series ends before the current year', () => {
    const model = buildChartModel(series([2020, 5], [2021, 9]), 2026)
    assert.ok(model?.bars.every((bar) => !bar.partial))
  })

  it('treats a future year as partial too, rather than as settled', () => {
    const model = buildChartModel(series([2025, 4], [2027, 1]), 2026)
    assert.equal(model?.bars.at(-1)?.partial, true)
  })

  it('reports the peak and the span', () => {
    const model = buildChartModel(series([2020, 5], [2021, 40], [2022, 9]), 2026)
    assert.equal(model?.maxCount, 40)
    assert.equal(model?.firstYear, 2020)
    assert.equal(model?.lastYear, 2022)
    assert.equal(model?.total, 54)
  })

  it('declines to draw a single year', () => {
    assert.equal(buildChartModel(series([2025, 12]), 2026), null)
    assert.equal(MIN_YEARS_FOR_CHART, 2)
  })

  it('declines to draw an all-zero series', () => {
    // An axis of empty columns says less than the number it sits under.
    assert.equal(buildChartModel(series([2024, 0], [2025, 0]), 2026), null)
  })

  it('declines to draw an empty series', () => {
    assert.equal(buildChartModel([], 2026), null)
  })
})

describe('renderChartSvg', () => {
  const model = buildChartModel(series([2023, 10], [2024, 0], [2025, 40], [2026, 3]), 2026)!

  it('draws one column per year, gaps included', () => {
    const svg = renderChartSvg(model, theme, 't1')
    // Bars carry a corner radius; the hatch tile and the hover targets do not.
    assert.equal(svg.match(/<rect [^>]*rx="2"/g)?.length, 4)
  })

  it('gives the running total its own plot rather than a second y-axis', () => {
    // Overlaying a running total on a second scale would put the crossing
    // point wherever the scales happened to fall. Two baselines, two maxima.
    const svg = renderChartSvg(model, theme, 't1b')
    assert.equal(svg.match(/<line [^>]*stroke-width="1"/g)?.length, 4) // two ticks per plot
    assert.ok(svg.includes('<path d="M')) // the cumulative line
  })

  it('labels zero and the maximum on both plots', () => {
    const svg = renderChartSvg(model, theme, 't1c')
    assert.ok(svg.includes('>40</text>')) // busiest single year
    assert.ok(svg.includes('>53</text>')) // running total
    assert.equal(svg.match(/>0<\/text>/g)?.length, 2) // one baseline each
  })

  it('offers a hover target per year on the running total', () => {
    const svg = renderChartSvg(model, theme, 't1d')
    assert.ok(svg.includes('<title>2025: 50 total</title>'))
    assert.equal(svg.match(/fill="transparent"/g)?.length, 4)
  })

  it('fills the partial year with the hatch, not the flat colour', () => {
    const svg = renderChartSvg(model, theme, 't2')
    assert.ok(svg.includes('fill="url(#t2-hatch)"'))
    // Exactly one column is hatched.
    assert.equal(svg.match(/fill="url\(#t2-hatch\)"/g)?.length, 1)
  })

  it('says so in the partial year’s tooltip', () => {
    const svg = renderChartSvg(model, theme, 't3')
    assert.ok(svg.includes('<title>2026: 3 (current year, incomplete)</title>'))
    assert.ok(svg.includes('<title>2025: 40</title>'))
  })

  it('gives a zero year a visible sliver rather than nothing', () => {
    const svg = renderChartSvg(model, theme, 't4')
    assert.ok(svg.includes('<title>2024: 0</title>'))
  })

  it('labels only the endpoint years', () => {
    const svg = renderChartSvg(model, theme, 't5')
    assert.ok(svg.includes('>2023</text>'))
    assert.ok(svg.includes('>2026</text>'))
    // No label for the years in between.
    assert.ok(!svg.includes('>2024</text>'))
  })

  it('namespaces the hatch id so two charts on one page cannot collide', () => {
    assert.ok(renderChartSvg(model, theme, 'a').includes('id="a-hatch"'))
    assert.ok(renderChartSvg(model, theme, 'b').includes('id="b-hatch"'))
  })

  it('carries a text alternative naming both plots', () => {
    const svg = renderChartSvg(model, theme, 't6')
    assert.ok(svg.includes('role="img"'))
    assert.ok(/aria-label="Citations per year and running total, 2023 to 2026, 53 in all/.test(svg))
  })

  it('produces well-formed markup for a single-column-dominant series', () => {
    const lopsided = buildChartModel(series([2020, 1], [2021, 100000]), 2026)!
    const svg = renderChartSvg(lopsided, theme, 't7')
    assert.ok(svg.startsWith('<svg'))
    assert.ok(svg.endsWith('</svg>'))
    assert.ok(!svg.includes('NaN'))
    // Five-plus digits would crowd the 28px axis gutter, so they are compacted.
    assert.ok(svg.includes('>100k</text>'))
  })
})

describe('cumulative values', () => {
  it('accumulates across the series', () => {
    const model = buildChartModel(series([2020, 5], [2021, 3], [2022, 12]), 2026)
    assert.deepEqual(
      model?.bars.map((bar) => bar.cumulative),
      [5, 8, 20],
    )
    assert.equal(model?.total, 20)
  })

  it('carries the filled years through a gap unchanged', () => {
    // A zero year must not reset or interrupt the running total.
    const model = buildChartModel(series([2020, 4], [2021, 0], [2022, 6]), 2026)
    assert.deepEqual(
      model?.bars.map((bar) => bar.cumulative),
      [4, 4, 10],
    )
  })

  it('ends at the total', () => {
    const model = buildChartModel(series([2019, 7], [2020, 1], [2021, 9]), 2026)
    assert.equal(model?.bars.at(-1)?.cumulative, model?.total)
  })
})
