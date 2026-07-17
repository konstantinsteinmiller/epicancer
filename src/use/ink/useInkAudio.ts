// ─── The tactile audio suite ───────────────────────────────────────────────
//
// "Every UI interaction must sound material. Clicking buttons must sound like
// a heavy mechanical pencil clicking or a marker cap popping off." (GDD §5)
//
// None of those sounds exist as assets in this repo, and a generic UI blip
// would undercut the whole conceit. So they're SYNTHESISED here — which turns
// out to be the right call for more than just asset availability:
//
//   - every sound takes parameters, so the mosquito's whine can rise as its
//     ring closes and the ticking match can accelerate with the timer, rather
//     than being one frozen recording,
//   - they cost zero bytes and zero decode time (the game is playable the
//     instant the bundle lands),
//   - retuning is a number change, not a trip to a sound library.
//
// The handful of sounds with texture worth more than a synth can fake (page
// rips, stamps) stay sampled and are fired through `useSound` instead.
//
// ── The mute contract ──
// Portals reject games whose audio plays under an ad. Every voice here routes
// through ONE master gain, and the pause gate (`useGamePause`) hard-zeroes it
// AND stops scheduled voices. `isAudioSuspended()` is checked before a voice
// is even created, mirroring `useSound.playSound`. See `installInkAudioGate`.

import { watch } from 'vue'
import { getAudioContext, isAudioSuspended } from '@/use/useAssets'
import { onPauseChange } from '@/use/useGamePause'
import { isMobileAudioMuted } from '@/use/useMobileAudioMute'
import useUser from '@/use/useUser'

let master: GainNode | null = null
let ctxRef: AudioContext | null = null
/** Voices that loop until told otherwise (the buzz, the static). Tracked so
 *  the pause gate and scene teardown can silence them all. */
const activeLoops = new Set<Loop>()

/** Lazily build the master bus. Returns null when audio can't run — every
 *  public function in this module treats that as "stay silent". */
const bus = (): { ctx: AudioContext; out: GainNode } | null => {
  const ctx = getAudioContext()
  if (!ctx) return null
  if (!master || ctxRef !== ctx) {
    master = ctx.createGain()
    master.gain.value = 1
    master.connect(ctx.destination)
    ctxRef = ctx
  }
  return { ctx, out: master }
}

/** Player volume, clamped. Mirrors `useSound.clampVolume` so the options
 *  slider governs synth and sample voices identically. */
const vol = (ratio: number): number => {
  if (isMobileAudioMuted.value) return 0
  const { userSoundVolume } = useUser()
  return Math.max(0, Math.min(1, (userSoundVolume.value ?? 0.7) * ratio))
}

/** True when no voice should start. */
const silent = (): boolean => isAudioSuspended() || isMobileAudioMuted.value

// ── Primitives ────────────────────────────────────────────────────────────

/** A short burst of white noise. The raw material of nearly every physical
 *  sound here — slaps, rips, static, wind. */
const noiseBuffer = (ctx: AudioContext, seconds: number): AudioBuffer => {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds))
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return buf
}

/** Envelope helper: attack to `peak`, then exponential decay to silence.
 *  `exponentialRampToValueAtTime` can't reach 0, hence the tiny floor. */
const env = (g: GainNode, t0: number, peak: number, attack: number, decay: number): void => {
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
}

// ── One-shots ─────────────────────────────────────────────────────────────

/** Mechanical pencil click — every UI press. Two tight noise ticks through a
 *  high bandpass: the plastic snap, then the lead advancing. */
export const penClick = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  for (let i = 0; i < 2; i++) {
    const src = ctx.createBufferSource()
    src.buffer = noiseBuffer(ctx, 0.03)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2600 + i * 900
    bp.Q.value = 6
    const g = ctx.createGain()
    env(g, t0 + i * 0.035, vol(0.5), 0.001, 0.03)
    src.connect(bp).connect(g).connect(out)
    src.start(t0 + i * 0.035)
    src.stop(t0 + i * 0.035 + 0.06)
  }
}

/** Marker cap popping off — a resonant hollow pop. A fast pitch-drop sine is
 *  the "pop"; the noise transient is the cap letting go. */
