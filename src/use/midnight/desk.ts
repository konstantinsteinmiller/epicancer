// ─── The reality frame ─────────────────────────────────────────────────────
//
// The other half of the GDD's "high-contrast loop" (§1.2): a moody, atmospheric
// desk that the frantic notebook world is nested inside. Vision-board panels 1,
// 2 and 8.
//
// This is the ONE place in the game that isn't ballpoint on paper. It's painted
// — soft gradients, an amber flashlight cone, rain on glass — precisely so that
// diving into the notebook feels like falling into a different medium. If the
// desk were drawn in the same jittery pen as the micro-games, the contrast the
// whole design rests on would collapse.
//
// `warmth` (0..1) runs the night→morning transition: 0 is 3AM midnight blue,
// 1 is the sunrise that ends a cleared night. Every colour here lerps across
// it, so panel 1 and panel 8 are the same function with a different argument.

import type { InkRenderer, Pt } from '@/use/ink/inkRenderer'
import { REALITY, MORNING, NOTEBOOK } from '@/use/ink/palette'
import { makeRng, range, mulberry32 } from '@/use/ink/rng'
import { inkText, measureInkText } from '@/use/ink/strokeFont'

// ── Colour helpers ────────────────────────────────────────────────────────

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16)
  ]
}

/** Blend two hex colours. The night→morning warmth runs through this. */
export const mix = (a: string, b: string, t: number): string => {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const f = Math.max(0, Math.min(1, t))
  return `rgb(${Math.round(r1 + (r2 - r1) * f)},${Math.round(g1 + (g2 - g1) * f)},${Math.round(b1 + (b2 - b1) * f)})`
}

export interface DeskOpts {
  /** 0 = 3AM midnight, 1 = sunrise. */
  warmth?: number
  /** 0..1 — how much of the notebook page is showing. Drives the zoom-in. */
  zoom?: number
  /** The phone shows a signal instead of "searching". */
  connected?: boolean
}

// The rain is a persistent particle field rather than per-frame randomness:
// randomly-placed streaks at 12fps read as noise, whereas streaks that FALL
// read as rain. Module-level so it survives across draws.
interface Drop { x: number; y: number; len: number; sp: number }
let drops: Drop[] | null = null

const ensureDrops = (ink: InkRenderer): Drop[] => {
  if (drops) return drops
  const rng = mulberry32(0x5eed)
  drops = []
  for (let i = 0; i < 46; i++) {
    drops.push({
      x: range(rng, 0, 1),
      y: range(rng, 0, 1),
      len: range(rng, 0.02, 0.09),
      sp: range(rng, 0.18, 0.5)
    })
  }
  return drops
}

/** Advance the rain. Called from the scene's sim tick, not from draw — draw
 *  runs at 12fps and must stay a pure function of state. */
export const stepRain = (dt: number): void => {
  if (!drops) return
  for (const d of drops) {
    d.y += d.sp * dt
    if (d.y > 1.1) {
      d.y = -0.1
    }
  }
}

/**
 * The desk at 3AM. Drawn in page units like everything else.
 *
 * Layout is anchored to the page centre and scaled off `ink.u()`, so the same
 * composition works in portrait and landscape — the notebook just gets more or
 * less room around it.
 */
export const drawDesk = (ink: InkRenderer, opts: DeskOpts = {}): void => {
  const warmth = opts.warmth ?? 0
  const { ctx } = ink

  // ── The room ──
  // A vertical gradient: the window wall behind, the desk surface in front.
  const roomTop = mix(REALITY.roomDark, MORNING.roomWarm, warmth)
  const roomMid = mix(REALITY.deskShadow, '#6a5570', warmth)
  const g = ctx.createLinearGradient(0, 0, 0, ink.ph)
  g.addColorStop(0, roomTop)
  g.addColorStop(0.42, roomMid)
  g.addColorStop(1, mix(REALITY.deskShadow, '#7a5a48', warmth))
  ctx.save()
  ctx.fillStyle = g
  ctx.fillRect(0, 0, ink.pw, ink.ph)
  ctx.restore()

  drawWindow(ink, warmth)
  drawDeskSurface(ink, warmth)
  drawFlashlightCone(ink, warmth)
  drawProps(ink, warmth, opts.connected ?? false)
}

