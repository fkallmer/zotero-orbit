/**
 * The citation graph: model, scales and SVG.
 *
 * Free of Zotero and DOM dependencies so `node --test` can exercise the
 * arithmetic and the emitted markup.
 *
 * Form: a scatter of year against citations, not a force-directed network.
 * The question being asked is "what came before this, what came after, and
 * which of it mattered" -- that is two quantities per paper, and a spring
 * layout would answer it by accident at best. Time runs left to right, which
 * puts references on one side of the seed and citing work on the other without
 * drawing a single edge.
 */

export type GraphRole = 'seed' | 'reference' | 'citing'

export interface GraphNode {
  /** Stable within one graph; a DOI where there is one. */
  key: string
  title: string
  year: number | null
  citedByCount: number | null
  role: GraphRole
  doi: string | null
  /** Set when the work is in the user's library. */
  itemID: number | null
}

export interface PlacedNode extends GraphNode {
  x: number
  y: number
  radius: number
}

export interface AxisTick {
  value: number
  position: number
  label: string
}

export interface GraphLayout {
  nodes: PlacedNode[]
  xTicks: AxisTick[]
  yTicks: AxisTick[]
  width: number
  height: number
  /** Works that carry no year and so cannot be placed on a time axis. */
  droppedNoYear: number
}

export interface LayoutOptions {
  width: number
  height: number
  padding: { top: number; right: number; bottom: number; left: number }
  /** Defaults to logarithmic; see citationScale for why it is a choice. */
  scale?: ScaleKind
}

export type ScaleKind = 'log' | 'linear'

/**
 * Position a citation count on the vertical axis.
 *
 * Logarithmic by default, because counts routinely span orders of magnitude --
 * a seed with 6 beside a reference with 84,000 -- and a linear axis would press
 * everything below the maximum onto the baseline. But log distorts the opposite
 * case: twenty works between 40 and 90 citations are genuinely comparable, and
 * log flattens the differences that matter there. Neither is right for both, so
 * it is a setting rather than a decision.
 *
 * log1p rather than log: uncited work is real and belongs at zero rather than
 * at minus infinity.
 */
export function citationScale(count: number, kind: ScaleKind = 'log'): number {
  const safe = Math.max(0, count)
  return kind === 'linear' ? safe : Math.log1p(safe)
}

/**
 * Radius by citation count, area-proportional so the eye reads it correctly.
 *
 * The seed gets a floor. It is the one mark the reader is looking for, and a
 * lightly cited paper surrounded by its own influences would otherwise be the
 * smallest dot on the plot -- which is exactly backwards for the thing the
 * graph is about.
 */
function radiusFor(count: number | null, role: GraphRole): number {
  // Always logarithmic, whatever the axis does: a linear radius would make a
  // 5,000-citation mark a hundred times the area of a 50-citation one and
  // swallow the plot.
  const scaled = citationScale(count ?? 0, 'log')
  // sqrt keeps area, not diameter, proportional to the value.
  const radius = 3 + Math.sqrt(scaled) * 1.7
  return role === 'seed' ? Math.max(radius, 9) : radius
}

function niceYearTicks(min: number, max: number): number[] {
  const span = Math.max(1, max - min)
  const step = span <= 8 ? 1 : span <= 20 ? 5 : span <= 50 ? 10 : 20
  const first = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let year = first; year <= max; year += step) ticks.push(year)
  // A span narrower than one step would otherwise produce no ticks at all.
  if (ticks.length === 0) ticks.push(min, max)
  return ticks
}

/** Powers of ten on a log axis; evenly spaced round numbers on a linear one. */
function citationTickValues(maxCount: number, kind: ScaleKind): number[] {
  if (kind === 'log') {
    const ticks = [0]
    for (let power = 1; power <= maxCount; power *= 10) ticks.push(power)
    return ticks
  }
  // A round step near a fifth of the range, so the axis reads 0/50/100/...
  const rough = maxCount / 5
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, rough)))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? magnitude * 10
  const ticks: number[] = []
  for (let value = 0; value <= maxCount + step / 2; value += step) ticks.push(value)
  return ticks
}