export const markerPop = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(720, t0)
  osc.frequency.exponentialRampToValueAtTime(180, t0 + 0.07)
  const g = ctx.createGain()
  env(g, t0, vol(0.6), 0.004, 0.09)
  osc.connect(g).connect(out)
  osc.start(t0)
  osc.stop(t0 + 0.16)

  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.02)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 1800
  const ng = ctx.createGain()
  env(ng, t0, vol(0.25), 0.001, 0.02)
  src.connect(hp).connect(ng).connect(out)
  src.start(t0)
  src.stop(t0 + 0.05)
}

/** The briefing's deep bass thump (GDD §3.1). A sine dropping into the floor —
 *  felt more than heard, which is exactly what a one-word command wants under
 *  it. `pitch` rises as the night escalates. */
export const bassThump = (pitch = 1): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(150 * pitch, t0)
  osc.frequency.exponentialRampToValueAtTime(38 * pitch, t0 + 0.22)
  const g = ctx.createGain()
  env(g, t0, vol(0.95), 0.008, 0.34)
  osc.connect(g).connect(out)
  osc.start(t0)
  osc.stop(t0 + 0.5)

  // A click transient on top so it cuts through on phone speakers, which
  // reproduce nothing below ~200Hz — without this the thump is inaudible on
  // exactly the devices most players are using.
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.03)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 900
  const ng = ctx.createGain()
  env(ng, t0, vol(0.4), 0.001, 0.05)
  src.connect(lp).connect(ng).connect(out)
  src.start(t0)
  src.stop(t0 + 0.09)
}

/** The router's plug seating home: a booming mechanical CLACK (GDD §4.1).
 *  Two detuned square blips (the plastic) over a filtered noise thwack (the
 *  impact) and a low body resonance. */
export const clack = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.08)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.setValueAtTime(1800, t0)
  bp.frequency.exponentialRampToValueAtTime(400, t0 + 0.07)
  bp.Q.value = 1.4
  const ng = ctx.createGain()
  env(ng, t0, vol(0.75), 0.001, 0.09)
  src.connect(bp).connect(ng).connect(out)
  src.start(t0)
  src.stop(t0 + 0.14)

  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.setValueAtTime(220 - i * 40, t0)
    osc.frequency.exponentialRampToValueAtTime(90 - i * 20, t0 + 0.05)
    const g = ctx.createGain()
    env(g, t0, vol(0.3), 0.002, 0.07)
    osc.connect(g).connect(out)
    osc.start(t0)
    osc.stop(t0 + 0.14)
  }
}

/** The mosquito slap: SMACK (GDD §4.2). A wide noise burst with a fast
 *  lowpass sweep — skin, not wood — plus a low thump for the arm behind it. */
export const smack = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.12)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(6000, t0)
  lp.frequency.exponentialRampToValueAtTime(500, t0 + 0.1)
  const g = ctx.createGain()
  env(g, t0, vol(0.85), 0.001, 0.12)
  src.connect(lp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.2)

  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(190, t0)
  osc.frequency.exponentialRampToValueAtTime(70, t0 + 0.09)
  const og = ctx.createGain()
  env(og, t0, vol(0.5), 0.003, 0.11)
  osc.connect(og).connect(out)
  osc.start(t0)
  osc.stop(t0 + 0.22)
}

/** Success chime — a bright bell. Three inharmonic partials, because a bell's
 *  overtones are NOT integer multiples; stacked octaves would sound like an
 *  organ. `step` shifts it up the scale for combo stacking. */
export const chime = (step = 0): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const root = 880 * Math.pow(2, step / 12)
  const partials = [1, 2.76, 5.4]
  const gains = [0.5, 0.22, 0.1]
  for (let i = 0; i < partials.length; i++) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = root * partials[i]!
    const g = ctx.createGain()
    env(g, t0, vol(gains[i]!), 0.004, 0.55 - i * 0.12)
    osc.connect(g).connect(out)
    osc.start(t0)
    osc.stop(t0 + 0.9)
  }
}

/** The failure sting — a sour descending two-tone. */
export const sourBuzz = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(200 - i * 18, t0)
    osc.frequency.linearRampToValueAtTime(110 - i * 12, t0 + 0.32)
    const g = ctx.createGain()
    env(g, t0, vol(0.32), 0.01, 0.34)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1200
    osc.connect(lp).connect(g).connect(out)
    osc.start(t0)
    osc.stop(t0 + 0.42)
  }
}

/** A wet splat — the ice cream hitting the rug (GDD §4.3). Lowpassed noise
 *  with a pitch-dropping body. */
