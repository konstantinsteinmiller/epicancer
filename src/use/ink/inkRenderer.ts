// ─── The ink renderer ──────────────────────────────────────────────────────
//
// Every doodle in Midnight Analog is generated here — there are no sprite
// bitmaps in the notebook world at all. This module turns plain geometry
// (a line, a circle, a polygon) into something that reads as ballpoint pen on
// ruled paper: wobbling strokes, doubled-back passes, ink pooling at the
// corners, cross-hatched shading, highlighter swipes.
//
// ── Coordinate space ──
// Callers draw in PAGE UNITS, never pixels. The page is always 1000 units
// wide; its height follows the viewport aspect (so portrait gets a tall page,
// landscape a wide one). `ph` tells a game how much vertical room it actually
// has, and `u` converts a "size" into page units that stay sane in both
// orientations. Nothing in the game may hardcode a pixel value — that's what
// makes 320×658 and a 4K desktop both work (GDD §General).
//
// ── The boil ──
// `boil` is 0|1|2 and advances at 12fps. Every draw call derives its wobble
// from (shapeId, boil), so each shape has exactly three alternate drawings
// that cycle — the classic animation "boil" (GDD §2.2). Callers pass a STABLE
// id per shape; reusing an id across two different shapes makes them wobble in
// lockstep, which is occasionally useful (a row of identical hatch marks) and
// usually a bug.
//
// ── Cost ──
// A sketchy stroke is 2-3 canvas passes over a handful of bezier segments.
// That's cheap, but it is not free, and the scene redraws only 12 times a
// second (see `useInkCanvas`) — so the per-frame budget here is generous.
// The genuinely expensive primitives are `hatch` (O(area/gap) strokes) and
// `splatter`; both are documented at their definitions.

import { makeRng, jitter, range } from './rng'
import { NOTEBOOK, HIGHLIGHT, type HighlightColor } from './palette'

export interface Pt {
  x: number
  y: number
}

export interface StrokeOpts {
  /** CSS colour. Defaults to ballpoint ink. */
  color?: string
  /** Stroke width in page units. */
  width?: number
  /** How far the pen wanders, in page units. 0 = a ruler-straight line. */
  rough?: number
  /** How many times the pen retraces the stroke. 2 is the sketchy default;
   *  1 reads as a confident single line; 3+ gets scribbly and dark. */
  passes?: number
  /** 0..1 opacity. */
  alpha?: number
  /** Close the path back to the first point. */
  close?: boolean
  /** Draw a soft wide underlay so the ink looks absorbed into the paper. */
  bleed?: boolean
  /** Round vs butt caps. Ballpoint is round. */
  cap?: CanvasLineCap
}

export interface HatchOpts {
  color?: string
  /** Gap between hatch lines, page units. Smaller = darker + costlier. */
  gap?: number
  /** Hatch direction in radians. */
  angle?: number
  /** Add a second pass at `angle + cross` for true cross-hatching. */
  cross?: number
  width?: number
  alpha?: number
  rough?: number
}

const TAU = Math.PI * 2