/** The rain-streaked windowpane behind the desk (vision-board panel 1). */
const drawWindow = (ink: InkRenderer, warmth: number): void => {
  const { ctx } = ink
  const w = ink.pw * 0.62
  const h = ink.ph * 0.24
  const x = ink.cx - w / 2
  const y = ink.ph * 0.05

  // The glass. At dawn it fills with sunrise instead of night.
  const g = ctx.createLinearGradient(0, y, 0, y + h)
  g.addColorStop(0, mix(REALITY.windowGlass, MORNING.skyHigh, warmth))
  g.addColorStop(1, mix('#141c30', MORNING.skyLow, warmth))
  ctx.save()
  ctx.fillStyle = g
  ctx.fillRect(x, y, w, h)
  ctx.restore()

  // The sun creeping up at dawn — "the sun is just starting to peek through"
  // (vision-board panel 8).
  if (warmth > 0.15) {
    const sy = y + h * (1.05 - warmth * 0.45)
    ink.fillCircle(x + w * 0.7, sy, ink.u(46), MORNING.sunCore, (warmth - 0.15) * 1.1)
  }

  // Rain streaks on the glass.
  const list = ensureDrops(ink)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  for (let i = 0; i < list.length; i++) {
    const d = list[i]!
    const dx = x + d.x * w
    const dy = y + d.y * h
    ink.stroke(`rain${i}`, [
      { x: dx, y: dy },
      { x: dx - ink.u(3), y: dy + d.len * h }
    ], {
      color: '#cfe6ff',
      width: ink.u(2),
      passes: 1,
      alpha: 0.3 - warmth * 0.12,
      rough: 1
    })
  }
  ctx.restore()

  // Frame + mullions.
  ctx.save()
  ctx.strokeStyle = mix('#0a0d1c', '#3a2a35', warmth)
  ctx.lineWidth = ink.u(9)
  ctx.strokeRect(x, y, w, h)
  ctx.beginPath()
  ctx.moveTo(x + w / 2, y)
  ctx.lineTo(x + w / 2, y + h)
  ctx.moveTo(x, y + h / 2)
  ctx.lineTo(x + w, y + h / 2)
  ctx.stroke()
  ctx.restore()
}

const drawDeskSurface = (ink: InkRenderer, warmth: number): void => {
  const { ctx } = ink
  const y = ink.ph * 0.3
  const g = ctx.createLinearGradient(0, y, 0, ink.ph)
  g.addColorStop(0, mix(REALITY.deskWood, '#7a5340', warmth))
  g.addColorStop(1, mix('#2a1f18', '#4a3328', warmth))
  ctx.save()
  ctx.fillStyle = g
  ctx.fillRect(0, y, ink.pw, ink.ph - y)
  ctx.restore()

  // Wood grain — long, near-horizontal strokes.
  const rng = makeRng('grain', 0)
  for (let i = 0; i < 14; i++) {
    const gy = y + range(rng, 0, 1) * (ink.ph - y)
    ink.stroke(`grain${i}`, [
      { x: 0, y: gy },
      { x: ink.pw * 0.5, y: gy + range(rng, -6, 6) },
      { x: ink.pw, y: gy + range(rng, -10, 10) }
    ], {
      color: mix('#1a120c', '#3a2418', warmth),
      width: ink.u(range(rng, 1.5, 4)),
      passes: 1,
      alpha: 0.35,
      rough: 3
    })
  }
}

/**
 * The flashlight beam — "the sole light source is a stark, cone-shaped warm
 * amber beam" (GDD §2.1). A radial gradient in 'screen' blend so it ADDS light
 * rather than painting a yellow disc over the scene.
 */
