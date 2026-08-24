/**
 * The citation graph: model, scales and SVG.
 *
 * Free of Zotero and DOM dependencies so `node --test` can exercise the
 * arithmetic and the emitted markup.
 *
 * Form: a scatter, not a force-directed network. The question being asked is
 * "what came before this, what came after, and which of it mattered" -- that is
 * quantities per paper, and a spring layout would answer it by accident at
 * best.
 *
 * Which quantities is the reader's choice. Year against citations is the
 * default because time on the horizontal puts references on one side of the
 * seed and citing work on the other without drawing a single edge; but
 * citations against references asks a different and equally real question --
 * which of these works built on a wide literature and which got read -- and
 * that shape is one dropdown away rather than a different plot.
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
  /**
   * The library item this work already is, when its DOI matched one.
   *
   * An id rather than a flag: knowing a work is filed is worth something, and
   * being able to go to it is worth more.
   */
  itemID: number | null
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
  xMetric: AxisMetric
  yMetric: AxisMetric
  /** Works missing a value on either axis, which cannot be placed at all. */
  dropped: number
}

export interface LayoutOptions {
  width: number
  height: number
  padding: { top: number; right: number; bottom: number; left: number }
  /** Defaults to logarithmic; see citationScale for why it is a choice. */
  scale?: ScaleKind
  /** Defaults to year across, citations up. */
  xMetric?: AxisMetric
  yMetric?: AxisMetric
}

export type ScaleKind = 'log' | 'linear'

/** What an axis measures. Both axes take the same menu. */
export type AxisMetric = 'year' | 'citations' | 'references'

export const AXIS_METRICS: readonly AxisMetric[] = ['year', 'citations', 'references']

function metricValue(node: GraphNode, metric: AxisMetric): number | null {
  switch (metric) {
    case 'year':
      return node.year
    case 'citations':
      return node.citedByCount
    case 'references':
      return node.referenceCount
  }
}

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

/**
 * "Soleimani 2019" at rest, the title added on top when the work is the one
 * being pointed at.
 *
 * Author and year is what identifies a paper to someone who knows the field,
 * and it is four times narrower than a truncated title -- so far more marks
 * carry a name at all, which is what the label is for. The title is the answer
 * to a question about one particular mark, and it arrives when that question
 * is asked.
 */
