// ─── A hand-drawn stroke font ──────────────────────────────────────────────
//
// Why not just use `ctx.fillText`? Because every other mark in the notebook
// boils — it wobbles between three alternate drawings at 12fps — and a
// system-font glyph sits there perfectly still, instantly betraying that the
// page is a computer screen. The GDD asks for verbs "in huge, raw marker ink"
// and a title "scribbled in rough, bold ink"; a font file can't do that.
//
// So each glyph is stored as polylines in a 0..1 box (x right, y down, with
// the baseline at y=1 and cap height at y=0). Rendering just hands those
// polylines to `InkRenderer.stroke`, which means letters get the same wobble,
// the same doubled-back passes and the same ink bleed as everything else —
// for free, and they animate.
//
// The set is deliberately small: uppercase, digits, and the punctuation the
// game actually shouts with. Lowercase input is upcased at draw time — this is
// a game that only ever YELLS ("SMASH!", "SWAT!", "RUINED!"), and a lowercase
// set would be ~30 more glyphs of dead weight.

import type { InkRenderer, Pt, StrokeOpts } from './inkRenderer'
import { NOTEBOOK } from './palette'

/** Each glyph: an array of strokes; each stroke an array of [x, y] in 0..1. */
type Glyph = ReadonlyArray<ReadonlyArray<readonly [number, number]>>

// Advance width per glyph, in the same 0..1 units. Most are 0.62 wide with a
// 0.16 side bearing baked into the coordinates.
const W = 0.62

