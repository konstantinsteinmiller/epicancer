// ─── The notebook page ─────────────────────────────────────────────────────
//
// Draws the surface everything else happens on: warm paper, light-blue rules,
// a red margin, spiral binding, and a grain texture that stops the whole thing
// reading as a flat white rectangle (GDD §2.2 asks for a "highly-textured,
// scan-line or grain-mapped ruled paper texture").
//
// PERFORMANCE
// The page is static for a whole micro-game, and grain is by far the most
// expensive thing we draw (per-pixel noise). So:
//   - the grain is baked ONCE into a small tile and repeated via a canvas
//     pattern — generating it per frame at full res would cost ~15ms/frame,
//   - the page itself renders into a cached offscreen canvas and is blitted,
//     regenerating only when the viewport size changes.
// Net cost per frame: one drawImage. See `drawPaper`.

import { mulberry32, makeRng, range } from './rng'
import { NOTEBOOK } from './palette'
import { InkRenderer, type Pt } from './inkRenderer'

// ── Grain tile ────────────────────────────────────────────────────────────
// A seamless square of paper noise, tiled across the page. 128px is the
// sweet spot: big enough that the repeat isn't visible under the linework,
// small enough to bake in well under a millisecond.
const GRAIN_TILE_PX = 128
let grainTile: HTMLCanvasElement | null = null
let grainPattern: CanvasPattern | null = null

/** Bake the grain tile. Idempotent; safe to call from a warm-up path (see
 *  `useAssets.runBackgroundWarmup`) or lazily on first draw. */
export const warmGrainTile = (): HTMLCanvasElement => {
  if (grainTile) return grainTile
  const c = document.createElement('canvas')
  c.width = GRAIN_TILE_PX
  c.height = GRAIN_TILE_PX
  const g = c.getContext('2d')
  if (!g) return c

  const img = g.createImageData(GRAIN_TILE_PX, GRAIN_TILE_PX)
  const rng = mulberry32(0x9e3779b9)
  const data = img.data
  for (let i = 0; i < data.length; i += 4) {
    // Mostly-transparent speckle: a few dark fibres, a few light ones. Alpha
    // is what varies — the colour stays a neutral warm grey so the grain
    // tints toward the paper rather than greying it out.
    const n = rng()
    const v = n < 0.5 ? 90 : 190
    const a = n < 0.06 || n > 0.965 ? Math.floor(range(rng, 6, 22)) : 0
    data[i] = v
    data[i + 1] = v - 6
    data[i + 2] = v - 18
    data[i + 3] = a
  }
  g.putImageData(img, 0, 0)
  grainTile = c
  grainPattern = null
  return c
}

// ── Page cache ────────────────────────────────────────────────────────────
let pageCache: HTMLCanvasElement | null = null
let pageKey = ''

export interface PaperOpts {
  /** Draw the spiral binding down the left edge. */
  spiral?: boolean
  /** Rule spacing in page units. */
  ruleGap?: number
  /** Where the red margin sits, in page units from the left. */
  marginX?: number
  /** Skip the ruled lines — the boss's night sky is on blank paper. */
  blank?: boolean
}

/**
 * Render the page into `ink`'s canvas. Cached: the expensive work runs only
 * when the canvas size or options change, after which this is one blit.
 *
 * The cache key deliberately includes the pixel size — a resize must
 * regenerate, or the page would be upscaled and go blurry.
 */
export const drawPaper = (ink: InkRenderer, opts: PaperOpts = {}): void => {
  const { ctx } = ink
  const wPx = Math.max(1, Math.round(ink.pw * ink.scale))
  const hPx = Math.max(1, Math.round(ink.ph * ink.scale))
  const key = `${wPx}x${hPx}:${opts.spiral ? 1 : 0}:${opts.blank ? 1 : 0}:${opts.ruleGap ?? 0}:${opts.marginX ?? 0}`

  if (!pageCache || pageKey !== key) {
    pageCache = bakePage(ink, wPx, hPx, opts)
    pageKey = key
  }

  ctx.save()
  // The cache is baked in DEVICE pixels; the live context is scaled to page
  // units. Reset to identity for a 1:1 blit, then restore.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(pageCache, 0, 0)
  ctx.restore()
}