function labelFor(node: GraphNode, withTitle: boolean): string {
  const head = [node.author, node.year === null ? null : String(node.year)].filter(Boolean).join(' ')
  if (!withTitle) return head || truncate(node.title, LABEL_CHARS)
  const title = truncate(node.title, TITLE_CHARS)
  return head ? `${head} · ${title}` : title
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text
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

/**
 * The strips along the left and bottom edges that belong to the axis alone.
 *
 * The marks are clipped out of them, which is what lets the tick numbers stay
 * put while the plot moves underneath: without the clip, a work panned into
 * the corner would be painted straight over the scale that explains it.
 */
export const AXIS_GUTTER = { left: 26, bottom: 16 }

/** A fallback width, for the rare work with neither author nor year. */
const LABEL_CHARS = 24
/** The title, once a mark is pointed at and has the field to itself. */
const TITLE_CHARS = 46
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

/**
 * Where the plot sits inside the frame. Identity is the fitted view.
 *
 * One factor per axis, not one for both. Marks keep their size whatever the
 * zoom, so stretching only the horizontal distorts nothing -- it pulls apart a
 * run of works published in the same few years while leaving the citation
 * spread alone, which is exactly the crowding a single factor cannot address.
 */
export interface Viewport {
  kx: number
  ky: number
  tx: number
  ty: number
  width: number
  height: number
}

export const FITTED = (width: number, height: number): Viewport => ({
  kx: 1,
  ky: 1,
  tx: 0,
  ty: 0,
  width,
  height,
})

export interface LabelPlacement {
  key: string
  text: string
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
}

/**
 * Lay the labels out for one view of the plot.
 *
 * Fifty labels cannot all be shown at once, and picking arbitrarily would hide
 * the interesting ones. So they go down in order of consequence -- the seed,
 * then the most-cited -- and one is dropped when its box overlaps a mark or a
 * label already placed. What survives is the part of the field worth reading,
 * and everything keeps its tooltip regardless.
 *
 * It takes a viewport rather than assuming the fitted one because marks keep
 * their size while zooming spreads them apart. Which labels fit is therefore a
 * property of the current zoom, not of the data -- and re-running this on every
 * transform is what makes zooming reveal names instead of magnifying them.
 */
export function placeLabels(
  nodes: readonly PlacedNode[],
  view: Viewport,
  emphasis: string | null = null,
): LabelPlacement[] {
  const at = (node: PlacedNode): { x: number; y: number } => ({
    x: node.x * view.kx + view.tx,
    y: node.y * view.ky + view.ty,
  })

  const byImportance = [...nodes].sort((a, b) => {
    // The mark being pointed at goes down first: its label is the longest and
    // the one certainly wanted, so it must not lose a spot to a neighbour.
    if ((a.key === emphasis) !== (b.key === emphasis)) return a.key === emphasis ? -1 : 1
    if (a.role !== b.role) return a.role === 'seed' ? -1 : b.role === 'seed' ? 1 : 0
    return (b.citedByCount ?? 0) - (a.citedByCount ?? 0)
  })

  // The marks are obstacles too, not just the labels. Checking only label
  // against label is what let a title be painted straight across the seed.
  const taken: Box[] = nodes.map((node) => {
    const point = at(node)
    return {
      x1: point.x - node.radius - 2,
      y1: point.y - node.radius - 2,
      x2: point.x + node.radius + 2,
      y2: point.y + node.radius + 2,
    }
  })

  const placed: LabelPlacement[] = []
  for (const node of byImportance) {
    const pointed = node.key === emphasis
    /**
     * What to try, in order.
     *
     * The pointed-at mark gets three goes: its title in a clear spot, its
     * title over its neighbours, then its plain name. Letting it cover them is
     * deliberate -- they are dimmed while the pointer is there, the state
     * lasts as long as the pointer does, and a title that never appears
     * because the field is crowded answers the question nobody could ask
     * another way. Every other mark takes a clear spot or goes without.
     */
    const attempts: { text: string; overNeighbours: boolean }[] = pointed
      ? [
          { text: labelFor(node, true), overNeighbours: false },
          { text: labelFor(node, true), overNeighbours: true },
          { text: labelFor(node, false), overNeighbours: true },
        ]
      : [{ text: labelFor(node, false), overNeighbours: false }]

    for (const { text, overNeighbours } of attempts) {
      if (!text) continue
      const point = at(node)
      // A mark off-screen needs no name, and testing it would waste the spot.
      if (point.x < -node.radius || point.x > view.width + node.radius) continue
      if (point.y < -node.radius || point.y > view.height + node.radius) continue

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
          place(point.x, point.y + gap + LABEL_HEIGHT - 3, 'middle', point.y + gap),
          place(point.x, point.y - gap - 3, 'middle', point.y - gap - LABEL_HEIGHT),
          place(point.x + gap, point.y + 3.5, 'start', point.y - LABEL_HEIGHT / 2),
          place(point.x - gap, point.y + 3.5, 'end', point.y - LABEL_HEIGHT / 2),
          // The diagonals are what keep a mark in a dense cluster from going
          // nameless when all four sides happen to be occupied.
          place(point.x + diagonal, point.y + diagonal + LABEL_HEIGHT, 'start', point.y + diagonal),
          place(point.x - diagonal, point.y + diagonal + LABEL_HEIGHT, 'end', point.y + diagonal),
          place(point.x + diagonal, point.y - diagonal - 3, 'start', point.y - diagonal - LABEL_HEIGHT),
          place(point.x - diagonal, point.y - diagonal - 3, 'end', point.y - diagonal - LABEL_HEIGHT),
        ]
      }

      /**
       * The seed and the pointed-at mark keep searching outward; everything
       * else takes a nearby spot or none.
       *
       * A crowded seed is the normal case -- its own citing works pile up
       * beside it -- and dropping its label is the one failure the plot cannot
       * absorb, because that mark is what the reader opened the tab to find.
       * The same goes for whatever the pointer is on.
       */
      const radii = node.role === 'seed' || pointed ? [1, 1.8, 2.8, 4.2] : [1]
      const fits = radii
        .flatMap((factor) => spotsAt((node.radius + 4) * factor))
        .find(
          (candidate) =>
            // Inside the plot, not the gutters: a label there would be clipped
            // in half the moment anything moved.
            candidate.box.x1 >= AXIS_GUTTER.left + 2 &&
            candidate.box.x2 <= view.width - 2 &&
            candidate.box.y1 >= 0 &&
            candidate.box.y2 <= view.height - AXIS_GUTTER.bottom - 2 &&
            (overNeighbours || !taken.some((other) => overlaps(candidate.box, other))),
        )
      if (!fits) continue

      taken.push(fits.box)
      placed.push({ key: node.key, text, x: fits.x, y: fits.y, anchor: fits.anchor })
      break
    }
  }
  return placed
}