export const splat = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.25)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(1400, t0)
  lp.frequency.exponentialRampToValueAtTime(180, t0 + 0.22)
  const g = ctx.createGain()
  env(g, t0, vol(0.7), 0.004, 0.26)
  src.connect(lp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.4)
}

// ── Heat-themed anthology (games 6–10) ─────────────────────────────────────

/** Mirage Whack: a cute rising "BOOP" when you bop the real jerboa. A quick
 *  upward sine blip — playful, not percussive. */
export const boop = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(420, t0)
  osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.09)
  osc.frequency.exponentialRampToValueAtTime(660, t0 + 0.16)
  const g = ctx.createGain()
  env(g, t0, vol(0.5), 0.006, 0.16)
  osc.connect(g).connect(out)
  osc.start(t0)
  osc.stop(t0 + 0.28)
}

/** Tapping a mirage: a hollow, disappointing little "poof" of nothing. */
export const poof = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.16)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(900, t0)
  lp.frequency.exponentialRampToValueAtTime(220, t0 + 0.14)
  const g = ctx.createGain()
  env(g, t0, vol(0.28), 0.01, 0.16)
  src.connect(lp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.3)
}

/** Thermometer Tap: a frozen CRACKLE as an ice cube drops in. A cluster of
 *  brittle high ticks — ice fracturing. */
export const iceCrackle = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  for (let i = 0; i < 5; i++) {
    const at = t0 + i * 0.02 + Math.random() * 0.01
    const src = ctx.createBufferSource()
    src.buffer = noiseBuffer(ctx, 0.02)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 4200 + i * 700 + Math.random() * 800
    bp.Q.value = 9
    const g = ctx.createGain()
    env(g, at, vol(0.22), 0.001, 0.03)
    src.connect(bp).connect(g).connect(out)
    src.start(at)
    src.stop(at + 0.05)
  }
  // A soft cool wash under the ticks.
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(600, t0)
  osc.frequency.exponentialRampToValueAtTime(300, t0 + 0.2)
  const og = ctx.createGain()
  env(og, t0, vol(0.18), 0.005, 0.2)
  osc.connect(og).connect(out)
  osc.start(t0)
  osc.stop(t0 + 0.32)
}

/** The thermometer shattering: a burst of broken-glass shards. */
export const glassShatter = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  // The initial crack.
  const crack = ctx.createBufferSource()
  crack.buffer = noiseBuffer(ctx, 0.05)
  const chp = ctx.createBiquadFilter()
  chp.type = 'highpass'
  chp.frequency.value = 2500
  const cg = ctx.createGain()
  env(cg, t0, vol(0.6), 0.001, 0.05)
  crack.connect(chp).connect(cg).connect(out)
  crack.start(t0)
  crack.stop(t0 + 0.08)
  // Tinkling shards falling.
  for (let i = 0; i < 9; i++) {
    const at = t0 + 0.03 + i * 0.035 + Math.random() * 0.02
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = 2600 + Math.random() * 3200
    const g = ctx.createGain()
    env(g, at, vol(0.14), 0.001, 0.09)
    osc.connect(g).connect(out)
    osc.start(at)
    osc.stop(at + 0.12)
  }
}

/** Hot Potato: a comical high squeak when the stone is caught / thrown. */
export const squeak = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  // Up-then-down, like a rubber-toy squeeze.
  osc.frequency.setValueAtTime(600, t0)
  osc.frequency.exponentialRampToValueAtTime(1500, t0 + 0.06)
  osc.frequency.exponentialRampToValueAtTime(700, t0 + 0.14)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 2400
  const g = ctx.createGain()
  env(g, t0, vol(0.3), 0.005, 0.14)
  osc.connect(lp).connect(g).connect(out)
  osc.start(t0)
  osc.stop(t0 + 0.24)
}

/** A hand catching fire / the pipe burning: an angry sizzle. */
export const sizzle = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.6)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.setValueAtTime(3200, t0)
  bp.frequency.exponentialRampToValueAtTime(1400, t0 + 0.5)
  bp.Q.value = 0.8
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(vol(0.4), t0 + 0.05)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55)
  src.connect(bp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.65)
}

/** Shadow Jump: a relieved "phew" on a safe landing. A soft descending
 *  breath — filtered noise falling in pitch, not a tone. */
export const phew = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.4)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.setValueAtTime(1100, t0)
  bp.frequency.exponentialRampToValueAtTime(500, t0 + 0.34)
  bp.Q.value = 2.5
  const g = ctx.createGain()
  env(g, t0, vol(0.28), 0.06, 0.32)
  src.connect(bp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.5)
}