const GLYPHS: Record<string, Glyph> = {
  A: [[[0, 1], [0.31, 0], [0.62, 1]], [[0.11, 0.64], [0.51, 0.64]]],
  B: [
    [[0, 0], [0, 1]],
    [[0, 0], [0.42, 0], [0.55, 0.14], [0.42, 0.48], [0, 0.48]],
    [[0, 0.48], [0.46, 0.48], [0.6, 0.72], [0.46, 1], [0, 1]]
  ],
  C: [[[0.6, 0.16], [0.4, 0], [0.16, 0.03], [0, 0.34], [0, 0.7], [0.16, 0.97], [0.4, 1], [0.6, 0.85]]],
  D: [[[0, 0], [0, 1]], [[0, 0], [0.36, 0.02], [0.6, 0.3], [0.6, 0.72], [0.36, 0.98], [0, 1]]],
  E: [[[0.58, 0], [0, 0], [0, 1], [0.58, 1]], [[0, 0.5], [0.42, 0.5]]],
  F: [[[0.58, 0], [0, 0], [0, 1]], [[0, 0.5], [0.4, 0.5]]],
  G: [
    [[0.6, 0.16], [0.4, 0], [0.16, 0.03], [0, 0.34], [0, 0.7], [0.16, 0.97], [0.42, 1], [0.6, 0.82], [0.6, 0.56]],
    [[0.36, 0.56], [0.62, 0.56]]
  ],
  H: [[[0, 0], [0, 1]], [[0.6, 0], [0.6, 1]], [[0, 0.52], [0.6, 0.52]]],
  I: [[[0.3, 0], [0.3, 1]], [[0.1, 0], [0.5, 0]], [[0.1, 1], [0.5, 1]]],
  J: [[[0.5, 0], [0.5, 0.76], [0.36, 0.99], [0.12, 0.96], [0.02, 0.76]]],
  K: [[[0, 0], [0, 1]], [[0.58, 0], [0.04, 0.56]], [[0.2, 0.42], [0.6, 1]]],
  L: [[[0, 0], [0, 1], [0.56, 1]]],
  M: [[[0, 1], [0.06, 0], [0.31, 0.62], [0.56, 0], [0.62, 1]]],
  N: [[[0, 1], [0.02, 0], [0.6, 1], [0.62, 0]]],
  O: [[[0.31, 0], [0.06, 0.2], [0, 0.55], [0.1, 0.9], [0.31, 1], [0.54, 0.9], [0.62, 0.55], [0.55, 0.18], [0.31, 0]]],
  P: [[[0, 1], [0, 0], [0.42, 0.02], [0.58, 0.22], [0.44, 0.5], [0, 0.52]]],
  Q: [
    [[0.31, 0], [0.06, 0.2], [0, 0.55], [0.1, 0.9], [0.31, 1], [0.54, 0.9], [0.62, 0.55], [0.55, 0.18], [0.31, 0]],
    [[0.38, 0.74], [0.66, 1.08]]
  ],
  R: [[[0, 1], [0, 0], [0.42, 0.02], [0.58, 0.22], [0.44, 0.5], [0, 0.52]], [[0.26, 0.52], [0.6, 1]]],
  S: [[[0.58, 0.14], [0.34, 0], [0.1, 0.06], [0.04, 0.3], [0.3, 0.5], [0.56, 0.66], [0.52, 0.92], [0.26, 1], [0.02, 0.86]]],
  T: [[[0.31, 0], [0.31, 1]], [[0, 0], [0.62, 0]]],
  U: [[[0, 0], [0, 0.72], [0.16, 0.97], [0.44, 0.97], [0.6, 0.72], [0.6, 0]]],
  V: [[[0, 0], [0.31, 1], [0.62, 0]]],
  W: [[[0, 0], [0.14, 1], [0.31, 0.36], [0.48, 1], [0.62, 0]]],
  X: [[[0, 0], [0.6, 1]], [[0.6, 0], [0, 1]]],
  Y: [[[0, 0], [0.31, 0.52], [0.62, 0]], [[0.31, 0.52], [0.31, 1]]],
  Z: [[[0, 0], [0.6, 0], [0.02, 1], [0.62, 1]]],

  '0': [[[0.31, 0], [0.06, 0.22], [0.02, 0.6], [0.14, 0.94], [0.4, 1], [0.58, 0.76], [0.6, 0.34], [0.44, 0.04], [0.31, 0]], [[0.08, 0.86], [0.54, 0.14]]],
  '1': [[[0.1, 0.2], [0.32, 0], [0.32, 1]], [[0.1, 1], [0.54, 1]]],
  '2': [[[0.04, 0.2], [0.2, 0], [0.48, 0.02], [0.58, 0.26], [0.42, 0.56], [0, 1], [0.6, 1]]],
  '3': [[[0.04, 0.1], [0.34, 0], [0.56, 0.16], [0.4, 0.46], [0.16, 0.48]], [[0.4, 0.46], [0.6, 0.7], [0.44, 0.98], [0.1, 0.94]]],
  '4': [[[0.44, 0], [0, 0.7], [0.6, 0.7]], [[0.44, 0.36], [0.44, 1]]],
  '5': [[[0.56, 0], [0.08, 0.02], [0.02, 0.44], [0.34, 0.4], [0.58, 0.6], [0.5, 0.92], [0.12, 1]]],
  '6': [[[0.54, 0.04], [0.2, 0.14], [0.02, 0.5], [0.04, 0.84], [0.3, 1], [0.54, 0.88], [0.56, 0.62], [0.3, 0.5], [0.04, 0.62]]],
  '7': [[[0, 0], [0.6, 0], [0.24, 1]]],
  '8': [[[0.3, 0.48], [0.08, 0.34], [0.12, 0.08], [0.42, 0.02], [0.54, 0.26], [0.3, 0.48], [0.02, 0.66], [0.08, 0.94], [0.42, 1], [0.6, 0.78], [0.44, 0.56], [0.3, 0.48]]],
  '9': [[[0.56, 0.42], [0.3, 0.54], [0.06, 0.4], [0.1, 0.12], [0.4, 0.02], [0.58, 0.2], [0.56, 0.62], [0.4, 0.96], [0.12, 1]]],

  '!': [[[0.16, 0], [0.14, 0.68]], [[0.14, 0.88], [0.14, 1]]],
  '?': [[[0.02, 0.16], [0.18, 0], [0.44, 0.04], [0.48, 0.3], [0.24, 0.5], [0.24, 0.68]], [[0.24, 0.88], [0.24, 1]]],
  '.': [[[0.12, 0.9], [0.12, 1]]],
  ',': [[[0.16, 0.88], [0.08, 1.12]]],
  "'": [[[0.14, 0], [0.1, 0.22]]],
  // Typographic apostrophe — French/Italian elisions ("l’antenne") use it, and
  // it's the correct mark rather than the ASCII stand-in.
  '’': [[[0.14, 0], [0.1, 0.22]]],
  // Spanish opens its exclamations and questions; without these the verbs
  // would render as "Conecta!" with a hole where the ¡ should be.
  '¡': [[[0.16, 1], [0.14, 0.32]], [[0.14, 0.12], [0.14, 0]]],
  '¿': [[[0.46, 0.84], [0.3, 1], [0.04, 0.96], [0, 0.7], [0.24, 0.5], [0.24, 0.32]], [[0.24, 0.12], [0.24, 0]]],
  '-': [[[0.04, 0.54], [0.5, 0.54]]],
  ':': [[[0.14, 0.3], [0.14, 0.42]], [[0.14, 0.82], [0.14, 0.94]]],
  '+': [[[0.06, 0.54], [0.5, 0.54]], [[0.28, 0.32], [0.28, 0.76]]],
  '/': [[[0.5, 0], [0.04, 1]]],
  '(': [[[0.34, 0], [0.1, 0.32], [0.1, 0.7], [0.34, 1]]],
  ')': [[[0.1, 0], [0.34, 0.32], [0.34, 0.7], [0.1, 1]]],
  '×': [[[0.06, 0.3], [0.5, 0.78]], [[0.5, 0.3], [0.06, 0.78]]],
  '…': [[[0.04, 0.96], [0.06, 1]], [[0.28, 0.96], [0.3, 1]], [[0.52, 0.96], [0.54, 1]]]
}