/** The fitted-view placement, written back onto the nodes for the first paint. */
function assignLabels(nodes: PlacedNode[], width: number, height: number): void {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  for (const placement of placeLabels(nodes, FITTED(width, height))) {
    const node = byKey.get(placement.key)
    if (!node) continue
    node.label = placement.text
    node.labelX = placement.x
    node.labelY = placement.y
    node.labelAnchor = placement.anchor
  }
}

/**
 * One axis: where a value sits along it, and what to mark on it.
 *
 * Year and the two counts behave differently and the difference matters.
 * A year axis spans the years present -- starting it at zero would push every
 * paper into the right-hand pixel. A count axis starts at zero, because zero
 * citations is a real and meaningful place to be, and it honours the log/linear
 * choice, which a year axis cannot: the logarithm of 2019 is not a date.
 */
interface Axis {
  fraction: (value: number) => number
  ticks: { value: number; fraction: number; label: string }[]
}

function compact(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
}

function buildAxis(metric: AxisMetric, values: number[], scale: ScaleKind): Axis {
  if (metric === 'year') {
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = Math.max(1, max - min)
    const fraction = (value: number): number => (value - min) / span
    return {
      fraction,
      ticks: niceYearTicks(min, max).map((year) => ({ value: year, fraction: fraction(year), label: String(year) })),
    }
  }

  const max = Math.max(1, ...values)
  const top = citationScale(max, scale)
  const fraction = (value: number): number => citationScale(value, scale) / top
  return {
    fraction,
    ticks: citationTickValues(max, scale).map((count) => ({
      value: count,
      fraction: fraction(count),
      label: compact(count),
    })),
  }
}

export function buildGraphLayout(nodes: readonly GraphNode[], options: LayoutOptions): GraphLayout | null {
  const xMetric = options.xMetric ?? 'year'
  const yMetric = options.yMetric ?? 'citations'

  // A work missing either coordinate cannot be placed. Which works those are
  // changes with the axes: swap the vertical to references and every paper
  // Semantic Scholar knows nothing about the bibliography of drops out.
  const placeable = nodes.filter((node) => metricValue(node, xMetric) !== null && metricValue(node, yMetric) !== null)
  const dropped = nodes.length - placeable.length
  if (placeable.length === 0) return null

  const { width, height, padding } = options
  const scale: ScaleKind = options.scale ?? 'log'
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom

  const xAxis = buildAxis(
    xMetric,
    placeable.map((node) => metricValue(node, xMetric) as number),
    scale,
  )
  const yAxis = buildAxis(
    yMetric,
    placeable.map((node) => metricValue(node, yMetric) as number),
    scale,
  )

  const placed: PlacedNode[] = placeable.map((node) => ({
    ...node,
    x: padding.left + xAxis.fraction(metricValue(node, xMetric) as number) * plotWidth,
    y: padding.top + plotHeight - yAxis.fraction(metricValue(node, yMetric) as number) * plotHeight,
    radius: radiusFor(node.referenceCount, node.role),
    label: null,
  }))

  assignLabels(placed, width, height)

  // The seed last so it paints over its neighbours rather than under them.
  placed.sort((a, b) => Number(a.role === 'seed') - Number(b.role === 'seed'))

  const xTicks: AxisTick[] = xAxis.ticks.map((tick) => ({
    value: tick.value,
    position: padding.left + tick.fraction * plotWidth,
    label: tick.label,
  }))

  const yTicks: AxisTick[] = yAxis.ticks.map((tick) => ({
    value: tick.value,
    position: padding.top + plotHeight - tick.fraction * plotHeight,
    label: tick.label,
  }))

  return { nodes: placed, xTicks, yTicks, width, height, xMetric, yMetric, dropped }
}

/**
 * What to call the axes in the text alternative.
 *
 * Passed in rather than looked up: this module knows nothing of Fluent, and a
 * screen reader being told "citations against year" is worth more than the
 * metric keys it would otherwise fall back to.
 */
