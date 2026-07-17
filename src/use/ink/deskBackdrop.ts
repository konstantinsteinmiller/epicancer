// ─── The desk backdrop ─────────────────────────────────────────────────────
//
// On a wide viewport the notebook is letterboxed to portrait (see
// `useInkCanvas.MAX_PAGE_ASPECT`), leaving dark "desk" to either side. Rather
// than flat black, we fill it with the bored teen's world: a seamless,
// slowly-drifting field of FAINT hand-drawn doodles — the game's own motifs
// (moon, lightning, a tiny router, a mosquito, Wi-Fi-with-a-slash, "9000!",
// coffee rings, "Zzz"…) scribbled on a dark desk.
//
// The whole thing is generated ONCE into an offscreen tile and handed to CSS as
// a repeating background-image; a slow `transform` drift + a corner vignette
// give it life without ever competing with the bright page. It reuses the ink
// engine so the doodles have the same authentic ballpoint wobble as everything
// else — they're just drawn ghost-faint.
//
// The SAME tile also fills the FLogoProgress preloader backdrop, so the world
// the player lands in is already on screen before the game mounts.
//
// Zero shipped assets: the tile is a runtime `toDataURL`, in keeping with the
// project's "everything is generated" rule.

import { InkRenderer, type Pt } from './inkRenderer'
import { mulberry32, range, pick } from './rng'
import { inkText } from './strokeFont'

/** Tile edge, px. Big enough that the repeat isn't obvious across a ~420px
 *  letterbox bar, small enough to bake fast. */
const TILE = 640

/** Faint ghost-ink for the doodles — a cool off-white that reads as faded
 *  pencil on the dark desk without ever shouting. */
const DOODLE = '#b6aec6'
const DESK = '#111019'
const GRAIN = '#1b1826'

let cached: string | null = null

/**
 * Build (once) the seamless doodle-desk tile and return it as a PNG data URI
 * for use as a CSS `background-image`. Cached — repeat calls are free.
 */
export const generateDeskTile = (): string => {
  if (cached) return cached
  if (typeof document === 'undefined') return ''
  const c = document.createElement('canvas')
  c.width = TILE
  c.height = TILE
  const g = c.getContext('2d')
  if (!g) return ''

  // Dark desk base — a flat tone (seamless by definition) with a faint radial
  // warmth so the surface doesn't read as dead-flat.
  g.fillStyle = DESK
  g.fillRect(0, 0, TILE, TILE)

  const ink = new InkRenderer(g)
  ink.scale = 1
  ink.ph = TILE
  ink.boil = 0

  // Wood grain: long faint near-horizontal strokes, wrapped so they tile.
  const grainRng = mulberry32(0x5eed)
  for (let i = 0; i < 7; i++) {
    const y = range(grainRng, 0, TILE)
    for (let w = -1; w <= 1; w++) {
      ink.stroke(`grain${i}_${w}`, [
        { x: -20, y: y + w * TILE },
        { x: TILE * 0.5, y: y + w * TILE + range(grainRng, -8, 8) },
        { x: TILE + 20, y: y + w * TILE + range(grainRng, -14, 14) }
      ], { color: GRAIN, width: range(grainRng, 2, 5), passes: 1, alpha: 0.5, rough: 4 })
    }
  }

  // Scatter the doodles. Each is drawn at its home position AND at the eight
  // wrapped neighbours (±TILE), so anything crossing an edge continues on the
  // opposite side — a genuinely seamless repeat with no visible grid seams.
  const names = Object.keys(DOODLES)
  const rng = mulberry32(0x30d1e)
  const placed: Pt[] = []
  let attempts = 0
  const want = 15
  while (placed.length < want && attempts < 200) {
    attempts++
    const x = range(rng, 40, TILE - 40)
    const y = range(rng, 40, TILE - 40)
    // Keep them from crowding, so each doodle reads on its own.
    if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < 120)) continue
    placed.push({ x, y })
    const idx = placed.length
    const name = pick(rng, names)
    const size = range(rng, 30, 52)
    const rot = range(rng, -0.5, 0.5)
    const alpha = range(rng, 0.12, 0.22)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        ink.transformed(x + dx * TILE, y + dy * TILE, rot, 1, () => {
          DOODLES[name]!(ink, `d${idx}_${dx}_${dy}`, size, alpha, rng)
        })
      }
    }
  }

  cached = c.toDataURL('image/png')
  return cached
}

