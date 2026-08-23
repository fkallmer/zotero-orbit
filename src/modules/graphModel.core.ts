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
  /** First author's surname; the label reads "Soleimani 2019". */
  author: string | null
  /**
   * How many works it cites.
   *
   * The size channel. Citations already own the vertical axis, and sizing by
   * them too would spend two channels on one variable while breadth -- a
   * review with 200 references beside a letter with 8 -- went unsaid.
   */
  referenceCount: number | null
}

export interface PlacedNode extends GraphNode {
  x: number
  y: number
  radius: number
  /** Null when the label would have collided with one already placed. */
  label: string | null
  labelX?: number
  labelY?: number
  labelAnchor?: 'start' | 'middle' | 'end'
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
 * Radius by how many works a paper cites, area-proportional.
 *
 * sqrt keeps area rather than diameter proportional, which is how the eye
 * reads a disc. A work with no known bibliography still gets the base size
 * rather than vanishing -- absent data is not the same as a bibliography of
 * nothing.
 *
 * The seed gets a floor: it is the mark the reader is looking for, and a short
 * paper among its own influences would otherwise be the smallest dot on a plot
 * that is about it.
 */
function radiusFor(referenceCount: number | null, role: GraphRole): number {
  const radius = 6 + Math.sqrt(referenceCount ?? 0) * 1.9
  return role === 'seed' ? Math.max(radius, 16) : radius
}

/** "Soleimani 2019 · Magnetic induction tomography" as far as it fits. */
function labelFor(node: GraphNode, maxChars: number): string {
  const head = [node.author, node.year === null ? null : String(node.year)].filter(Boolean).join(' ')
  const title = node.title.length > maxChars ? `${node.title.slice(0, maxChars - 1).trimEnd()}…` : node.title
  return head ? `${head} · ${title}` : title
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

const LABEL_CHARS = 34
/** Rough width of a character at the label's font size. */
const CHAR_WIDTH = 5.4
const LABEL_HEIGHT = 12

/**
 * Give every mark a label that does not sit on another one.
 *
 * Fifty labels on one plot cannot all be shown, and picking arbitrarily would
 * hide the interesting ones. So they are placed in order of consequence -- the
 * seed, then the most-cited -- and a label is dropped when its box overlaps one
 * already placed. What survives is the part of the field worth reading, and
 * everything keeps its tooltip regardless.
 */
interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface LabelSpot {
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  box: Box
}

function overlaps(a: Box, b: Box): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1
}

function assignLabels(nodes: PlacedNode[], width: number, height: number): void {
  const byImportance = [...nodes].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'seed' ? -1 : b.role === 'seed' ? 1 : 0
    return (b.citedByCount ?? 0) - (a.citedByCount ?? 0)
  })

  // The marks are obstacles too, not just the labels. Checking only label
  // against label is what let a title be painted straight across the seed.
  const taken: Box[] = nodes.map((node) => ({
    x1: node.x - node.radius - 2,
    y1: node.y - node.radius - 2,
    x2: node.x + node.radius + 2,
    y2: node.y + node.radius + 2,
  }))

  for (const node of byImportance) {
    const text = labelFor(node, LABEL_CHARS)
    if (!text) continue
    const textWidth = text.length * CHAR_WIDTH

    /**
     * Below, above, right, left -- in that order.
     *
     * Below reads best because the label hangs off the mark the way a caption
     * does, but in a crowded field insisting on it is what drops two thirds of
     * the labels. Trying the other three sides first costs nothing and keeps
     * names on marks that would otherwise be anonymous.
     */
    const place = (x: number, y: number, anchor: 'start' | 'middle' | 'end', top: number): LabelSpot => {
      const left = anchor === 'start' ? x : anchor === 'end' ? x - textWidth : x - textWidth / 2
      return { x, y, anchor, box: { x1: left, y1: top, x2: left + textWidth, y2: top + LABEL_HEIGHT } }
    }
    const spotsAt = (gap: number): LabelSpot[] => {
      const diagonal = gap * 0.75
      return [
        place(node.x, node.y + gap + LABEL_HEIGHT - 3, 'middle', node.y + gap),
        place(node.x, node.y - gap - 3, 'middle', node.y - gap - LABEL_HEIGHT),
        place(node.x + gap, node.y + 3.5, 'start', node.y - LABEL_HEIGHT / 2),
        place(node.x - gap, node.y + 3.5, 'end', node.y - LABEL_HEIGHT / 2),
        // The diagonals are what keep a mark in a dense cluster from going
        // nameless when all four sides happen to be occupied.
        place(node.x + diagonal, node.y + diagonal + LABEL_HEIGHT, 'start', node.y + diagonal),
        place(node.x - diagonal, node.y + diagonal + LABEL_HEIGHT, 'end', node.y + diagonal),
        place(node.x + diagonal, node.y - diagonal - 3, 'start', node.y - diagonal - LABEL_HEIGHT),
        place(node.x - diagonal, node.y - diagonal - 3, 'end', node.y - diagonal - LABEL_HEIGHT),
      ]
    }

    /**
     * The seed keeps searching outward; everything else takes a nearby spot or
     * none.
     *
     * A crowded seed is the normal case -- its own citing works pile up beside
     * it -- and dropping its label is the one failure the plot cannot absorb,
     * because that mark is what the reader opened the tab to find.
     */
    const radii = node.role === 'seed' ? [1, 1.8, 2.8, 4.2] : [1]
    const fits = radii
      .flatMap((factor) => spotsAt((node.radius + 4) * factor))
      .find(
        (candidate) =>
          candidate.box.x1 >= 2 &&
          candidate.box.x2 <= width - 2 &&
          candidate.box.y1 >= 0 &&
          candidate.box.y2 <= height - 2 &&
          !taken.some((other) => overlaps(candidate.box, other)),
      )
    if (!fits) continue

    taken.push(fits.box)
    node.label = text
    node.labelX = fits.x
    node.labelY = fits.y
    node.labelAnchor = fits.anchor
  }
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
    return { ...node, x, y, radius: radiusFor(node.referenceCount, node.role), label: null }
  })

  assignLabels(placed, width, height)

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
 * countable, and the seed a wider halo -- shape rather than hue, so the focal
 * point survives greyscale and colour blindness.
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

  const seed = layout.nodes.find((node) => node.role === 'seed')

  /**
   * Edges, drawn from citer to cited so the arrowhead states the direction.
   *
   * The seed cites its references, so those run seed -> reference; the citing
   * works cite the seed, so those run the other way. Without the heads the
   * plot shows two clusters and leaves the reader to infer which way influence
   * flowed, which is the one thing the graph is for.
   *
   * They stop short of the target so the head sits beside the mark rather than
   * under it, and they are faint: at fifty edges the marks must stay legible.
   */
  const edges = seed
    ? layout.nodes
        .filter((node) => node.role !== 'seed')
        .map((node) => {
          const from = node.role === 'reference' ? seed : node
          const to = node.role === 'reference' ? node : seed
          const dx = to.x - from.x
          const dy = to.y - from.y
          const length = Math.hypot(dx, dy) || 1
          const startGap = from.radius + 2
          const endGap = to.radius + 7
          if (length <= startGap + endGap) return ''
          const x1 = from.x + (dx / length) * startGap
          const y1 = from.y + (dy / length) * startGap
          const x2 = from.x + (dx / length) * (length - endGap)
          const y2 = from.y + (dy / length) * (length - endGap)
          return (
            `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ` +
            `stroke="${colorFor(node.role, theme)}" stroke-width="1.2" opacity="0.4" ` +
            `marker-end="url(#${node.role === 'reference' ? 'arrow-ref' : 'arrow-cite'})"/>`
          )
        })
        .join('')
    : ''

  const arrowDefs =
    `<defs>` +
    `<marker id="arrow-ref" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" ` +
    `markerUnits="userSpaceOnUse" orient="auto">` +
    `<path d="M0,0.5 L7.5,4 L0,7.5 z" fill="${theme.reference}" opacity="0.8"/></marker>` +
    `<marker id="arrow-cite" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" ` +
    `markerUnits="userSpaceOnUse" orient="auto">` +
    `<path d="M0,0.5 L7.5,4 L0,7.5 z" fill="${theme.citing}" opacity="0.8"/></marker>` +
    `</defs>`

  const labels = layout.nodes
    .filter((node) => node.label !== null)
    .map(
      (node) =>
        `<text x="${(node.labelX ?? node.x).toFixed(1)}" y="${(node.labelY ?? node.y).toFixed(1)}" ` +
        `font-size="10" fill="${theme.muted}" text-anchor="${node.labelAnchor ?? 'middle'}" opacity="0.9" ` +
        `paint-order="stroke" stroke="${theme.surface}" stroke-width="3" stroke-linejoin="round">` +
        `${escapeXml(node.label as string)}</text>`,
    )
    .join('')

  const marks = layout.nodes
    .map((node) => {
      const fill = colorFor(node.role, theme)
      const detail = [
        node.title,
        node.year === null ? null : String(node.year),
        node.citedByCount == null ? null : `${node.citedByCount} citations`,
        // == null, not === null: a caller that simply omits the field would
        // otherwise get "cites undefined" printed at it.
        node.referenceCount == null ? null : `cites ${node.referenceCount} works`,
      ]
        .filter(Boolean)
        .join(' · ')

      const halo =
        node.role === 'seed'
          ? `<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${(node.radius + 7).toFixed(1)}" ` +
            `fill="none" stroke="${fill}" stroke-width="1" opacity="0.35"/>`
          : ''

      return (
        halo +
        `<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${node.radius.toFixed(1)}" ` +
        `fill="${fill}" stroke="${theme.surface}" stroke-width="2" ` +
        `data-key="${escapeXml(node.key)}" data-doi="${escapeXml(node.doi ?? '')}" ` +
        `style="cursor:pointer"><title>${escapeXml(detail)}</title></circle>`
      )
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
    `width="100%" height="100%" role="img" ` +
    `aria-label="Citations against publication year for ${layout.nodes.length} works">` +
    arrowDefs +
    `<g>${grid}</g><g>${yLabels}${xLabels}</g><g>${edges}</g><g>${marks}</g><g>${labels}</g></svg>`
  )
}