/** Shadow Jump miss: a comical fire-alarm — two-tone warble. */
export const alarm = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const g = ctx.createGain()
  g.gain.value = 0
  const osc = ctx.createOscillator()
  osc.type = 'square'
  osc.connect(g).connect(out)
  // Warble between two pitches ~4 times.
  const lo = 620, hi = 900
  for (let i = 0; i < 8; i++) {
    osc.frequency.setValueAtTime(i % 2 === 0 ? hi : lo, t0 + i * 0.08)
  }
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(vol(0.28), t0 + 0.02)
  g.gain.setValueAtTime(vol(0.28), t0 + 0.58)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.68)
  osc.start(t0)
  osc.stop(t0 + 0.72)
}

// ── Super Saiyan ──────────────────────────────────────────────────────────

/**
 * One pump of the power button. `level` 0..1 pitches it up as the power climbs,
 * so a mash run audibly ascends instead of flatly repeating.
 *
 * This fires up to ~8×/second, which rules out anything long or tonal — it
 * would smear into mud. It's a short filtered thump with a hard transient: felt
 * as an impact per click rather than heard as a note.
 */
export const powerClick = (level = 0): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const c = Math.max(0, Math.min(1, level))

  const osc = ctx.createOscillator()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(190 + c * 260, t0)
  osc.frequency.exponentialRampToValueAtTime(70 + c * 90, t0 + 0.07)
  const g = ctx.createGain()
  env(g, t0, vol(0.45), 0.002, 0.08)
  osc.connect(g).connect(out)
  osc.start(t0)
  osc.stop(t0 + 0.14)

  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.04)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 900 + c * 1800
  bp.Q.value = 1.2
  const ng = ctx.createGain()
  env(ng, t0, vol(0.3), 0.001, 0.05)
  src.connect(bp).connect(ng).connect(out)
  src.start(t0)
  src.stop(t0 + 0.08)
}

/**
 * The transformation scream — a sustained roar under the whole Saiyan round.
 *
 * Per the spec every click should trigger an "Aargh!", but firing a discrete
 * roar 8×/second would machine-gun into noise. A held roar whose intensity and
 * pitch track the power level reads as ONE continuous scream getting more
 * desperate, which is the actual Dragon Ball Z memory — and each click still
 * punches through via `powerClick`.
 *
 * Built from a detuned saw stack through a formant-ish bandpass: a growl, not
 * a synth tone.
 */
export const saiyanRoar = (): Loop | null => {
  if (silent()) return null
  const b = bus()
  if (!b) return null
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const g = ctx.createGain()
  g.gain.value = 0
  // Two stacked bandpasses approximate a vowel — an open "aaah" rather than a
  // buzz. This is most of what makes it read as a voice.
  const f1 = ctx.createBiquadFilter()
  f1.type = 'bandpass'
  f1.frequency.value = 720
  f1.Q.value = 3
  const f2 = ctx.createBiquadFilter()
  f2.type = 'bandpass'
  f2.frequency.value = 1180
  f2.Q.value = 5
  f1.connect(g)
  f2.connect(g)
  g.connect(out)

  // A little noise mixed in for the rasp of a shredded throat.
  const noise = ctx.createBufferSource()
  noise.buffer = noiseBuffer(ctx, 2)
  noise.loop = true
  const ng = ctx.createGain()
  ng.gain.value = 0.25
  noise.connect(ng)
  ng.connect(f1)
  ng.connect(f2)

  const oscs: OscillatorNode[] = []
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 110 + i * 3
    osc.connect(f1)
    osc.connect(f2)
    osc.start(t0)
    oscs.push(osc)
  }
  noise.start(t0)

  let stopped = false
  return registerLoop({
    setIntensity: (v: number) => {
      if (stopped) return
      const c = Math.max(0, Math.min(1, v))
      const now = ctx.currentTime
      g.gain.setTargetAtTime(vol(0.05 + c * 0.3), now, 0.04)
      // The voice strains upward as the power climbs.
      for (let i = 0; i < oscs.length; i++) {
        oscs[i]!.frequency.setTargetAtTime(105 + c * 95 + i * 3, now, 0.06)
      }
      f1.frequency.setTargetAtTime(700 + c * 340, now, 0.06)
      f2.frequency.setTargetAtTime(1150 + c * 700, now, 0.06)
    },
    stop: () => {
      if (stopped) return
      stopped = true
      const now = ctx.currentTime
      g.gain.setTargetAtTime(0, now, 0.05)
      for (const o of oscs) o.stop(now + 0.3)
      noise.stop(now + 0.3)
    }
  })
}