const drawFlashlightCone = (ink: InkRenderer, warmth: number): void => {
  const { ctx } = ink
  const cx = ink.cx
  const cy = ink.ph * 0.6
  const r = Math.max(ink.pw, ink.ph) * 0.5

  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  const g = ctx.createRadialGradient(cx, cy, ink.u(20), cx, cy, r)
  const core = mix(REALITY.beamCore, MORNING.sunCore, warmth)
  g.addColorStop(0, core)
  g.addColorStop(0.35, mix(REALITY.beamEdge, '#e8b98a', warmth))
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.globalAlpha = 0.55 - warmth * 0.2
  ctx.fillStyle = g
  ctx.fillRect(0, 0, ink.pw, ink.ph)
  ctx.restore()
}

/** The clutter: torch, phone, mug, chips, paper balls, pencil. */
const drawProps = (ink: InkRenderer, warmth: number, connected: boolean): void => {
  const { ctx } = ink

  // ── The brass flashlight, upper-left, casting the beam. ──
  const fx = ink.pw * 0.2
  const fy = ink.ph * 0.36
  ctx.save()
  ctx.translate(fx, fy)
  ctx.rotate(0.45)
  const bg = ctx.createLinearGradient(0, -ink.u(18), 0, ink.u(18))
  bg.addColorStop(0, '#8a6a10')
  bg.addColorStop(0.5, mix(REALITY.brass, '#f0d060', 0.4))
  bg.addColorStop(1, '#6a4a08')
  ctx.fillStyle = bg
  ctx.fillRect(-ink.u(75), -ink.u(17), ink.u(150), ink.u(34))
  // Head.
  ctx.fillStyle = mix('#d8b437', '#f5d97a', 0.3)
  ctx.fillRect(ink.u(66), -ink.u(24), ink.u(28), ink.u(48))
  ctx.restore()

  // ── The phone — the "waiting for Wi-Fi" half of the theme. ──
  const px = ink.pw * 0.79
  const py = ink.ph * 0.52
  const pw = ink.u(120)
  const ph2 = ink.u(215)
  ctx.save()
  ctx.translate(px, py)
  ctx.rotate(-0.22)
  // Body.
  ctx.fillStyle = '#0a0a10'
  roundRectPath(ctx, -pw / 2, -ph2 / 2, pw, ph2, ink.u(14))
  ctx.fill()
  // Screen — cold blue at night, bright when the signal returns.
  ctx.fillStyle = connected ? '#2a5fa8' : REALITY.phoneGlow
  roundRectPath(ctx, -pw / 2 + ink.u(7), -ph2 / 2 + ink.u(10), pw - ink.u(14), ph2 - ink.u(20), ink.u(9))
  ctx.fill()
  ctx.restore()

  // The phone's glow spills onto the desk — the only cold light in frame.
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  const pg = ctx.createRadialGradient(px, py, ink.u(10), px, py, ink.u(190))
  pg.addColorStop(0, connected ? '#6aa8ff' : '#2a4a7a')
  pg.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.globalAlpha = connected ? 0.5 : 0.32
  ctx.fillStyle = pg
  ctx.fillRect(0, 0, ink.pw, ink.ph)
  ctx.restore()

  // The wifi glyph / spinner on the screen.
  drawPhoneIcon(ink, px, py, connected)

  // ── The mug of cocoa, right of the notebook. ──
  const mx = ink.pw * 0.84
  const my = ink.ph * 0.29
  ctx.save()
  ctx.fillStyle = mix('#c8c4bc', '#e0d8cc', warmth)
  roundRectPath(ctx, mx - ink.u(46), my - ink.u(38), ink.u(92), ink.u(80), ink.u(10))
  ctx.fill()
  // Handle.
  ctx.strokeStyle = mix('#c8c4bc', '#e0d8cc', warmth)
  ctx.lineWidth = ink.u(11)
  ctx.beginPath()
  ctx.arc(mx + ink.u(52), my, ink.u(20), -1.2, 1.2)
  ctx.stroke()
  // Cocoa.
  ctx.fillStyle = '#4a2a18'
  ctx.beginPath()
  ctx.ellipse(mx, my - ink.u(34), ink.u(40), ink.u(11), 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  // Steam.
  const rng = makeRng('steam', ink.boil)
  for (let i = 0; i < 3; i++) {
    const sx = mx - ink.u(16) + i * ink.u(16)
    ink.stroke(`steam${i}`, [
      { x: sx, y: my - ink.u(44) },
      { x: sx + range(rng, -10, 10), y: my - ink.u(72) },
      { x: sx + range(rng, -14, 14), y: my - ink.u(100) }
    ], { color: '#ffffff', width: ink.u(3), passes: 1, alpha: 0.18, rough: 4 })
  }

  // ── Crumpled paper balls + a bag of chips (vision-board panel 1). ──
  const ballRng = makeRng('balls', 0)
  for (let i = 0; i < 2; i++) {
    const bx = ink.pw * (0.12 + i * 0.1)
    const by = ink.ph * (0.72 + i * 0.11)
    const pts: Pt[] = []
    for (let s = 0; s < 9; s++) {
      const a = (s / 9) * Math.PI * 2
      const rr = ink.u(34) * range(ballRng, 0.7, 1.15)
      pts.push({ x: bx + Math.cos(a) * rr, y: by + Math.sin(a) * rr })
    }
    ink.fill(pts, mix('#b8b0a0', '#ded4c0', warmth), 0.95)
    ink.shape(`ball${i}`, pts, { color: '#6a6255', width: ink.u(2.4), passes: 1 })
  }

  // Chips bag.
  ctx.save()
  ctx.translate(ink.pw * 0.1, ink.ph * 0.46)
  ctx.rotate(-0.3)
  ctx.fillStyle = mix('#8a2a3a', '#b04a52', warmth)
  roundRectPath(ctx, -ink.u(60), -ink.u(40), ink.u(120), ink.u(80), ink.u(8))
  ctx.fill()
  ctx.restore()

  // Pencil.
  ctx.save()
  ctx.translate(ink.pw * 0.66, ink.ph * 0.88)
  ctx.rotate(0.12)
  ctx.fillStyle = '#d8a83a'
  ctx.fillRect(-ink.u(90), -ink.u(6), ink.u(180), ink.u(12))
  ctx.fillStyle = '#3a2a20'
  ctx.fillRect(ink.u(90), -ink.u(6), ink.u(16), ink.u(12))
  ctx.restore()
}

const drawPhoneIcon = (ink: InkRenderer, x: number, y: number, connected: boolean): void => {
  const { ctx, t } = ink
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(-0.22)
  if (connected) {
    // Full bars + a flurry of notifications (vision-board panel 8).
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < 4; i++) {
      const h = ink.u(10 + i * 9)
      ctx.fillRect(-ink.u(38) + i * ink.u(20), -ink.u(20) - h, ink.u(12), h)
    }
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.9
      ctx.fillStyle = '#ffffff'
      roundRectPath(ctx, -ink.u(42), ink.u(6) + i * ink.u(26), ink.u(84), ink.u(18), ink.u(5))
      ctx.fill()
    }
  } else {
    // A searching spinner — the "waiting for Wi-Fi" theme, literally spinning.
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = ink.u(7)
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    ctx.arc(0, 0, ink.u(28), t * 3, t * 3 + Math.PI * 1.3)
    ctx.stroke()
    // A struck-through wifi arc.
    ctx.globalAlpha = 0.5
    ctx.beginPath()
    ctx.moveTo(-ink.u(30), ink.u(44))
    ctx.lineTo(ink.u(30), ink.u(74))
    ctx.stroke()
  }
  ctx.restore()
}