/** Drop the cached page — call on a hard scene change if options differ. */
export const invalidatePaper = (): void => {
  pageCache = null
  pageKey = ''
}

const bakePage = (
  ink: InkRenderer, wPx: number, hPx: number, opts: PaperOpts
): HTMLCanvasElement => {
  const c = document.createElement('canvas')
  c.width = wPx
  c.height = hPx
  const g = c.getContext('2d')
  if (!g) return c

  const pw = ink.pw
  const ph = ink.ph
  g.scale(ink.scale, ink.scale)

  // 1. Base paper.
  g.fillStyle = NOTEBOOK.paper
  g.fillRect(0, 0, pw, ph)

  // 2. A soft vignette — the flashlight beam falls off toward the page edges.
  //    This is what keeps the paper feeling LIT rather than emissive, and ties
  //    the notebook back to the desk it's sitting on.
  const vg = g.createRadialGradient(pw * 0.5, ph * 0.44, ph * 0.1, pw * 0.5, ph * 0.5, ph * 0.85)
  vg.addColorStop(0, 'rgba(255,250,235,0)')
  vg.addColorStop(0.62, 'rgba(120,100,70,0.06)')
  vg.addColorStop(1, 'rgba(60,45,30,0.24)')
  g.fillStyle = vg
  g.fillRect(0, 0, pw, ph)

  // 3. Ruled lines + margin. Drawn with a throwaway InkRenderer bound to the
  //    bake context so the rules get the same hand-drawn wobble as everything
  //    else — printed rules would be the one perfectly straight thing on the
  //    page and would look wrong.
  const bakeInk = makeBakeInk(g, ink)
  if (!opts.blank) {
    const gap = opts.ruleGap ?? 58
    const marginX = opts.marginX ?? 86
    let i = 0
    for (let y = gap * 1.6; y < ph - gap * 0.4; y += gap) {
      bakeInk.line(`rule${i++}`, 12, y, pw - 12, y, {
        color: NOTEBOOK.ruleBlue,
        width: 1.5,
        rough: 0.9,
        passes: 1,
        alpha: 0.85
      })
    }
    bakeInk.line('margin', marginX, 0, marginX, ph, {
      color: NOTEBOOK.marginRed,
      width: 1.8,
      rough: 1.1,
      passes: 1,
      alpha: 0.7
    })
  }

  // 4. Grain.
  const tile = warmGrainTile()
  if (!grainPattern) grainPattern = g.createPattern(tile, 'repeat')
  if (grainPattern) {
    g.save()
    g.globalAlpha = 0.5
    g.fillStyle = grainPattern
    g.fillRect(0, 0, pw, ph)
    g.restore()
  }

  // 5. Spiral binding.
  if (opts.spiral) drawSpiral(bakeInk, ph)

  return c
}

/** A second InkRenderer pointed at the bake canvas. Shares the live
 *  renderer's page metrics but pins `boil` to 0 — the page is baked once, so
 *  it must not wobble (only the drawings on top of it do). */
const makeBakeInk = (g: CanvasRenderingContext2D, src: InkRenderer): InkRenderer => {
  const bake = new InkRenderer(g)
  bake.ph = src.ph
  bake.scale = src.scale
  bake.boil = 0
  bake.roughMul = 1
  return bake
}

const drawSpiral = (ink: InkRenderer, ph: number): void => {
  const x = 30
  const count = Math.max(6, Math.round(ph / 78))
  const gap = ph / count
  for (let i = 0; i < count; i++) {
    const y = gap * (i + 0.5)
    const rng = makeRng(`spiral${i}`, 0)
    const r = 15 * range(rng, 0.9, 1.1)
    // Punch hole.
    ink.fillCircle(x + 6, y, r * 0.42, NOTEBOOK.paperShade, 0.9)
    // Wire loop over the edge.
    const pts: Pt[] = []
    for (let s = 0; s <= 10; s++) {
      const a = Math.PI * 0.85 + (s / 10) * Math.PI * 1.3
      pts.push({ x: x + 6 + Math.cos(a) * r * 1.5, y: y + Math.sin(a) * r * 0.8 })
    }
    ink.stroke(`wire${i}`, pts, {
      color: NOTEBOOK.pencil, width: 4.5, rough: 0.7, passes: 1, alpha: 0.85
    })
  }
}
