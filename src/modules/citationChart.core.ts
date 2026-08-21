/**
 * The yearly-citation chart: data preparation and SVG generation.
 *
 * Free of Zotero and DOM dependencies so `node --test` can check both the
 * shaping and the emitted markup.
 *
 * Form choice: **columns, not a line.** These are counts within discrete,
 * completed years. A line would assert continuity between them -- that
 * citations accrued smoothly from one January to the next -- which the data
 * does not support and cannot show.
 */

import type { YearCount } from './openAlexClient.core.ts'

/** Below this many years with data, a chart says less than the bare number. */
export const MIN_YEARS_FOR_CHART = 2

export interface ChartBar extends YearCount {
  /** Running total up to and including this year. */
  cumulative: number

  /**
   * True for the year still in progress.
   *
   * This matters more than it looks. OpenAlex reports the current year as a
   * partial count, and indexing lags on top of that: one real record shows 25
   * citations for 2026 against 3213 for 2025. Drawn as an ordinary column that
   * reads as a collapse in impact, when it is purely an artefact of asking
   * mid-year. Rendered hatched instead, with the tooltip saying so.
   */
  partial: boolean
}

export interface ChartModel {
  bars: ChartBar[]
  maxCount: number
  firstYear: number
  lastYear: number
  total: number
}

/**
 * Shape a series for drawing, or return null when a chart is not warranted.
 *
 * `series` is expected chronological and gap-free -- `toChronologicalSeries`
 * in `openAlexClient.core` handles OpenAlex's newest-first ordering and its
 * omission of zero years.
 */
export function buildChartModel(series: readonly YearCount[], currentYear: number): ChartModel | null {
  if (series.length < MIN_YEARS_FOR_CHART) return null

  let running = 0
  const bars: ChartBar[] = series.map((point) => {
    running += point.count
    return { ...point, partial: point.year >= currentYear, cumulative: running }
  })
  const maxCount = Math.max(...bars.map((bar) => bar.count))
  // Every year at zero: an axis of empty columns communicates nothing.
  if (maxCount <= 0) return null

  return {
    bars,
    maxCount,
    firstYear: bars[0].year,
    lastYear: bars[bars.length - 1].year,
    total: running,
  }
}

export interface ChartTheme {
  /** Mark fill. One measure, so one hue -- the heading names it. */
  series: string
  /** Axis, gridline and label ink. Text never wears the series colour. */
  muted: string
}

const VIEW_WIDTH = 240
/** Gutter for the y-axis value labels. */
const AXIS_LEFT = 28
const PLOT_WIDTH = VIEW_WIDTH - AXIS_LEFT

const BARS_HEIGHT = 44
/** Separation between the two plots, so they never read as one dual-axis chart. */
const BAND_GAP = 13
const CUMULATIVE_HEIGHT = 26
const XLABEL_HEIGHT = 12

const BARS_TOP = 0
const BARS_BASE = BARS_TOP + BARS_HEIGHT
const CUM_TOP = BARS_BASE + BAND_GAP
const CUM_BASE = CUM_TOP + CUMULATIVE_HEIGHT
const TOTAL_HEIGHT = CUM_BASE + XLABEL_HEIGHT