// ── Accents ───────────────────────────────────────────────────────────────
//
// Half the Latin-script locales this game ships need diacritics: German's
// "Träumen", French's "Écrase", Polish's "Podłącz", Turkish's "Fişi". Adding a
// separate glyph for every accented letter would mean hundreds of entries; and
// spelling around them ("Traeumen") ships typos that native speakers read as
// sloppiness.
//
// So accents are COMPOSED. `String.normalize('NFD')` splits "É" into "E" +
// U+0301, we draw the base letter from the table above, then stroke the mark
// over it. One small table of marks covers every Latin locale here.
const ACCENTS: Record<string, ReadonlyArray<ReadonlyArray<readonly [number, number]>>> = {
  '́': [[[0.18, -0.14], [0.42, -0.34]]],                       // acute
  '̀': [[[0.18, -0.34], [0.42, -0.14]]],                       // grave
  '̂': [[[0.14, -0.16], [0.31, -0.36], [0.48, -0.16]]],        // circumflex
  '̌': [[[0.14, -0.36], [0.31, -0.16], [0.48, -0.36]]],        // caron
  '̃': [[[0.12, -0.2], [0.24, -0.32], [0.38, -0.18], [0.5, -0.3]]], // tilde
  '̈': [[[0.2, -0.24], [0.2, -0.34]], [[0.42, -0.24], [0.42, -0.34]]], // diaeresis
  '̊': [[[0.31, -0.34], [0.22, -0.28], [0.31, -0.2], [0.4, -0.28], [0.31, -0.34]]], // ring
  '̆': [[[0.16, -0.32], [0.24, -0.18], [0.4, -0.18], [0.48, -0.32]]], // breve
  '̧': [[[0.3, 1.0], [0.34, 1.16], [0.2, 1.2]]],               // cedilla (below)
  '̨': [[[0.34, 1.0], [0.42, 1.14], [0.28, 1.18]]]             // ogonek (below)
}