/** The "IT'S OVER 9000!" detonation — a rising sweep into a bass drop. The one
 *  moment in the game that earns a genuinely big noise. */
export const powerSurge = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime

  // Riser.
  const up = ctx.createOscillator()
  up.type = 'sawtooth'
  up.frequency.setValueAtTime(120, t0)
  up.frequency.exponentialRampToValueAtTime(1500, t0 + 0.34)
  const upG = ctx.createGain()
  env(upG, t0, vol(0.3), 0.04, 0.32)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 3000
  up.connect(lp).connect(upG).connect(out)
  up.start(t0)
  up.stop(t0 + 0.4)

  // The drop.
  const boom = ctx.createOscillator()
  boom.type = 'sine'
  boom.frequency.setValueAtTime(220, t0 + 0.34)
  boom.frequency.exponentialRampToValueAtTime(32, t0 + 0.85)
  const bg = ctx.createGain()
  env(bg, t0 + 0.34, vol(1), 0.01, 0.6)
  boom.connect(bg).connect(out)
  boom.start(t0 + 0.34)
  boom.stop(t0 + 1.1)

  // White-hot crack on the drop so it cuts on phone speakers.
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.5)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.setValueAtTime(4000, t0 + 0.34)
  bp.frequency.exponentialRampToValueAtTime(300, t0 + 0.8)
  const ng = ctx.createGain()
  env(ng, t0 + 0.34, vol(0.55), 0.005, 0.45)
  src.connect(bp).connect(ng).connect(out)
  src.start(t0 + 0.34)
  src.stop(t0 + 0.9)
}

// ── The rest of the anthology ─────────────────────────────────────────────

/** Static electricity crackle (Static Cat). Short bursts of very bright,
 *  resonant noise — the sound of a spark, not a hiss. */
export const zap = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  // Three ragged crackles a few ms apart read as one electrical snap.
  for (let i = 0; i < 3; i++) {
    const at = t0 + i * 0.018
    const src = ctx.createBufferSource()
    src.buffer = noiseBuffer(ctx, 0.03)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 3200 - i * 700
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 5200 + i * 900
    bp.Q.value = 8
    const g = ctx.createGain()
    env(g, at, vol(0.4 - i * 0.08), 0.001, 0.03)
    src.connect(hp).connect(bp).connect(g).connect(out)
    src.start(at)
    src.stop(at + 0.05)
  }
}

/** A window slamming shut — wood impact plus a glass rattle. */
export const slam = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.2)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(2200, t0)
  lp.frequency.exponentialRampToValueAtTime(200, t0 + 0.14)
  const g = ctx.createGain()
  env(g, t0, vol(0.9), 0.001, 0.16)
  src.connect(lp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.3)

  const thud = ctx.createOscillator()
  thud.type = 'sine'
  thud.frequency.setValueAtTime(140, t0)
  thud.frequency.exponentialRampToValueAtTime(45, t0 + 0.12)
  const tg = ctx.createGain()
  env(tg, t0, vol(0.8), 0.002, 0.16)
  thud.connect(tg).connect(out)
  thud.start(t0)
  thud.stop(t0 + 0.3)

  // Glass rattle in the frame afterwards.
  for (let i = 0; i < 2; i++) {
    const at = t0 + 0.09 + i * 0.05
    const r = ctx.createOscillator()
    r.type = 'triangle'
    r.frequency.value = 2400 + i * 600
    const rg = ctx.createGain()
    env(rg, at, vol(0.1), 0.002, 0.05)
    r.connect(rg).connect(out)
    r.start(at)
    r.stop(at + 0.09)
  }
}

/** The toaster's spring-loaded DING. A struck bell plus the mechanical clunk
 *  of the carriage letting go. */
export const ding = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const partials = [1, 2.4, 4.1]
  const gains = [0.4, 0.16, 0.07]
  for (let i = 0; i < partials.length; i++) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 1400 * partials[i]!
    const g = ctx.createGain()
    env(g, t0, vol(gains[i]!), 0.002, 0.8 - i * 0.2)
    osc.connect(g).connect(out)
    osc.start(t0)
    osc.stop(t0 + 1.1)
  }
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.04)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 1200
  const ng = ctx.createGain()
  env(ng, t0, vol(0.3), 0.001, 0.05)
  src.connect(lp).connect(ng).connect(out)
  src.start(t0)
  src.stop(t0 + 0.1)
}