export function buildGraphLayout(nodes: readonly GraphNode[], options: LayoutOptions): GraphLayout | null {
  const placeable = nodes.filter((node) => node.year !== null)
  const droppedNoYear = nodes.length - placeable.length
  if (placeable.length === 0) return null

  const { width, height, padding } = options
  const scale: ScaleKind = options.scale ?? 'log'
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom

  const years = placeable.map((node) => node.year as number)
  const minYear = Math.min(...years)
  const maxYear = Math.max(...years)
  const yearSpan = Math.max(1, maxYear - minYear)

  const maxCount = Math.max(1, ...placeable.map((node) => node.citedByCount ?? 0))
  const maxScaled = citationScale(maxCount, scale)

  const placed: PlacedNode[] = placeable.map((node) => {
    const year = node.year as number
    const x = padding.left + ((year - minYear) / yearSpan) * plotWidth
    const y = padding.top + plotHeight - (citationScale(node.citedByCount ?? 0, scale) / maxScaled) * plotHeight
    return { ...node, x, y, radius: radiusFor(node.citedByCount, node.role) }
  })

  // The seed last so it paints over its neighbours rather than under them.
  placed.sort((a, b) => Number(a.role === 'seed') - Number(b.role === 'seed'))

  const xTicks: AxisTick[] = niceYearTicks(minYear, maxYear).map((year) => ({
    value: year,
    position: padding.left + ((year - minYear) / yearSpan) * plotWidth,
    label: String(year),
  }))

  const yTicks: AxisTick[] = citationTickValues(maxCount, scale).map((count) => ({
    value: count,
    position: padding.top + plotHeight - (citationScale(count, scale) / maxScaled) * plotHeight,
    label: count >= 1000 ? `${Math.round(count / 1000)}k` : String(count),
  }))

  return { nodes: placed, xTicks, yTicks, width, height, droppedNoYear }
}

export interface GraphTheme {
  seed: string
  reference: string
  citing: string
  muted: string
  /** The tab background, for the ring that separates overlapping marks. */
  surface: string
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function colorFor(role: GraphRole, theme: GraphTheme): string {
  return role === 'seed' ? theme.seed : role === 'reference' ? theme.reference : theme.citing
}

/**
 * Render the layout as SVG.
 *
 * Marks carry a 2px ring in the surface colour so overlapping dots stay
 * countable, and works already in the library get a second, wider ring --
 * secondary encoding, so membership survives greyscale and colour blindness
 * rather than resting on hue.
 */
export function renderGraphSvg(layout: GraphLayout, theme: GraphTheme): string {
  const grid = layout.yTicks
    .map(
      (tick) =>
        `<line x1="0" y1="${tick.position.toFixed(1)}" x2="${layout.width}" y2="${tick.position.toFixed(1)}" ` +
        `stroke="${theme.muted}" stroke-width="1" opacity="0.15"/>`,
    )
    .join('')

  const yLabels = layout.yTicks
    .map(
      (tick) =>
        `<text x="4" y="${(tick.position - 3).toFixed(1)}" font-size="10" fill="${theme.muted}" ` +
        `opacity="0.75">${tick.label}</text>`,
    )
    .join('')

  const xLabels = layout.xTicks
    .map(
      (tick) =>
        `<text x="${tick.position.toFixed(1)}" y="${layout.height - 6}" font-size="10" fill="${theme.muted}" ` +
        `text-anchor="middle" opacity="0.75">${tick.label}</text>`,
    )
    .join('')

  const marks = layout.nodes
    .map((node) => {
      const fill = colorFor(node.role, theme)
      const inLibrary = node.itemID !== null
      const detail = [
        node.title,
        node.year === null ? null : String(node.year),
        node.citedByCount === null ? null : `${node.citedByCount} citations`,
        inLibrary ? 'in your library' : null,
      ]
        .filter(Boolean)
        .join(' · ')

      // Two rings, two meanings: the wider halo marks the seed, the inner one
      // library membership. Both are shape, not hue, so neither depends on
      // colour vision.
      const halo =
        node.role === 'seed'
          ? `<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${(node.radius + 7).toFixed(1)}" ` +
            `fill="none" stroke="${fill}" stroke-width="1" opacity="0.35"/>`
          : ''
      const ring = inLibrary
        ? `<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${(node.radius + 3).toFixed(1)}" ` +
          `fill="none" stroke="${fill}" stroke-width="1.5" opacity="0.55"/>`
        : ''

      return (
        halo +
        ring +
        `<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${node.radius.toFixed(1)}" ` +
        `fill="${fill}" stroke="${theme.surface}" stroke-width="2" ` +
        `data-key="${escapeXml(node.key)}" data-item-id="${node.itemID ?? ''}" ` +
        `data-doi="${escapeXml(node.doi ?? '')}" style="cursor:pointer">` +
        `<title>${escapeXml(detail)}</title></circle>`
      )
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
    `width="100%" height="100%" role="img" ` +
    `aria-label="Citations against publication year for ${layout.nodes.length} works">` +
    `<g>${grid}</g><g>${yLabels}${xLabels}</g><g>${marks}</g></svg>`
  )
}