const roundRectPath = (
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number
): void => {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * The open notebook lying on the desk, with the title scribbled on it
 * (vision-board panels 1-2). `zoom` 0..1 grows the page toward filling the
 * screen — the camera push that becomes the dive.
 */
export const drawDeskNotebook = (
  ink: InkRenderer, zoom: number, title: string, prompt: string | null, promptPulse: number
): void => {
  const { ctx } = ink
  // At zoom 0 the notebook is an object on the desk; at 1 it has swallowed the
  // viewport. Everything below is expressed as a fraction of that box, so the
  // push is a single lerp.
  const w = ink.pw * (0.52 + zoom * 0.9)
  const h = ink.ph * (0.42 + zoom * 0.9)
  const cx = ink.cx
  const cy = ink.ph * (0.62 - zoom * 0.12)
  const x = cx - w / 2
  const y = cy - h / 2

  ctx.save()
  // Page.
  ctx.fillStyle = NOTEBOOK.paper
  roundRectPath(ctx, x, y, w, h, ink.u(8))
  ctx.fill()
  ctx.restore()

  // Ruled lines.
  const rows = 9
  for (let i = 1; i < rows; i++) {
    const ly = y + (h / rows) * i
    ink.line(`dnrule${i}`, x + ink.u(10), ly, x + w - ink.u(10), ly, {
      color: NOTEBOOK.ruleBlue, width: ink.u(1.4), passes: 1, alpha: 0.7
    })
  }
  // Spiral down the left.
  const rings = 8
  for (let i = 0; i < rings; i++) {
    const ry = y + (h / rings) * (i + 0.5)
    ink.stroke(`dnring${i}`, [
      { x: x - ink.u(10), y: ry - ink.u(9) },
      { x: x + ink.u(18), y: ry },
      { x: x - ink.u(10), y: ry + ink.u(9) }
    ], { color: '#9a9aa2', width: ink.u(4), passes: 1 })
  }

  // The title, scribbled across the top of the page — stacked one word per
  // line, as in vision-board panel 2, and shrunk to fit. A localised title can
  // be any length, and a single line would run off the page (and off the
  // notebook) the moment it's longer than English's "MIDNIGHT ANALOG".
  const words = title.split(/\s+/).filter(Boolean)
  const maxW = w * 0.82
  let size = ink.u(58) * (1 + zoom * 0.5)
  for (const word of words) {
    const natural = measureInkText(word, size)
    if (natural > maxW) size *= maxW / natural
  }
  const lineH = size * 1.24
  const top = y + h * 0.28 - ((words.length - 1) * lineH) / 2
  for (let i = 0; i < words.length; i++) {
    inkText(ink, `dtitle${i}`, words[i]!, cx, top + i * lineH, size, {
      align: 'center',
      baseline: 'middle',
      color: NOTEBOOK.ink,
      width: size * 0.12,
      bleed: true,
      tilt: 0.07,
      scatter: 0.04
    })
  }

  if (prompt) {
    // The pulsing "press to start" prompt. Pulses in SIZE rather than opacity —
    // a fading scribble looks like a rendering bug; a breathing one looks like
    // someone's tapping the pen on it.
    const pulse = 1 + Math.sin(promptPulse * 3.2) * 0.06
    let pSize = ink.u(30)
    const pNat = measureInkText(prompt, pSize)
    if (pNat > maxW) pSize *= maxW / pNat
    inkText(ink, 'dprompt', prompt, cx, y + h * 0.64, pSize * pulse, {
      align: 'center',
      baseline: 'middle',
      color: NOTEBOOK.inkSoft,
      width: ink.u(3.4),
      tilt: 0.04
    })
  }

  // The flashlight's pool on the page — the notebook is LIT, not glowing.
  ctx.save()
  ctx.globalCompositeOperation = 'multiply'
  const vg = ctx.createRadialGradient(cx, cy, ink.u(40), cx, cy, Math.max(w, h) * 0.75)
  vg.addColorStop(0, 'rgba(255,255,255,1)')
  vg.addColorStop(1, 'rgba(120,90,60,0.55)')
  ctx.fillStyle = vg
  roundRectPath(ctx, x, y, w, h, ink.u(8))
  ctx.fill()
  ctx.restore()
}

/**
 * The dive (vision-board panel 2): "the camera smoothly zooms directly into the
 * texture of the notebook page until the wooden desk disappears", and the
 * avatar drops onto the page in a splash of ink.
 *
 * `p` is 0..1. Drawn OVER whatever the scene rendered underneath, so the
 * vortex eats the desk.
 */
export const drawDive = (ink: InkRenderer, p: number): void => {
  const { ctx } = ink
  const t = Math.max(0, Math.min(1, p))
  const cx = ink.cx
  const cy = ink.ph * 0.55

  // The ink vortex swallowing the page — swirling arms that spin and grow.
  const arms = 7
  const spin = t * 7
  for (let i = 0; i < arms; i++) {
    const base = (i / arms) * Math.PI * 2 + spin
    const pts: Pt[] = []
    for (let s = 0; s <= 14; s++) {
      const f = s / 14
      // A logarithmic spiral: the arm tightens toward the eye.
      const a = base + f * 3.2
      const r = ink.u(30) + f * Math.max(ink.pw, ink.ph) * 0.75 * (0.25 + t)
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.9 })
    }
    ink.stroke(`vortex${i}`, pts, {
      color: i % 2 === 0 ? '#1a3a7a' : '#2a5aa8',
      width: ink.u(26) * (0.5 + t),
      passes: 1,
      alpha: 0.85,
      rough: 6
    })
  }

  // The eye of the vortex floods the screen at the end, covering the cut to
  // the notebook.
  if (t > 0.55) {
    const f = (t - 0.55) / 0.45
    ctx.save()
    ctx.globalAlpha = f
    ctx.fillStyle = NOTEBOOK.paper
    ctx.fillRect(0, 0, ink.pw, ink.ph)
    ctx.restore()
  }

  // The avatar falling in, spinning (panel 2's tired kid tumbling into the ink).
  if (t < 0.7) {
    const fall = t / 0.7
    const ay = -ink.u(80) + fall * (cy + ink.u(80))
    const scale = 1 - fall * 0.45
    ctx.save()
    ctx.translate(cx, ay)
    ctx.rotate(fall * 3.4)
    ctx.scale(scale, scale)
    drawFallingKid(ink)
    ctx.restore()
  }

  // Ink splatters flying off (panel 2: "ink splatters fly off them like dust").
  if (t > 0.55 && t < 0.95) {
    const f = (t - 0.55) / 0.4
    const rng = makeRng('divesplat', ink.boil)
    for (let i = 0; i < 10; i++) {
      const a = range(rng, 0, Math.PI * 2)
      const d = f * ink.u(range(rng, 120, 420))
      ink.fillCircle(cx + Math.cos(a) * d, cy + Math.sin(a) * d,
        ink.u(range(rng, 4, 14)) * (1 - f), '#1a3a7a', 1 - f)
    }
  }
}