/** A fingernail on an aluminium can. Bright, short, metallic. */
export const clink = (index = 0): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  // Ascend a little per tap so a 5-tap sequence has a sense of progress.
  const base = 2200 + index * 180
  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    // Inharmonic partial — a can is a tube, not a string.
    osc.frequency.value = base * (i === 0 ? 1 : 2.7)
    const g = ctx.createGain()
    env(g, t0, vol(i === 0 ? 0.3 : 0.12), 0.001, 0.09 - i * 0.03)
    osc.connect(g).connect(out)
    osc.start(t0)
    osc.stop(t0 + 0.14)
  }
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.02)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 4000
  const ng = ctx.createGain()
  env(ng, t0, vol(0.22), 0.001, 0.02)
  src.connect(hp).connect(ng).connect(out)
  src.start(t0)
  src.stop(t0 + 0.05)
}

/** The can opening: a sharp crack of the tab, then the PSSSHHH of escaping
 *  pressure decaying into fizz. `violent` turns a satisfying hiss into an
 *  eruption. */
export const pssh = (violent = false): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime

  // The tab cracking.
  const crack = ctx.createBufferSource()
  crack.buffer = noiseBuffer(ctx, 0.03)
  const cbp = ctx.createBiquadFilter()
  cbp.type = 'bandpass'
  cbp.frequency.value = 3000
  cbp.Q.value = 4
  const cg = ctx.createGain()
  env(cg, t0, vol(0.4), 0.001, 0.03)
  crack.connect(cbp).connect(cg).connect(out)
  crack.start(t0)
  crack.stop(t0 + 0.06)

  // The escape. A long noise tail through a falling highpass = gas venting.
  const dur = violent ? 1.4 : 0.8
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, dur + 0.2)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.setValueAtTime(violent ? 1200 : 2600, t0 + 0.02)
  hp.frequency.exponentialRampToValueAtTime(violent ? 300 : 1400, t0 + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t0 + 0.02)
  g.gain.exponentialRampToValueAtTime(vol(violent ? 0.75 : 0.34), t0 + 0.06)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  src.connect(hp).connect(g).connect(out)
  src.start(t0 + 0.02)
  src.stop(t0 + dur + 0.1)
}

/** The ticking match timer (vision-board panel 3). `urgency` 0..1 brightens
 *  and hardens the tick as the fuse burns down. */
export const tick = (urgency = 0): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.02)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 1500 + urgency * 2200
  bp.Q.value = 3
  const g = ctx.createGain()
  env(g, t0, vol(0.12 + urgency * 0.3), 0.001, 0.02 + urgency * 0.01)
  src.connect(bp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.05)
}

/** A single wind gust — the player's swipe in Melt Defense. `strength` 0..1. */
export const gust = (strength: number): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const dur = 0.3 + strength * 0.25
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, dur)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.setValueAtTime(400, t0)
  bp.frequency.linearRampToValueAtTime(1100 + strength * 900, t0 + dur * 0.4)
  bp.frequency.linearRampToValueAtTime(300, t0 + dur)
  bp.Q.value = 0.9
  const g = ctx.createGain()
  env(g, t0, vol(0.1 + strength * 0.3), dur * 0.35, dur * 0.6)
  src.connect(bp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + dur + 0.1)
}

/** The avatar landing on the page — a soft papery splat (vision-board 2). */
export const inkDrop = (): void => {
  if (silent()) return
  const b = bus()
  if (!b) return
  const { ctx, out } = b
  const t0 = ctx.currentTime
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 0.16)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(2400, t0)
  lp.frequency.exponentialRampToValueAtTime(300, t0 + 0.14)
  const g = ctx.createGain()
  env(g, t0, vol(0.5), 0.002, 0.18)
  src.connect(lp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.3)
}

// ── Loops ─────────────────────────────────────────────────────────────────

export interface Loop {
  stop: () => void
  /** 0..1 */
  setIntensity: (v: number) => void
}

/** Track a loop so `stopAllInkLoops` can reach it, and de-register it on stop
 *  so a long session doesn't accumulate dead handles. */