/** Letters with no decomposition that still need a special case. */
const SPECIAL: Record<string, string> = {
  // Polish Ł: NFD leaves it whole (the stroke isn't a combining mark), so map
  // it to a plain L. Losing the bar is a far smaller sin than losing the word.
  'Ł': 'L',
  'ł': 'L',
  // Turkish dotless/dotted I both collapse to I once uppercased.
  'İ': 'I',
  'ı': 'I',
  // Nordic/Scandinavian slashed O.
  'Ø': 'O',
  'ø': 'O',
  'Đ': 'D',
  'đ': 'D'
}

/** Split a character into a strokeable base letter and any accent marks. */
const decompose = (ch: string): { base: string; marks: string[] } | null => {
  const mapped = SPECIAL[ch]
  if (mapped) return { base: mapped, marks: [] }
  const nfd = ch.normalize('NFD')
  const base = nfd[0]!
  if (!GLYPHS[base]) return null
  const marks: string[] = []
  for (let i = 1; i < nfd.length; i++) {
    const m = nfd[i]!
    // An unknown mark is dropped rather than failing the whole word — the
    // letter still reads correctly without it.
    if (ACCENTS[m]) marks.push(m)
  }
  return { base, marks }
}

/** Per-glyph advance overrides for the narrow ones. */
const ADVANCE: Record<string, number> = {
  I: 0.44, '1': 0.5, '!': 0.3, '.': 0.26, ',': 0.26, "'": 0.26, ':': 0.28,
  '-': 0.5, '(': 0.4, ')': 0.4, '…': 0.62, ' ': 0.42
}

const advanceOf = (ch: string): number => {
  if (ADVANCE[ch] != null) return ADVANCE[ch]!
  if (GLYPHS[ch]) return W
  const d = decompose(ch)
  if (d) return ADVANCE[d.base] ?? W
  return 0.42
}

/** Letter spacing, in the same 0..1 units. */
const TRACKING = 0.14

// ── The fallback face ─────────────────────────────────────────────────────
//
// The stroke font is uppercase Latin + digits. That covers English, German,
// Spanish, French and the other Latin-script locales — but this game ships
// Cyrillic (ru/uk/kk), CJK (zh/ja/ko), Arabic, Devanagari (hi) and Thai too,
// and hand-authoring stroke data for those scripts is not remotely tractable.
//
// Without a fallback, those nine locales would render every verb, title and
// summary line as BLANK — the glyph lookup would simply find nothing and the
// pen would never touch the page. So any string containing a character we
// can't stroke is drawn with a real system font instead.
//
// It's a deliberate, visible compromise: those locales lose the boiling
// linework on TEXT (everything else on the page still boils). To keep them
// from looking pasted-on, the fallback still jitters its position and angle
// per boil frame, so the words breathe with the rest of the drawing.

/** True when every character in `s` has stroke data and can be hand-drawn. */
const canStroke = (s: string): boolean => {
  for (const ch of s) {
    if (ch === ' ') continue
    if (GLYPHS[ch]) continue
    if (decompose(ch)) continue
    return false
  }
  return true
}

/** Width of `text` if drawn at `size`, in page units. Lets callers centre
 *  text without a canvas measure — the glyph metrics are all right here.
 *
 *  For fallback-face strings there are no metrics to consult, so this is an
 *  ESTIMATE. It only feeds fit-to-width shrinking, where being slightly
 *  conservative is harmless (the text ends up a little smaller than it had to
 *  be) and being wrong in the other direction would let a long verb run off a
 *  320px screen. Hence the deliberately generous 0.78 factor. */
export const measureInkText = (text: string, size: number): number => {
  const s = text.toUpperCase()
  if (!canStroke(s)) return [...s].length * size * 0.78
  let w = 0
  for (let i = 0; i < s.length; i++) {
    w += advanceOf(s[i]!) + (i < s.length - 1 ? TRACKING : 0)
  }
  return w * size
}