const drawFallingKid = (ink: InkRenderer): void => {
  const s = ink.u(1)
  const line = { color: NOTEBOOK.ink, width: ink.u(4), passes: 2 } as const
  ink.circle('fk-head', 0, -40 * s, 22 * s, line)
  ink.stroke('fk-body', [{ x: 0, y: -18 * s }, { x: 0, y: 34 * s }], line)
  ink.stroke('fk-arm1', [{ x: 0, y: -6 * s }, { x: -38 * s, y: -28 * s }], line)
  ink.stroke('fk-arm2', [{ x: 0, y: -6 * s }, { x: 40 * s, y: -14 * s }], line)
  ink.stroke('fk-leg1', [{ x: 0, y: 34 * s }, { x: -26 * s, y: 70 * s }], line)
  ink.stroke('fk-leg2', [{ x: 0, y: 34 * s }, { x: 30 * s, y: 66 * s }], line)
  // Wide, alarmed eyes.
  for (let i = 0; i < 2; i++) {
    const ex = (i === 0 ? -8 : 8) * s
    ink.circle(`fk-eye${i}`, ex, -44 * s, 5 * s, { color: NOTEBOOK.ink, width: ink.u(2), passes: 1 })
  }
  ink.circle('fk-mouth', 0, -30 * s, 5 * s, { color: NOTEBOOK.ink, width: ink.u(2), passes: 1 })
}

