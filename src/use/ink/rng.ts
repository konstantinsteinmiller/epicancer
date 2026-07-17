// ─── Deterministic noise for the boiling-line effect ───────────────────────
//
// The whole hand-drawn look rests on one idea: a shape's wobble must be
// RANDOM-LOOKING but STABLE for a given (shape, frame) pair. If we called
// Math.random() per frame the linework would seethe at 60fps like TV static —
// unreadable, and nothing like a pen drawing. What we want is the classic
// "boil": exactly THREE alternate drawings of the same shape, cycled at 12fps,
// so the ink appears to breathe (see GDD §2.2).
//
// So every draw call derives its jitter from `hash(shapeId) ^ boilFrame`.
// Same shape + same boil frame → byte-identical wobble, every time. The shape
// can move, scale or rotate freely between frames; the pen's "hand" stays the
// same. That's what sells it as a drawing rather than a simulation.

/**
 * FNV-1a over a string. Cheap, well-distributed for short ASCII ids, and
 * stable across runs (unlike object identity), which is what lets a shape keep
 * its personality between frames — and between sessions.
 */
export const hashString = (str: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // h *= 16777619, via shifts to stay in 32-bit int range without Math.imul
    // overflow surprises. `>>> 0` keeps it unsigned.
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Mulberry32 — a 32-bit PRNG that is fast, allocation-free and good enough for
 * visual noise. Returns a closure producing floats in [0, 1).
 */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Convenience: an RNG keyed by a shape id and the current boil frame. */
export const makeRng = (id: string, boilFrame: number): (() => number) =>
  mulberry32(hashString(id) ^ (boilFrame * 0x9e3779b9))

/** Signed noise in [-amount, amount]. The workhorse of every jitter call. */
export const jitter = (rng: () => number, amount: number): number =>
  (rng() * 2 - 1) * amount

/** Pick a random element. Used for splatter variants and flavour lines. */
export const pick = <T>(rng: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rng() * arr.length) % arr.length] as T

/** Uniform float in [min, max). */
export const range = (rng: () => number, min: number, max: number): number =>
  min + rng() * (max - min)