export interface GraphText {
  x: string
  y: string
  /** Appended to the tooltip of a work that is already filed. */
  inLibrary: string
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

/**
 * Where an edge starts and stops, for one view.
 *
 * Shared with the tab, which recomputes it on every transform. The gaps are
 * screen distances rather than data ones: the marks no longer scale, so the
 * arrowhead must sit the same few pixels off its target at any zoom, and an
 * edge whose ends have come closer together than the two gaps is not drawn --
 * a head pointing backwards through its own mark says the opposite of the
 * truth.
 */
export function edgeEnds(
  from: { x: number; y: number; radius: number },
  to: { x: number; y: number; radius: number },
  view: Viewport,
): { x1: number; y1: number; x2: number; y2: number; hidden: boolean } {
  const fx = from.x * view.kx + view.tx
  const fy = from.y * view.ky + view.ty
  const tox = to.x * view.kx + view.tx
  const toy = to.y * view.ky + view.ty
  const dx = tox - fx
  const dy = toy - fy
  const length = Math.hypot(dx, dy) || 1
  const startGap = from.radius + 2
  const endGap = to.radius + 7
  if (length <= startGap + endGap) return { x1: fx, y1: fy, x2: fx, y2: fy, hidden: true }
  return {
    x1: fx + (dx / length) * startGap,
    y1: fy + (dy / length) * startGap,
    x2: fx + (dx / length) * (length - endGap),
    y2: fy + (dy / length) * (length - endGap),
    hidden: false,
  }
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
/**
 * @param uid Namespaces the ids in `defs`. Two graphs in one document -- two
 *   open tabs -- otherwise both define `plot-area`, and `url(#plot-area)`
 *   resolves to whichever came first. The second plot is then clipped by the
 *   first one's rectangle, which sits in a hidden tab and has collapsed to
 *   nothing, so the second tab draws an empty box until the first is closed.
 */
export function renderGraphSvg(layout: GraphLayout, theme: GraphTheme, text?: GraphText, uid = 'orbit-graph'): string {
  /**
   * Each tick is its own group, tagged with where it started.
   *
   * Zoom moves the plot, not the frame around it: the numbers keep their size
   * and their place along the edge, and only slide along their own axis to stay
   * on the value they name. Reading that off `data-pos` is what lets one
   * attribute write per tick do it, rather than re-rendering the axis.
   */
  const yTickGroups = layout.yTicks
    .map(
      (tick) =>
        `<g data-axis="y" data-pos="${tick.position.toFixed(1)}">` +
        `<line x1="${AXIS_GUTTER.left}" y1="${tick.position.toFixed(1)}" x2="${layout.width}" ` +
        `y2="${tick.position.toFixed(1)}" stroke="${theme.muted}" stroke-width="1" opacity="0.15"/>` +
        `<text x="4" y="${(tick.position - 3).toFixed(1)}" font-size="10" fill="${theme.muted}" ` +
        `opacity="0.75">${tick.label}</text></g>`,
    )
    .join('')

  const xTickGroups = layout.xTicks
    .map(
      (tick) =>
        `<g data-axis="x" data-pos="${tick.position.toFixed(1)}">` +
        `<text x="${tick.position.toFixed(1)}" y="${layout.height - 4}" font-size="10" fill="${theme.muted}" ` +
        `text-anchor="middle" opacity="0.75">${tick.label}</text></g>`,
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
          const ends = edgeEnds(from, to, FITTED(layout.width, layout.height))
          // The centres and the two gaps travel with the line, because zoom
          // moves the ends without changing how far the head sits off a mark:
          // the marks keep their size, so the gaps are screen distances now.
          return (
            `<line data-edge="1" data-key="${escapeXml(node.key)}" x1="${ends.x1.toFixed(1)}" ` +
            `y1="${ends.y1.toFixed(1)}" ` +
            `x2="${ends.x2.toFixed(1)}" y2="${ends.y2.toFixed(1)}" ` +
            `data-from="${from.x.toFixed(1)},${from.y.toFixed(1)}" data-to="${to.x.toFixed(1)},${to.y.toFixed(1)}" ` +
            `data-gaps="${(from.radius + 2).toFixed(1)},${(to.radius + 7).toFixed(1)}" ` +
            `stroke="${colorFor(node.role, theme)}" stroke-width="1.2" opacity="${ends.hidden ? 0 : 0.4}" ` +
            `marker-end="url(#${uid}-${node.role === 'reference' ? 'arrow-ref' : 'arrow-cite'})"/>`
          )
        })
        .join('')
    : ''

  const arrowDefs =
    `<defs>` +
    `<clipPath id="${uid}-plot-area"><rect x="${AXIS_GUTTER.left}" y="0" ` +
    `width="${layout.width - AXIS_GUTTER.left}" height="${layout.height - AXIS_GUTTER.bottom}"/></clipPath>` +
    `<marker id="${uid}-arrow-ref" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" ` +
    `markerUnits="userSpaceOnUse" orient="auto">` +
    `<path d="M0,0.5 L7.5,4 L0,7.5 z" fill="${theme.reference}" opacity="0.8"/></marker>` +
    `<marker id="${uid}-arrow-cite" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" ` +
    `markerUnits="userSpaceOnUse" orient="auto">` +
    `<path d="M0,0.5 L7.5,4 L0,7.5 z" fill="${theme.citing}" opacity="0.8"/></marker>` +
    `</defs>`

  /**
   * One text element per mark, whether or not it is showing.
   *
   * A fixed pool rather than markup rebuilt on every wheel event: which labels
   * fit changes with the zoom, and swapping attributes on elements that already
   * exist is both faster and free of the flicker that tearing down a group and
   * building it again produces.
   */
  const shown = layout.nodes.filter((node) => node.label !== null)
  const labels = layout.nodes
    .map((_, slot) => {
      const node = shown[slot]
      return (
        `<text data-label="${slot}" x="${(node?.labelX ?? 0).toFixed(1)}" y="${(node?.labelY ?? 0).toFixed(1)}" ` +
        `font-size="10" fill="${theme.muted}" text-anchor="${node?.labelAnchor ?? 'middle'}" ` +
        `opacity="${node ? 0.9 : 0}" ` +
        `paint-order="stroke" stroke="${theme.surface}" stroke-width="3" stroke-linejoin="round">` +
        `${escapeXml(node?.label ?? '')}</text>`
      )
    })
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
        node.itemID === null ? null : (text?.inLibrary ?? 'in your library'),
      ]
        .filter(Boolean)
        .join(' · ')