export interface SummaryData {
  score: number
  best: number
  isNewBest: boolean
  ideasTotal: number
  survived: boolean
}

/**
 * The summary page (vision-board panel 8): "a summary screen hand-drawn on the
 * final page shows your high score, how many 3 AM ideas you successfully
 * brought to life, and a prompt to Sleep or Stay Up Another Night".
 */
export const drawSummary = (
  ink: InkRenderer,
  data: SummaryData,
  labels: {
    title: string
    ideas: string
    best: string
    newBest: string
    again: string
  },
  pulse: number
): void => {
  const { ctx } = ink
  const w = Math.min(ink.pw * 0.86, ink.u(760))
  const h = Math.min(ink.ph * 0.7, ink.u(880))
  const x = ink.cx - w / 2
  const y = ink.ph * 0.5 - h / 2

  // The page.
  ctx.save()
  ctx.fillStyle = NOTEBOOK.paper
  roundRectPath(ctx, x, y, w, h, ink.u(10))
  ctx.fill()
  ctx.restore()

  for (let i = 1; i < 10; i++) {
    const ly = y + (h / 10) * i
    ink.line(`srule${i}`, x + ink.u(14), ly, x + w - ink.u(14), ly, {
      color: NOTEBOOK.ruleBlue, width: ink.u(1.4), passes: 1, alpha: 0.6
    })
  }

  inkText(ink, 'stitle', labels.title, ink.cx, y + h * 0.14, ink.u(52), {
    align: 'center', baseline: 'middle',
    color: data.survived ? NOTEBOOK.markerGreen : NOTEBOOK.markerRed,
    width: ink.u(7), bleed: true, tilt: 0.07
  })

  // The score, big.
  inkText(ink, 'sscore', String(data.score), ink.cx, y + h * 0.36, ink.u(120), {
    align: 'center', baseline: 'middle', color: NOTEBOOK.ink,
    width: ink.u(14), bleed: true, tilt: 0.05
  })
  inkText(ink, 'sideas', labels.ideas, ink.cx, y + h * 0.5, ink.u(26), {
    align: 'center', baseline: 'middle', color: NOTEBOOK.inkSoft, width: ink.u(3)
  })

  // Best, or the "new best" flourish.
  if (data.isNewBest) {
    inkText(ink, 'snew', labels.newBest, ink.cx, y + h * 0.62, ink.u(34), {
      align: 'center', baseline: 'middle', color: NOTEBOOK.markerRed,
      width: ink.u(4.5), rotate: -0.05, tilt: 0.1
    })
    ink.ellipse('snewring', ink.cx, y + h * 0.62, w * 0.34, ink.u(38), 0, {
      color: NOTEBOOK.markerRed, width: ink.u(4), passes: 2, rough: 4
    })
  } else {
    inkText(ink, 'sbest', `${labels.best} ${data.best}`, ink.cx, y + h * 0.62, ink.u(28), {
      align: 'center', baseline: 'middle', color: NOTEBOOK.inkSoft, width: ink.u(3.2)
    })
  }

  // The "stay up another night" prompt.
  const pulseS = 1 + Math.sin(pulse * 3.2) * 0.06
  inkText(ink, 'sagain', labels.again, ink.cx, y + h * 0.84, ink.u(32) * pulseS, {
    align: 'center', baseline: 'middle', color: NOTEBOOK.ink, width: ink.u(4), tilt: 0.05
  })
}