const registerLoop = (loop: Loop): Loop => {
  const wrapped: Loop = {
    setIntensity: loop.setIntensity,
    stop: () => {
      loop.stop()
      activeLoops.delete(wrapped)
    }
  }
  activeLoops.add(wrapped)
  return wrapped
}

/**
 * The mosquito's whine (GDD §4.2: "a tiny, irritating high-pitched buzzing").
 * A detuned saw pair with vibrato — the beating between the two is what makes
 * it grate rather than hum. `setIntensity` raises pitch and volume as the
 * mosquito closes in.
 */
export const mosquitoBuzz = (): Loop | null => {
  if (silent()) return null
  const b = bus()
  if (!b) return null
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const g = ctx.createGain()
  g.gain.value = 0
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 1400
  bp.Q.value = 2
  bp.connect(g).connect(out)

  // Vibrato — a real mosquito's pitch wavers constantly.
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 7
  const lfoGain = ctx.createGain()
  lfoGain.gain.value = 22
  lfo.connect(lfoGain)

  const oscs: OscillatorNode[] = []
  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 600 + i * 7
    lfoGain.connect(osc.frequency)
    osc.connect(bp)
    osc.start(t0)
    oscs.push(osc)
  }
  lfo.start(t0)

  let stopped = false
  return registerLoop({
    setIntensity: (v: number) => {
      if (stopped) return
      const c = Math.max(0, Math.min(1, v))
      const now = ctx.currentTime
      g.gain.setTargetAtTime(vol(0.05 + c * 0.16), now, 0.05)
      for (let i = 0; i < oscs.length; i++) {
        oscs[i]!.frequency.setTargetAtTime(560 + c * 420 + i * 7, now, 0.08)
      }
      bp.frequency.setTargetAtTime(1200 + c * 1400, now, 0.08)
    },
    stop: () => {
      if (stopped) return
      stopped = true
      const now = ctx.currentTime
      g.gain.cancelScheduledValues(now)
      g.gain.setTargetAtTime(0, now, 0.03)
      for (const o of oscs) o.stop(now + 0.2)
      lfo.stop(now + 0.2)
    }
  })
}

/**
 * TV static for the boss (GDD §4.4). Looping filtered noise whose intensity
 * the antenna angle drives — at full it's harsh white noise, at zero it's
 * silent so the retro melody can come through.
 */
export const tvStatic = (): Loop | null => {
  if (silent()) return null
  const b = bus()
  if (!b) return null
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 2)
  src.loop = true
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 700
  const g = ctx.createGain()
  g.gain.value = 0
  src.connect(hp).connect(g).connect(out)
  src.start(t0)

  let stopped = false
  return registerLoop({
    setIntensity: (v: number) => {
      if (stopped) return
      const c = Math.max(0, Math.min(1, v))
      const now = ctx.currentTime
      g.gain.setTargetAtTime(vol(c * 0.34), now, 0.06)
      // As the signal locks, the hiss also dulls — not just quietens. That
      // spectral shift is most of the "tuning in" sensation.
      hp.frequency.setTargetAtTime(400 + c * 1800, now, 0.08)
    },
    stop: () => {
      if (stopped) return
      stopped = true
      const now = ctx.currentTime
      g.gain.setTargetAtTime(0, now, 0.05)
      src.stop(now + 0.3)
    }
  })
}

/**
 * The reward behind the static: a clean retro synth melody (GDD §4.4).
 * A looping square-wave arpeggio through a gentle lowpass — the 8-bit sound
 * of finally getting a signal. Intensity is the inverse of the static's.
 */
export const retroMelody = (): Loop | null => {
  if (silent()) return null
  const b = bus()
  if (!b) return null
  const { ctx, out } = b

  const g = ctx.createGain()
  g.gain.value = 0
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 2600
  lp.connect(g).connect(out)

  const osc = ctx.createOscillator()
  osc.type = 'square'
  osc.connect(lp)

  // A wistful little loop in A minor pentatonic — scheduled as one long
  // frequency automation rather than a JS timer, so it stays sample-accurate
  // and survives a stuttering main thread.
  const notes = [440, 523.25, 659.25, 587.33, 523.25, 440, 392, 440]
  const step = 0.26
  const t0 = ctx.currentTime
  const loopLen = notes.length * step
  // Schedule a few cycles ahead; the boss phase is ~20s, so 12 cycles covers
  // it with room to spare and needs no re-scheduling logic.
  for (let cycle = 0; cycle < 12; cycle++) {
    for (let i = 0; i < notes.length; i++) {
      osc.frequency.setValueAtTime(notes[i]!, t0 + cycle * loopLen + i * step)
    }
  }
  osc.start(t0)

  let stopped = false
  return registerLoop({
    setIntensity: (v: number) => {
      if (stopped) return
      const c = Math.max(0, Math.min(1, v))
      const now = ctx.currentTime
      g.gain.setTargetAtTime(vol(c * 0.2), now, 0.08)
      lp.frequency.setTargetAtTime(700 + c * 3200, now, 0.1)
    },
    stop: () => {
      if (stopped) return
      stopped = true
      const now = ctx.currentTime
      g.gain.setTargetAtTime(0, now, 0.05)
      osc.stop(now + 0.3)
    }
  })
}