/** Draw a non-strokeable string with a real font, jittered per boil frame so
 *  it still moves with the rest of the page. */
const drawFallbackText = (
  ink: InkRenderer, id: string, text: string, x: number, y: number, size: number, opts: InkTextOpts
): void => {
  const { ctx } = ink
  const rng = makeLetterRng(id, 0, ink.boil)
  ctx.save()
  // A heavy weight approximates the marker/ballpoint mass of the stroke font.
  ctx.font = `700 ${size}px system-ui, "Segoe UI", "Noto Sans", "Hiragino Sans", "Malgun Gothic", sans-serif`
  ctx.textAlign = opts.align === 'center' ? 'center' : opts.align === 'right' ? 'right' : 'left'
  ctx.textBaseline =
    opts.baseline === 'middle' ? 'middle' : opts.baseline === 'top' ? 'top' : 'alphabetic'
  ctx.fillStyle = opts.color ?? NOTEBOOK.ink
  ctx.globalAlpha = opts.alpha ?? 1
  ctx.translate(x + (rng() * 2 - 1) * size * 0.02, y + (rng() * 2 - 1) * size * 0.02)
  if (opts.rotate) ctx.rotate(opts.rotate)
  ctx.rotate((rng() * 2 - 1) * 0.014)
  // White halo for legibility over busy art — a wide white stroke behind the
  // fill. The stroke-font path reuses seeds for this; the system font has no
  // strokes to reuse, so a plain outline is the equivalent.
  if (opts.halo) {
    const extra = typeof opts.halo === 'number' ? opts.halo : 0.16
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#fbf8ee'
    ctx.lineWidth = size * (extra + 0.12)
    ctx.globalAlpha = opts.alpha ?? 1
    ctx.strokeText(text, 0, 0)
    ctx.fillStyle = opts.color ?? NOTEBOOK.ink
  }
  // Two offset passes fake the doubled-back weight of a pen bearing down.
  if (opts.bleed) {
    ctx.globalAlpha = (opts.alpha ?? 1) * 0.25
    ctx.fillText(text, size * 0.02, size * 0.02)
    ctx.globalAlpha = opts.alpha ?? 1
  }
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

export interface InkTextOpts extends StrokeOpts {
  /** 'left' | 'center' | 'right' — horizontal anchor at `x`. */
  align?: 'left' | 'center' | 'right'
  /** 'top' | 'middle' | 'baseline' — vertical anchor at `y`. */
  baseline?: 'top' | 'middle' | 'baseline'
  /** Radians. Each letter also gets its own small random tilt on top. */
  rotate?: number
  /** Per-letter random tilt amount in radians. 0 for a tidy line.
   *  Non-zero is what makes a shouted word look shouted. */
  tilt?: number
  /** Per-letter vertical scatter, fraction of size. Handwriting doesn't sit
   *  on a perfect baseline. */
  scatter?: number
  /**
   * Draw a soft white halo behind the text so it stays legible over busy
   * game art. `true` uses a sensible width; a number is the extra halo width
   * as a FRACTION of the cap height (0.16 ≈ a chunky outline). This is what
   * makes the onboarding hints readable on top of a router / ice-cream / etc.
   */
  halo?: boolean | number
}

/**
 * Draw hand-lettered text. `size` is the cap height in page units.
 *
 * Each letter is jittered by the ink renderer AND given its own bounce/tilt,
 * seeded from (id, letter index, boil) — so the word wobbles as a whole while
 * each letter keeps its own personality frame to frame.
 */
export const inkText = (
  ink: InkRenderer,
  id: string,
  text: string,
  x: number,
  y: number,
  size: number,
  opts: InkTextOpts = {}
): void => {
  const s = text.toUpperCase()
  // Scripts the stroke font can't draw fall back to a real font — otherwise
  // ru/uk/kk/zh/ja/ko/ar/hi/th would render nothing at all. See `canStroke`.
  if (!canStroke(s)) {
    drawFallbackText(ink, id, text, x, y, size, opts)
    return
  }

  // White halo pass. Rendered FIRST (so it sits under the ink) as a wider,
  // white, wobble-matched copy of the same text — because it reuses the same
  // `id`, its per-letter seeds are identical, so the halo lands exactly under
  // each stroke. Reads as a soft paper outline that lifts the text off busy
  // art beneath it.
  if (opts.halo) {
    const extra = typeof opts.halo === 'number' ? opts.halo : 0.16
    const base = opts.width ?? size * 0.1
    inkText(ink, id, text, x, y, size, {
      ...opts,
      halo: false,
      color: '#fbf8ee',
      width: base + size * extra,
      bleed: false,
      passes: 1,
      alpha: (opts.alpha ?? 1)
    })
  }

  const total = measureInkText(s, size)
  const align = opts.align ?? 'left'
  const baseline = opts.baseline ?? 'baseline'
  const tilt = opts.tilt ?? 0.05
  const scatter = opts.scatter ?? 0.03

  let startX = x
  if (align === 'center') startX = x - total / 2
  else if (align === 'right') startX = x - total

  // Glyph coords put the baseline at y=1, so `baseline` mode needs no shift.
  let baseY = y
  if (baseline === 'top') baseY = y + size
  else if (baseline === 'middle') baseY = y + size / 2

  const { ctx } = ink
  ctx.save()
  if (opts.rotate) {
    ctx.translate(x, baseY)
    ctx.rotate(opts.rotate)
    ctx.translate(-x, -baseY)
  }

  let penX = startX
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const composed = GLYPHS[ch] ? null : decompose(ch)
    const glyph = GLYPHS[ch] ?? (composed ? GLYPHS[composed.base] : undefined)
    const adv = advanceOf(ch)
    if (glyph) {
      // Seed per letter INDEX (not per character) so a repeated letter in the
      // same word doesn't get identical handwriting — "SMASH" reads better
      // when its two S's differ.
      const rng = makeLetterRng(id, i, ink.boil)
      const dy = (rng() * 2 - 1) * scatter * size
      const rot = (rng() * 2 - 1) * tilt

      ctx.save()
      ctx.translate(penX, baseY + dy)
      ctx.rotate(rot)
      for (let gi = 0; gi < glyph.length; gi++) {
        const strokePts = glyph[gi]!
        const pts: Pt[] = strokePts.map(([gx, gy]) => ({
          x: gx * size,
          y: (gy - 1) * size
        }))
        ink.stroke(`${id}:${i}:${gi}`, pts, {
          width: size * 0.1,
          rough: size * 0.022,
          passes: 2,
          ...opts
        })
      }
      // Stroke any accent marks over (or under) the base letter.
      if (composed) {
        for (let mi = 0; mi < composed.marks.length; mi++) {
          const mark = ACCENTS[composed.marks[mi]!]!
          for (let si = 0; si < mark.length; si++) {
            const pts: Pt[] = mark[si]!.map(([gx, gy]) => ({
              x: gx * size,
              y: (gy - 1) * size
            }))
            ink.stroke(`${id}:${i}:a${mi}:${si}`, pts, {
              width: size * 0.085,
              rough: size * 0.02,
              passes: 1,
              ...opts
            })
          }
        }
      }
      ctx.restore()
    }
    penX += (adv + TRACKING) * size
  }
  ctx.restore()
}

// Local seed helper — kept out of `rng.ts` because the letter-index mixing is
// specific to text layout.
const makeLetterRng = (id: string, index: number, boil: number): (() => number) => {
  let h = 0x811c9dc5
  const key = `${id}#${index}`
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  let a = (h ^ (boil * 0x9e3779b9)) >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