      const halo =
        node.role === 'seed'
          ? `<circle r="${(node.radius + 7).toFixed(1)}" fill="none" stroke="${fill}" ` +
            `stroke-width="1" opacity="0.35"/>`
          : ''

      /**
       * A collar in plain ink around work that is already filed.
       *
       * Outside the surface ring rather than instead of it: that ring is what
       * keeps overlapping marks countable, and spending it here would trade one
       * piece of information for another. Ink rather than a fourth hue, because
       * the three hues already mean role, and because "I have this" is a fact
       * about the reader rather than about the citation -- it should read in
       * greyscale, and it does.
       */
      const collar =
        node.itemID === null
          ? ''
          : `<circle r="${(node.radius + 2.6).toFixed(1)}" fill="none" stroke="${theme.muted}" ` +
            `stroke-width="1.6" opacity="0.85"/>`

      // The geometry sits at the origin and the group carries the position, so
      // zoom moves the mark without resizing it. Litmaps' behaviour, and the
      // right one: a crowded middle needs the marks pulled apart, not enlarged.
      return (
        `<g data-mark="1" data-key="${escapeXml(node.key)}" data-at="${node.x.toFixed(1)},${node.y.toFixed(1)}" ` +
        `transform="translate(${node.x.toFixed(1)},${node.y.toFixed(1)})">` +
        halo +
        collar +
        `<circle r="${node.radius.toFixed(1)}" fill="${fill}" stroke="${theme.surface}" stroke-width="2" ` +
        `data-key="${escapeXml(node.key)}" data-doi="${escapeXml(node.doi ?? '')}" ` +
        `data-item="${node.itemID ?? ''}" ` +
        `style="cursor:pointer"><title>${escapeXml(detail)}</title></circle></g>`
      )
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
    `width="100%" height="100%" role="img" ` +
    `aria-label="${escapeXml(text?.y ?? layout.yMetric)} against ` +
    `${escapeXml(text?.x ?? layout.xMetric)} for ${layout.nodes.length} works">` +
    arrowDefs +
    // The frame first, the plot over it. The numbers survive that order only
    // because the clip keeps the marks out of the gutters they live in -- which
    // is the whole reason the gutters are reserved.
    `<g data-role="axis">${yTickGroups}${xTickGroups}</g>` +
    `<g data-role="content" clip-path="url(#${uid}-plot-area)">` +
    `<g data-role="edges">${edges}</g><g data-role="marks">${marks}</g>` +
    `<g data-role="labels">${labels}</g></g></svg>`
  )
}