/** Rain on the window — the desk scene's ambience (vision-board panel 1).
 *  Lowpassed noise with a slow wobble so it breathes instead of hissing. */
export const rainAmbience = (): Loop | null => {
  if (silent()) return null
  const b = bus()
  if (!b) return null
  const { ctx, out } = b
  const t0 = ctx.currentTime

  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, 3)
  src.loop = true
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 1100
  const g = ctx.createGain()
  g.gain.value = 0
  src.connect(lp).connect(g).connect(out)

  // Slow filter wobble — rain intensity drifting against the window.
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 0.09
  const lfoGain = ctx.createGain()
  lfoGain.gain.value = 380
  lfo.connect(lfoGain).connect(lp.frequency)
  lfo.start(t0)
  src.start(t0)

  let stopped = false
  return registerLoop({
    setIntensity: (v: number) => {
      if (stopped) return
      const c = Math.max(0, Math.min(1, v))
      g.gain.setTargetAtTime(vol(c * 0.22), ctx.currentTime, 0.4)
    },
    stop: () => {
      if (stopped) return
      stopped = true
      const now = ctx.currentTime
      g.gain.setTargetAtTime(0, now, 0.3)
      src.stop(now + 1.2)
      lfo.stop(now + 1.2)
    }
  })
}

/** Silence and forget every looping voice. Called on scene teardown and by
 *  the pause gate. */
export const stopAllInkLoops = (): void => {
  for (const l of [...activeLoops]) {
    try { l.stop() } catch { /* already stopped */ }
  }
  activeLoops.clear()
}

// ── The mute gate ─────────────────────────────────────────────────────────

let gateInstalled = false

/**
 * Wire the master bus to the pause gate AND the mute state. Idempotent; call
 * once at scene mount.
 *
 * Pause: `useAssets.suspendAllAudio` already suspends the AudioContext when an
 * ad opens, which freezes these voices — but a suspended context RESUMES with
 * its loops still running, and a rewarded ad that fires no resume callback would
 * leave the mosquito whining under the ad. Zeroing the master gain on pause is
 * belt-and-braces: even if the context stays live, nothing is audible.
 *
 * Mute: the per-voice `vol()` already reads `userSoundVolume`, so a NEW one-shot
 * created after the player mutes is silent. But a LOOP that was already running
 * (the mosquito whine, the Saiyan roar, the rain) set its gain once and keeps
 * playing — the FMuteButton would leave it audible. So the master gain is also
 * gated on mute here: hitting mute mid-game silences everything, loops included,
 * in one place.
 */
export const installInkAudioGate = (): (() => void) => {
  if (gateInstalled) return () => {}
  gateInstalled = true

  let paused = false
  const { userSoundVolume } = useUser()

  const applyMaster = (): void => {
    const b = bus()
    if (!b) return
    const now = b.ctx.currentTime
    const muted = paused
      || isMobileAudioMuted.value
      || (userSoundVolume.value ?? 1) <= 0
    // Immediate, not ramped: an ad's (or a mute's) first frame must be silent.
    b.out.gain.cancelScheduledValues(now)
    b.out.gain.setValueAtTime(muted ? 0 : 1, now)
  }

  const off = onPauseChange((p) => { paused = p; applyMaster() })
  // Desktop mute zeroes `userSoundVolume`; mobile flips `isMobileAudioMuted`.
  // Either one must re-drive the master so running loops go silent too.
  const stopWatch = watch(
    [() => userSoundVolume.value, () => isMobileAudioMuted.value],
    applyMaster
  )

  return () => {
    off()
    stopWatch()
    gateInstalled = false
  }
}