export class InkRenderer {
  ctx: CanvasRenderingContext2D
  /** Page width in page units. Always 1000 — the anchor of the whole space. */
  readonly pw = 1000
  /** Page height in page units, derived from the viewport aspect. */
  ph = 1000
  /** Pixels per page unit. Set by the canvas host on resize. */
  scale = 1
  /** Current boil frame, 0|1|2. Advanced at 12fps by the canvas host. */
  boil = 0
  /** Seconds since the scene started. */
  t = 0
  /** Global roughness multiplier. The core loop ramps this as the night
   *  escalates so the linework gets visibly more frantic (GDD §3.4). */
  roughMul = 1

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx
  }

  /** A size that stays proportionate in both orientations: scales with the
   *  SHORTER page axis, so a "50u" circle is never wider than the page in
   *  landscape nor stretched in portrait. */
  u(n: number): number {
    return (n * Math.min(this.pw, this.ph)) / 1000
  }

  /** Centre of the page. */
  get cx(): number { return this.pw / 2 }
  get cy(): number { return this.ph / 2 }

  /**
   * The play box: a CENTRED region of the page with a bounded aspect ratio.
   * Micro-games must lay out inside this rather than against the raw page.
   *
   * Why this exists: `u()` scales off the SHORTER axis (so a doodle is the
   * same physical size in any orientation), but the page's height follows the
   * viewport. On a tall phone — 320×658 gives a page 2056 units tall — those
   * two diverge badly: content sized in `u()` and positioned at `ph * 0.3`
   * bunches into the top third and leaves half a page of dead paper below it.
   *
   * Clamping the box to a 3:4-ish aspect and centring it keeps the action
   * composed and reachable by a thumb on every screen, while the PAGE itself
   * (paper, rules, HUD) still bleeds to the real edges.
   */
  get stage(): { x: number; y: number; w: number; h: number; cx: number; cy: number } {
    const h = Math.min(this.ph, this.pw * 1.45)
    const w = Math.min(this.pw, this.ph * 1.45)
    const x = (this.pw - w) / 2
    const y = (this.ph - h) / 2
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 }
  }

  // ── Core stroke machinery ────────────────────────────────────────────────

  /**
   * Trace a wobbling path through `pts`.
   *
   * The wobble is applied in two layers, which is what separates this from a
   * naive "add noise to every vertex":
   *   1. each vertex is displaced once (the hand not landing exactly), and
   *   2. each SEGMENT bows via a quadratic control point pushed off the
   *      midpoint (the hand not travelling perfectly straight between them).
   * Layer 2 is what makes a two-point line look drawn rather than measured.
   */
  private tracePath(pts: readonly Pt[], rng: () => number, rough: number, close: boolean): void {
    const { ctx } = this
    if (pts.length === 0) return

    const wob = (p: Pt): Pt => ({
      x: p.x + jitter(rng, rough),
      y: p.y + jitter(rng, rough)
    })

    const first = wob(pts[0]!)
    ctx.beginPath()
    ctx.moveTo(first.x, first.y)

    const n = pts.length
    const last = close ? n : n - 1
    let prev = first
    for (let i = 0; i < last; i++) {
      const raw = pts[(i + 1) % n]!
      const cur = i + 1 === n ? first : wob(raw)
      // Bow the segment: control point at the midpoint, shoved perpendicular-ish.
      const mx = (prev.x + cur.x) / 2 + jitter(rng, rough * 1.6)
      const my = (prev.y + cur.y) / 2 + jitter(rng, rough * 1.6)
      ctx.quadraticCurveTo(mx, my, cur.x, cur.y)
      prev = cur
    }
    if (close) ctx.closePath()
  }

  /**
   * The one primitive everything else is built from: draw `pts` as a hand-drawn
   * stroke. Multiple passes with independent wobble give the doubled-back
   * ballpoint look.
   */
  stroke(id: string, pts: readonly Pt[], opts: StrokeOpts = {}): void {
    if (pts.length < 2) return
    const { ctx } = this
    const color = opts.color ?? NOTEBOOK.ink
    const width = opts.width ?? 3
    const rough = (opts.rough ?? 2.2) * this.roughMul
    const passes = opts.passes ?? 2
    const alpha = opts.alpha ?? 1
    const close = opts.close ?? false

    ctx.save()
    ctx.lineCap = opts.cap ?? 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color

    // Ink bleed: a fat, near-transparent underlay. Reads as pigment soaking
    // into the paper fibres and stops thin strokes looking like vector art.
    //
    // It MUST trace the same curve as the first pass — hence the `:0` seed,
    // shared with the loop below. Seeding it independently makes it wander off
    // on its own path, and a wide soft stroke sitting next to the line instead
    // of under it reads as a drop-shadow, not absorption.
    if (opts.bleed) {
      ctx.globalAlpha = alpha * 0.13
      ctx.lineWidth = width * 2.4
      this.tracePath(pts, makeRng(`${id}:0`, this.boil), rough, close)
      ctx.stroke()
    }

    for (let p = 0; p < passes; p++) {
      // Each pass gets its own seed, so passes diverge instead of overdrawing
      // the identical curve (which would just look like one thick line).
      const rng = makeRng(`${id}:${p}`, this.boil)
      // Later passes are lighter and thinner — the pen bearing down once and
      // ghosting back over it.
      ctx.globalAlpha = alpha * (p === 0 ? 1 : 0.55)
      ctx.lineWidth = width * (p === 0 ? 1 : 0.75)
      this.tracePath(pts, rng, rough, close)
      ctx.stroke()
    }
    ctx.restore()
  }

  /** A straight-ish line. */
  line(id: string, x1: number, y1: number, x2: number, y2: number, opts: StrokeOpts = {}): void {
    this.stroke(id, [{ x: x1, y: y1 }, { x: x2, y: y2 }], opts)
  }

  /**
   * A hand-drawn circle. Sampled to a polygon first, with a deliberate
   * "overshoot": real pen circles don't close cleanly, they run past the start
   * by a few degrees. That overshoot is most of why this reads as drawn.
   */
  circle(id: string, cx: number, cy: number, r: number, opts: StrokeOpts = {}): void {
    const rng = makeRng(id + ':circ', this.boil)
    const steps = Math.max(10, Math.min(28, Math.round(r * 0.5) + 10))
    const start = range(rng, 0, TAU)
    const overshoot = range(rng, 0.12, 0.4)
    // Squash slightly on a random axis — nobody draws a true circle freehand.
    const sx = range(rng, 0.94, 1.06)
    const sy = range(rng, 0.94, 1.06)
    const pts: Pt[] = []
    for (let i = 0; i <= steps; i++) {
      const a = start + (i / steps) * (TAU + overshoot)
      pts.push({ x: cx + Math.cos(a) * r * sx, y: cy + Math.sin(a) * r * sy })
    }
    this.stroke(id, pts, { rough: 1.4, ...opts, close: false })
  }

  ellipse(
    id: string, cx: number, cy: number, rx: number, ry: number, rot = 0, opts: StrokeOpts = {}
  ): void {
    const rng = makeRng(id + ':ell', this.boil)
    const steps = 24
    const start = range(rng, 0, TAU)
    const overshoot = range(rng, 0.1, 0.35)
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const pts: Pt[] = []
    for (let i = 0; i <= steps; i++) {
      const a = start + (i / steps) * (TAU + overshoot)
      const ex = Math.cos(a) * rx
      const ey = Math.sin(a) * ry
      pts.push({ x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos })
    }
    this.stroke(id, pts, { rough: 1.4, ...opts, close: false })
  }

  /** A closed polygon. */
  shape(id: string, pts: readonly Pt[], opts: StrokeOpts = {}): void {
    this.stroke(id, pts, { ...opts, close: true })
  }

  rect(id: string, x: number, y: number, w: number, h: number, opts: StrokeOpts = {}): void {
    this.shape(id, [
      { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
    ], opts)
  }

  /** Rounded rect, sampled per corner. Used for the router body, the phone. */
  roundRect(
    id: string, x: number, y: number, w: number, h: number, r: number, opts: StrokeOpts = {}
  ): void {
    const pts: Pt[] = []
    const corner = (cx: number, cy: number, from: number) => {
      for (let i = 0; i <= 4; i++) {
        const a = from + (i / 4) * (Math.PI / 2)
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
      }
    }
    corner(x + w - r, y + r, -Math.PI / 2)
    corner(x + w - r, y + h - r, 0)
    corner(x + r, y + h - r, Math.PI / 2)
    corner(x + r, y + r, Math.PI)
    this.shape(id, pts, opts)
  }

  /** Solid (non-sketchy) fill of a closed polygon — paper-coloured masking,
   *  the inside of a scoop, etc. Deliberately NOT jittered: it sits UNDER
   *  sketchy linework, and a wobbling fill would peek out past its own
   *  outline. */
  fill(pts: readonly Pt[], color: string, alpha = 1): void {
    if (pts.length < 3) return
    const { ctx } = this
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(pts[0]!.x, pts[0]!.y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  fillCircle(cx: number, cy: number, r: number, color: string, alpha = 1): void {
    const { ctx } = this
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, TAU)
    ctx.fill()
    ctx.restore()
  }

  /**
   * Cross-hatched shading inside a closed polygon — the pencil-shading look of
   * the ice cream scoops and the boss's charcoal sky.
   *
   * COST: clips to the polygon, then rules lines across its bounding box every
   * `gap` units. Halving `gap` doubles the stroke count. For a full-page hatch
   * (the boss static veil) keep `gap` >= 14u and consider caching the result —
   * `FindSignal` bakes its veil into an offscreen canvas for exactly this
   * reason.
   */
  hatch(id: string, pts: readonly Pt[], opts: HatchOpts = {}): void {
    if (pts.length < 3) return
    const { ctx } = this
    const gap = opts.gap ?? 9
    const angle = opts.angle ?? -Math.PI / 4
    const color = opts.color ?? NOTEBOOK.inkSoft
    const width = opts.width ?? 1.6
    const alpha = opts.alpha ?? 0.55
    const rough = opts.rough ?? 1.2

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of pts) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }

    ctx.save()
    // Clip to the shape so the hatch can be ruled naively across the bbox.
    ctx.beginPath()
    ctx.moveTo(pts[0]!.x, pts[0]!.y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
    ctx.closePath()
    ctx.clip()

    const passes: number[] = [angle]
    if (opts.cross != null) passes.push(angle + opts.cross)

    for (let pi = 0; pi < passes.length; pi++) {
      const a = passes[pi]!
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      // Rule lines perpendicular to `a`, spanning the bbox diagonal so no
      // corner is missed regardless of angle.
      const diag = Math.hypot(maxX - minX, maxY - minY)
      const mx = (minX + maxX) / 2
      const my = (minY + maxY) / 2
      const count = Math.ceil(diag / gap)
      const half = diag / 2
      for (let i = -count; i <= count; i++) {
        // Perfectly even spacing is the tell that a machine ruled this. A
        // hand shading a shape drifts: the gap breathes, the pressure varies,
        // and each stroke starts and stops short of the last. Jitter all
        // three, seeded per line so it still boils coherently.
        const rng = makeRng(`${id}:h${pi}:${i}`, this.boil)
        const off = i * gap + jitter(rng, gap * 0.22)
        const ox = mx - sin * off
        const oy = my + cos * off
        // Asymmetric end trims — the clipping hides most of this, but where a
        // stroke ends INSIDE the shape it reads as a lifted pen.
        const t0 = -half * range(rng, 0.86, 1)
        const t1 = half * range(rng, 0.86, 1)
        this.stroke(
          `${id}:h${pi}:${i}`,
          [
            { x: ox + cos * t0, y: oy + sin * t0 },
            { x: ox + cos * t1, y: oy + sin * t1 }
          ],
          { color, width: width * range(rng, 0.75, 1.25), alpha: alpha * range(rng, 0.7, 1), rough, passes: 1 }
        )
      }
    }
    ctx.restore()
  }

  /**
   * A highlighter swipe: vivid, semi-transparent, multiply-blended so the ink
   * underneath still reads through it. This is the game's interactivity
   * language — if it's highlighted, you can touch it (GDD §2.2).
   */
  highlighter(id: string, pts: readonly Pt[], color: HighlightColor, width = 26, alpha = 0.5): void {
    const { ctx } = this
    ctx.save()
    // 'multiply' is the whole trick: a highlighter darkens what it crosses
    // rather than covering it. 'source-over' here would paint out the linework.
    ctx.globalCompositeOperation = 'multiply'
    this.stroke(id, pts, {
      color: HIGHLIGHT[color],
      width,
      alpha,
      passes: 1,
      rough: 3,
      cap: 'square'
    })
    ctx.restore()
  }

  /** A filled highlighter blob behind a shape — a danger zone, a target. */
  highlightBlob(id: string, cx: number, cy: number, r: number, color: HighlightColor, alpha = 0.45): void {
    const { ctx } = this
    const rng = makeRng(id + ':hb', this.boil)
    ctx.save()
    ctx.globalCompositeOperation = 'multiply'
    ctx.globalAlpha = alpha
    ctx.fillStyle = HIGHLIGHT[color]
    ctx.beginPath()
    const steps = 12
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * TAU
      const rr = r * range(rng, 0.82, 1.18)
      const x = cx + Math.cos(a) * rr
      const y = cy + Math.sin(a) * rr
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  /**
   * Ink splatter — a central blot plus satellite droplets. Fired when the
   * router explodes, a mosquito pops, or the avatar lands on the page.
   *
   * COST: `drops` circles. Keep under ~24 for a per-frame effect.
   */
  splatter(id: string, cx: number, cy: number, r: number, color: string = NOTEBOOK.ink, drops = 10, spread = 3): void {
    const rng = makeRng(id + ':spl', this.boil)
    // Core blot — irregular, never a clean disc.
    const pts: Pt[] = []
    const steps = 11
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * TAU
      const rr = r * range(rng, 0.6, 1.25)
      pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr })
    }
    this.fill(pts, color, 0.92)

    for (let i = 0; i < drops; i++) {
      const a = range(rng, 0, TAU)
      const d = range(rng, r * 1.1, r * spread)
      const rr = r * range(rng, 0.06, 0.3)
      this.fillCircle(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, color, range(rng, 0.5, 0.95))
    }
  }

  /** Short scratchy action lines radiating from a point — impact, speed,
   *  surprise. The cheapest juice in the game. */
  actionLines(id: string, cx: number, cy: number, rIn: number, rOut: number, count = 9, color: string = NOTEBOOK.ink): void {
    const rng = makeRng(id + ':act', this.boil)
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + range(rng, -0.12, 0.12)
      const r0 = rIn * range(rng, 0.9, 1.15)
      const r1 = rOut * range(rng, 0.8, 1.2)
      this.stroke(
        `${id}:al${i}`,
        [
          { x: cx + Math.cos(a) * r0, y: cy + Math.sin(a) * r0 },
          { x: cx + Math.cos(a) * r1, y: cy + Math.sin(a) * r1 }
        ],
        { color, width: 2.6, passes: 1, rough: 1.5 }
      )
    }
  }

  // ── Transform helpers ────────────────────────────────────────────────────

  /** Run `fn` inside a translate/rotate/scale. Saves the caller from
   *  matching save/restore pairs by hand. */
  transformed(x: number, y: number, rot: number, scale: number, fn: () => void): void {
    const { ctx } = this
    ctx.save()
    ctx.translate(x, y)
    if (rot) ctx.rotate(rot)
    if (scale !== 1) ctx.scale(scale, scale)
    fn()
    ctx.restore()
  }

  clipped(pts: readonly Pt[], fn: () => void): void {
    const { ctx } = this
    if (pts.length < 3) { fn(); return }
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(pts[0]!.x, pts[0]!.y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
    ctx.closePath()
    ctx.clip()
    fn()
    ctx.restore()
  }
}
