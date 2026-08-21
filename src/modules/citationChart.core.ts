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

  const bars: ChartBar[] = series.map((point) => ({ ...point, partial: point.year >= currentYear }))
  const maxCount = Math.max(...bars.map((bar) => bar.count))
  // Every year at zero: an axis of empty columns communicates nothing.
  if (maxCount <= 0) return null

  return {
    bars,
    maxCount,
    firstYear: bars[0].year,
    lastYear: bars[bars.length - 1].year,
    total: bars.reduce((sum, bar) => sum + bar.count, 0),
  }
}

export interface ChartTheme {
  /** Column fill. One series, so one colour -- the heading names it. */
  series: string
  /** Axis and label ink. Text never wears the series colour. */
  muted: string
}

const VIEW_WIDTH = 240
const PLOT_HEIGHT = 48
const LABEL_HEIGHT = 12
/** Headroom above the plot for the peak value. */
const VALUE_HEIGHT = 11
const BAR_GAP = 2
const BAR_RADIUS = 2
/** A count of zero still gets a sliver, so the year reads as present-but-empty. */
const MIN_BAR_HEIGHT = 1

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Render the model as a standalone SVG string.
 *
 * The hatch pattern for the partial year doubles as the secondary encoding the
 * colour rules ask for: the distinction survives greyscale, print, and every
 * form of colour vision.
 */
export function renderChartSvg(model: ChartModel, theme: ChartTheme, idPrefix: string): string {
  const count = model.bars.length
  const slot = VIEW_WIDTH / count
  const barWidth = Math.max(1, slot - BAR_GAP)
  const height = VALUE_HEIGHT + PLOT_HEIGHT + LABEL_HEIGHT
  const baseline = VALUE_HEIGHT + PLOT_HEIGHT
  const hatchId = `${idPrefix}-hatch`
  const peakIndex = model.bars.findIndex((bar) => bar.count === model.maxCount)

  const columns = model.bars
    .map((bar, index) => {
      const scaled = (bar.count / model.maxCount) * PLOT_HEIGHT
      const barHeight = bar.count > 0 ? Math.max(MIN_BAR_HEIGHT, scaled) : MIN_BAR_HEIGHT
      const x = index * slot + BAR_GAP / 2
      const y = baseline - barHeight
      const fill = bar.partial ? `url(#${hatchId})` : theme.series
      const label = bar.partial ? `${bar.year}: ${bar.count} (current year, incomplete)` : `${bar.year}: ${bar.count}`
      return (
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" ` +
        `height="${barHeight.toFixed(2)}" rx="${BAR_RADIUS}" fill="${fill}">` +
        `<title>${escapeXml(label)}</title></rect>`
      )
    })
    .join('')

  // Only the endpoints are labelled; a number under every column is noise.
  const axis =
    `<text x="0" y="${height - 2}" font-size="9" fill="${theme.muted}">${model.firstYear}</text>` +
    `<text x="${VIEW_WIDTH}" y="${height - 2}" font-size="9" fill="${theme.muted}" ` +
    `text-anchor="end">${model.lastYear}</text>`

  // One value label, on the peak, so the axis has a scale without a gridline
  // for every step. Nudged inside the viewport at either edge.
  const peakCentre = peakIndex * slot + slot / 2
  const peakAnchor = peakCentre < 20 ? 'start' : peakCentre > VIEW_WIDTH - 20 ? 'end' : 'middle'
  const peakX = peakAnchor === 'start' ? 0 : peakAnchor === 'end' ? VIEW_WIDTH : peakCentre
  const peakLabel =
    `<text x="${peakX.toFixed(2)}" y="${VALUE_HEIGHT - 2}" font-size="9" fill="${theme.muted}" ` +
    `text-anchor="${peakAnchor}">${model.maxCount.toLocaleString('en-US')}</text>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_WIDTH} ${height}" ` +
    `width="100%" height="${height}" role="img" ` +
    `aria-label="Citations per year, ${model.firstYear} to ${model.lastYear}, ${model.total} total">` +
    `<defs><pattern id="${hatchId}" patternUnits="userSpaceOnUse" width="4" height="4" ` +
    `patternTransform="rotate(45)">` +
    `<rect width="4" height="4" fill="${theme.series}" opacity="0.25"/>` +
    `<line x1="0" y1="0" x2="0" y2="4" stroke="${theme.series}" stroke-width="2"/>` +
    `</pattern></defs>` +
    `<g>${columns}</g>${peakLabel}${axis}</svg>`
  )
}
