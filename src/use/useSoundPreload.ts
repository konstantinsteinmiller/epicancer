// Background SFX preload — fires AFTER first paint so it never competes
// with the critical path.
//
// Without this, every SFX pays its first-play decode cost the moment the
// game fires it (grass-cut #1 stutters on the first mow, the chain-loop
// silences for a beat on round start). The decode is cheap individually
// (1-5 ms per .ogg) but happens in a flurry of small bursts during the
// opening seconds of gameplay — exactly when the player is forming a
// first impression. Decoding everything once, on an idle callback,
// pushes that work off the rendering thread before it gets noticed.
//
// `loadAudioBuffer` is idempotent — repeat calls hit the cache or join
// the pending decode promise, so it's safe to call this preload more
// than once (e.g. on every MawScene mount). The visibility-hidden /
// ad-show suspend system in `useAssets.ts` doesn't affect decode — it
// only gates playback — so this works correctly even if the tab is
// backgrounded during preload.

import { prependBaseUrl } from '@/utils/function'
import { loadAudioBuffer } from '@/use/useAssets'

// Every SFX the gameplay scene can fire. Kept as a flat list so a single
// allSettled covers them all. Order doesn't matter — they decode in
// parallel and fight for the AudioContext's decoder pool. Adding a new
// SFX = add the basename here (no `.ogg`, no path prefix).
// Midnight Analog's percussive, material layer (the CLACK, the SMACK, the pen
// clicks, the mosquito whine, the TV static) is SYNTHESISED at runtime in
// `use/ink/useInkAudio.ts` — nothing to decode for those. What stays sampled is
// the handful of sounds with a texture worth more than a synth can fake: the
// page rips, the stamp chimes, and the loss sting.
const GAMEPLAY_SFX: ReadonlyArray<string> = [
  // Page rip / crumple — fired on a failed micro-game and the boss's
  // page-tearing lightning. Two variants so consecutive rips don't machine-gun.
  'plastic-torn-1',
  'plastic-torn-2',
  // Judgment stamps.
  'win',
  'lose',
  // Escalation sting every 4th game + the boss banner slam.
  'level-up',
  // Morning payoff.
  'happy',
  'celebration-1'
]

let preloadStarted = false
let preloadDone: Promise<void> | null = null

/** Kick off background decode of every gameplay SFX. Idempotent; calling
 *  twice returns the SAME promise (resolves once every decode has settled), so
 *  callers can sequence work AFTER the sounds finish (e.g. warm the remaining
 *  ball skins only once audio is decoded). Off the critical path — the asset
 *  preloader runs it only after the hot-path art + first paint are done. */
export const preloadGameplaySounds = (): Promise<void> => {
  if (preloadDone) return preloadDone
  preloadStarted = true
  preloadDone = Promise.allSettled(
    GAMEPLAY_SFX.map((name) => loadAudioBuffer(prependBaseUrl(`audio/sfx/${name}.ogg`)))
  ).then(() => undefined)
  return preloadDone
}

/** Schedule `preloadGameplaySounds()` on the first available idle slot.
 *  Falls back to `setTimeout(0)` on browsers that don't expose
 *  `requestIdleCallback` (mostly Safari). Either path runs after the
 *  current animation frame so the first paint isn't delayed. */
export const schedulePreloadOnIdle = (): void => {
  if (preloadStarted) return
  if (typeof window === 'undefined') return
  const ric = (window as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout: number }) => number)
    | undefined
  if (typeof ric === 'function') {
    ric(() => preloadGameplaySounds(), { timeout: 2000 })
  } else {
    setTimeout(() => preloadGameplaySounds(), 0)
  }
}