const BAR_GAP = 2
const BAR_RADIUS = 2
/** A count of zero still gets a sliver, so the year reads as present-but-empty. */
const MIN_BAR_HEIGHT = 1

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function compact(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000)}k`
  return value.toLocaleString('en-US')
}

/**
 * Render the model as a standalone SVG: per-year columns above, running total
 * below.
 *
 * **Two plots, not one chart with two y-scales.** Yearly counts and a running
 * total differ by orders of magnitude, and overlaying them on a second axis is
 * the most misleading thing a chart of this data can do -- where the two
 * crossed would be an artefact of the scales picked, and readers would take it
 * for a fact about the work. They are stacked instead, each with its own
 * baseline and its own maximum labelled, sharing only the year axis.
 *
 * The hatch on the running year doubles as the secondary encoding the colour
 * rules ask for: it survives greyscale, print and every form of colour vision.
 */
export function renderChartSvg(model: ChartModel, theme: ChartTheme, idPrefix: string): string {
  const count = model.bars.length
  const slot = PLOT_WIDTH / count
  const barWidth = Math.max(1, slot - BAR_GAP)
  const hatchId = `${idPrefix}-hatch`
  const x = (index: number): number => AXIS_LEFT + index * slot

  const columns = model.bars
    .map((bar, index) => {
      const scaled = (bar.count / model.maxCount) * BARS_HEIGHT
      const height = bar.count > 0 ? Math.max(MIN_BAR_HEIGHT, scaled) : MIN_BAR_HEIGHT
      const fill = bar.partial ? `url(#${hatchId})` : theme.series
      const label = bar.partial ? `${bar.year}: ${bar.count} (current year, incomplete)` : `${bar.year}: ${bar.count}`
      return (
        `<rect x="${(x(index) + BAR_GAP / 2).toFixed(2)}" y="${(BARS_BASE - height).toFixed(2)}" ` +
        `width="${barWidth.toFixed(2)}" height="${height.toFixed(2)}" rx="${BAR_RADIUS}" fill="${fill}">` +
        `<title>${escapeXml(label)}</title></rect>`
      )
    })
    .join('')

  // Sampled at the centre of each year's slot, so a point sits over the column
  // it belongs to rather than between two of them.
  const points = model.bars.map((bar, index) => ({
    px: x(index) + slot / 2,
    py: CUM_BASE - (bar.cumulative / model.total) * CUMULATIVE_HEIGHT,
    bar,
  }))
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px.toFixed(2)},${p.py.toFixed(2)}`).join(' ')
  const area =
    `M${points[0].px.toFixed(2)},${CUM_BASE} ` +
    points.map((p) => `L${p.px.toFixed(2)},${p.py.toFixed(2)}`).join(' ') +
    ` L${points[points.length - 1].px.toFixed(2)},${CUM_BASE} Z`

  // Invisible hit targets, one per year, bigger than the 2px line they explain.
  const cumulativeHovers = points
    .map(
      (p) =>
        `<rect x="${(p.px - slot / 2).toFixed(2)}" y="${CUM_TOP}" width="${slot.toFixed(2)}" ` +
        `height="${CUMULATIVE_HEIGHT}" fill="transparent">` +
        `<title>${escapeXml(`${p.bar.year}: ${p.bar.cumulative} total`)}</title></rect>`,
    )
    .join('')

  // Two ticks per plot -- zero and the maximum. A gridline for every step would
  // outweigh the marks at this size.
  const tick = (y: number, value: string, textBaseline: number): string =>
    `<line x1="${AXIS_LEFT}" y1="${y}" x2="${VIEW_WIDTH}" y2="${y}" stroke="${theme.muted}" ` +
    `stroke-width="1" opacity="0.25"/>` +
    `<text x="${AXIS_LEFT - 4}" y="${textBaseline}" font-size="8" fill="${theme.muted}" ` +
    `text-anchor="end" opacity="0.8">${value}</text>`

  const axes =
    tick(BARS_TOP, compact(model.maxCount), BARS_TOP + 7) +
    tick(BARS_BASE, '0', BARS_BASE) +
    tick(CUM_TOP, compact(model.total), CUM_TOP + 7) +
    tick(CUM_BASE, '0', CUM_BASE) +
    `<text x="${AXIS_LEFT}" y="${TOTAL_HEIGHT - 2}" font-size="9" fill="${theme.muted}">${model.firstYear}</text>` +
    `<text x="${VIEW_WIDTH}" y="${TOTAL_HEIGHT - 2}" font-size="9" fill="${theme.muted}" ` +
    `text-anchor="end">${model.lastYear}</text>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_WIDTH} ${TOTAL_HEIGHT}" ` +
    `width="100%" height="${TOTAL_HEIGHT}" role="img" ` +
    `aria-label="Citations per year and running total, ${model.firstYear} to ${model.lastYear}, ` +
    `${model.total} in all, peaking at ${model.maxCount} in one year">` +
    `<defs><pattern id="${hatchId}" patternUnits="userSpaceOnUse" width="4" height="4" ` +
    `patternTransform="rotate(45)">` +
    `<rect width="4" height="4" fill="${theme.series}" opacity="0.25"/>` +
    `<line x1="0" y1="0" x2="0" y2="4" stroke="${theme.series}" stroke-width="2"/>` +
    `</pattern></defs>` +
    `<g>${axes}</g>` +
    `<g>${columns}</g>` +
    `<path d="${area}" fill="${theme.series}" opacity="0.18"/>` +
    `<path d="${line}" fill="none" stroke="${theme.series}" stroke-width="2" ` +
    `stroke-linejoin="round" stroke-linecap="round"/>` +
    `<g>${cumulativeHovers}</g>` +
    `</svg>`
  )
}