// ── The doodle vocabulary ──────────────────────────────────────────────────
// Each draws centred on the origin; `r` is its nominal radius. `transformed()`
// at the call site handles placement, rotation and wrapping.

type Doodle = (ink: InkRenderer, id: string, r: number, alpha: number, rng: () => number) => void

const line = (a: number, w = 2.6) => ({ color: DOODLE, width: w, passes: 1, alpha: a, rough: 1.4 } as const)

const DOODLES: Record<string, Doodle> = {
  // A crescent moon.
  moon: (ink, id, r, a) => {
    const pts: Pt[] = []
    for (let i = 0; i <= 16; i++) {
      const t = -Math.PI * 0.6 + (i / 16) * Math.PI * 1.2
      pts.push({ x: Math.cos(t) * r, y: Math.sin(t) * r })
    }
    for (let i = 16; i >= 0; i--) {
      const t = -Math.PI * 0.6 + (i / 16) * Math.PI * 1.2
      pts.push({ x: Math.cos(t) * r * 0.62 + r * 0.3, y: Math.sin(t) * r * 0.9 })
    }
    ink.stroke(`${id}moon`, pts, { ...line(a), close: true })
  },
  // A five-point star.
  star: (ink, id, r, a) => {
    const pts: Pt[] = []
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.42
      const t = -Math.PI / 2 + (i / 10) * Math.PI * 2
      pts.push({ x: Math.cos(t) * rad, y: Math.sin(t) * rad })
    }
    ink.stroke(`${id}star`, pts, { ...line(a), close: true })
  },
  // A four-point sparkle.
  sparkle: (ink, id, r, a) => {
    ink.stroke(`${id}sp1`, [{ x: -r, y: 0 }, { x: r, y: 0 }], line(a, 3))
    ink.stroke(`${id}sp2`, [{ x: 0, y: -r }, { x: 0, y: r }], line(a, 3))
    ink.stroke(`${id}sp3`, [{ x: -r * 0.4, y: -r * 0.4 }, { x: r * 0.4, y: r * 0.4 }], line(a * 0.7, 2))
    ink.stroke(`${id}sp4`, [{ x: r * 0.4, y: -r * 0.4 }, { x: -r * 0.4, y: r * 0.4 }], line(a * 0.7, 2))
  },
  // A tightening spiral.
  spiral: (ink, id, r, a) => {
    const pts: Pt[] = []
    for (let i = 0; i <= 40; i++) {
      const t = (i / 40) * Math.PI * 4
      const rad = (i / 40) * r
      pts.push({ x: Math.cos(t) * rad, y: Math.sin(t) * rad })
    }
    ink.stroke(`${id}spiral`, pts, line(a))
  },
  // A lightning bolt.
  bolt: (ink, id, r, a) => {
    ink.stroke(`${id}bolt`, [
      { x: r * 0.2, y: -r }, { x: -r * 0.3, y: 0 }, { x: r * 0.15, y: 0 },
      { x: -r * 0.2, y: r }
    ], line(a, 3))
  },
  // Wi-Fi arcs with a defiant slash — the game's whole premise.
  wifi: (ink, id, r, a) => {
    for (let k = 1; k <= 3; k++) {
      const pts: Pt[] = []
      for (let i = 0; i <= 10; i++) {
        const t = -Math.PI * 0.75 + (i / 10) * Math.PI * 0.5
        pts.push({ x: Math.cos(t) * r * (k / 3), y: r * 0.5 + Math.sin(t) * r * (k / 3) })
      }
      ink.stroke(`${id}wifi${k}`, pts, line(a * 0.9, 2.4))
    }
    ink.fillCircle(0, r * 0.5, r * 0.1, DOODLE, a)
    ink.stroke(`${id}wifislash`, [{ x: -r * 0.9, y: -r * 0.9 }, { x: r * 0.9, y: r * 0.9 }], line(a, 3))
  },
  // Rabbit-ear TV antenna.
  antenna: (ink, id, r, a) => {
    ink.stroke(`${id}ant1`, [{ x: 0, y: r * 0.3 }, { x: -r * 0.8, y: -r }], line(a, 2.6))
    ink.stroke(`${id}ant2`, [{ x: 0, y: r * 0.3 }, { x: r * 0.8, y: -r }], line(a, 2.6))
    ink.rect(`${id}antbase`, -r * 0.3, r * 0.3, r * 0.6, r * 0.4, line(a, 2.4))
  },
  // A tiny mosquito.
  mosquito: (ink, id, r, a) => {
    ink.ellipse(`${id}mbody`, 0, 0, r * 0.5, r * 0.28, 0.3, line(a, 2.4))
    ink.ellipse(`${id}mw1`, -r * 0.3, -r * 0.4, r * 0.4, r * 0.16, -0.5, line(a * 0.7, 1.8))
    ink.ellipse(`${id}mw2`, r * 0.3, -r * 0.4, r * 0.4, r * 0.16, 0.5, line(a * 0.7, 1.8))
    for (let i = 0; i < 3; i++) {
      ink.stroke(`${id}mleg${i}`, [
        { x: (i - 1) * r * 0.25, y: r * 0.1 }, { x: (i - 1) * r * 0.35, y: r * 0.6 }
      ], line(a * 0.7, 1.6))
    }
  },
  // A coffee-cup ring stain.
  ring: (ink, id, r, a) => {
    ink.circle(`${id}ring`, 0, 0, r, line(a * 0.8, 3.5))
  },
  // A paper plane.
  plane: (ink, id, r, a) => {
    ink.shape(`${id}plane`, [
      { x: -r, y: r * 0.4 }, { x: r, y: -r * 0.5 }, { x: -r * 0.2, y: r * 0.1 }
    ], line(a, 2.4))
    ink.stroke(`${id}planef`, [{ x: -r * 0.2, y: r * 0.1 }, { x: -r * 0.5, y: r * 0.6 }], line(a, 2))
  },
  // A little flame.
  flame: (ink, id, r, a) => {
    ink.stroke(`${id}flame`, [
      { x: -r * 0.5, y: r }, { x: -r * 0.4, y: 0 }, { x: 0, y: -r },
      { x: r * 0.4, y: 0 }, { x: r * 0.5, y: r }
    ], { ...line(a, 2.6), close: true })
  },
  // A storm cloud with rain.
  cloud: (ink, id, r, a) => {
    ink.stroke(`${id}cloud`, [
      { x: -r, y: 0 }, { x: -r * 0.5, y: -r * 0.6 }, { x: r * 0.2, y: -r * 0.7 },
      { x: r, y: -r * 0.2 }, { x: r * 0.9, y: r * 0.2 }, { x: -r, y: r * 0.2 }
    ], { ...line(a, 2.4), close: true })
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * r * 0.5
      ink.stroke(`${id}rain${i}`, [{ x, y: r * 0.4 }, { x: x - r * 0.15, y: r }], line(a * 0.8, 2))
    }
  },
  // A curly arrow.
  arrow: (ink, id, r, a) => {
    ink.stroke(`${id}arrow`, [
      { x: -r, y: r * 0.3 }, { x: -r * 0.2, y: -r * 0.4 }, { x: r * 0.6, y: 0 }
    ], line(a, 2.6))
    ink.stroke(`${id}arrowh1`, [{ x: r * 0.6, y: 0 }, { x: r * 0.2, y: -r * 0.2 }], line(a, 2.6))
    ink.stroke(`${id}arrowh2`, [{ x: r * 0.6, y: 0 }, { x: r * 0.3, y: r * 0.3 }], line(a, 2.6))
  },
  // A doodled heart.
  heart: (ink, id, r, a) => {
    const pts: Pt[] = []
    for (let i = 0; i <= 16; i++) {
      const t = (i / 16) * Math.PI * 2
      const x = 16 * Math.pow(Math.sin(t), 3)
      const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
      pts.push({ x: (x / 16) * r, y: (y / 16) * r })
    }
    ink.stroke(`${id}heart`, pts, { ...line(a), close: true })
  },
  // Scribbled "Zzz".
  zzz: (ink, id, r, a) => {
    inkText(ink, `${id}zzz`, 'Zzz', 0, 0, r * 1.1, {
      align: 'center', baseline: 'middle', color: DOODLE, width: r * 0.09, alpha: a, tilt: 0.1
    })
  },
  // The number.
  over: (ink, id, r, a) => {
    inkText(ink, `${id}over`, '9000!', 0, 0, r * 0.9, {
      align: 'center', baseline: 'middle', color: DOODLE, width: r * 0.08, alpha: a, tilt: 0.08
    })
  },
  // 3AM.
  threeam: (ink, id, r, a) => {
    inkText(ink, `${id}3am`, '3AM', 0, 0, r * 0.95, {
      align: 'center', baseline: 'middle', color: DOODLE, width: r * 0.08, alpha: a, tilt: 0.06
    })
  }
}