/**
 * The filled notebook (vision-board panel 8): "the notebook lies open,
 * completely filled with colourful, chaotic drawings of the games you just
 * played". `density` 0..1 scales how much got scribbled — a long night fills
 * the page.
 */
export const drawFilledPage = (ink: InkRenderer, x: number, y: number, w: number, h: number, density: number): void => {
  const rng = makeRng('filled', 0)
  const colors = ['#e04a4a', '#3a8ad8', '#3aa85a', '#d8a83a', '#a04ad8', '#e07a2a']
  const count = Math.floor(6 + density * 22)
  for (let i = 0; i < count; i++) {
    const bx = x + range(rng, 0.08, 0.92) * w
    const by = y + range(rng, 0.1, 0.9) * h
    const r = ink.u(range(rng, 12, 34))
    const col = colors[Math.floor(range(rng, 0, colors.length)) % colors.length]!
    // Scribble clusters — the shape doesn't matter, the chaos does.
    const pts: Pt[] = []
    for (let s = 0; s < 6; s++) {
      pts.push({ x: bx + range(rng, -r, r), y: by + range(rng, -r, r) })
    }
    ink.stroke(`fp${i}`, pts, { color: col, width: ink.u(range(rng, 2, 5)), passes: 1, rough: 4, alpha: 0.9 })
  }
}
