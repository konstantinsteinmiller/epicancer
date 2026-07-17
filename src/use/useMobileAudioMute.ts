// ─── Mobile-only hard audio mute ────────────────────────────────────────────
//
// On a phone the OS volume rocker controls the device output level; the Web
// Audio GainNode the desktop volume slider drives has no audible effect there.
// So the on-screen FMuteButton can't usefully "turn the volume down" on mobile.
// Players still want a way to silence the game (to play their own music in a
// separate app), so on mobile the button is a hard SILENCE toggle instead:
//
//   • suspends the shared AudioContext + pauses every tracked HTMLAudio
//     (the bg music) via the ref-counted `suspendAllAudio`, and
//   • blocks any NEW music start (`playWithFade` early-returns while muted) and
//     any NEW one-shot SFX (`playSound`/`playLoop` already refuse to start while
//     `isAudioSuspended()` is true), and
//   • hard-stops in-flight one-shots so nothing tails / resumes on unmute.
//
// It owns its OWN ref-counted suspend slot — independent of the pause-gate slot
// (`useGamePauseAudio`) and the portal soundOff slot — so it composes with ads /
// tab-hide without drifting the suspend counter (an ad firing while muted nests
// to depth 2 and unwinds back to the mute's depth 1, never to 0).
//
// Distinct from the DESKTOP volume-mute (`useCrazyMuteSync`), which zeroes the
// stored volumes and is the right model where Web Audio gain works. This flag is
// only ever true on mobile; on desktop it stays false so desktop audio (and the
// `playWithFade` guard) are untouched even if a synced save carries a mobile mute.

import { ref, watch } from 'vue'
import { mobileCheck } from '@/utils/function'
import { suspendAllAudio, resumeAllAudio, killOneShotSfx } from '@/use/useAssets'
import { getState, setState } from '@/use/useMidnightState'
import { saveDataVersion } from '@/use/useSaveStatus'
import { MOBILE_MUTE_KEY } from '@/keys'

const onMobile = mobileCheck()

const readPersisted = (): boolean => onMobile && getState<boolean>(MOBILE_MUTE_KEY, false) === true

/** Reactive mute state. Only ever true on mobile — desktop reads false so its
 *  audio paths and the music `playWithFade` guard are never affected, even if a
 *  cloud-synced save from a phone carries a stored mute. */
export const isMobileAudioMuted = ref<boolean>(readPersisted())

// One ref-counted suspend slot owned by this module. `slotHeld` guards it so a
// duplicated apply (e.g. a save re-hydrate that re-asserts the same value) can
// never double-suspend and strand the game silent at depth ≥ 1.
let slotHeld = false

/** Drive the audio layer to match `muted`. Idempotent per edge. */
const apply = (muted: boolean): void => {
  if (muted && !slotHeld) {
    slotHeld = true
    suspendAllAudio()
    // Hard-stop one-shots so a frozen SFX can't resume + tail when we unmute
    // (suspend only FREEZES Web Audio sources; it doesn't end them).
    killOneShotSfx()
  } else if (!muted && slotHeld) {
    slotHeld = false
    resumeAllAudio()
  }
}

// Apply the persisted state at module load so a phone that muted last session
// boots silent. No-op on desktop (`isMobileAudioMuted` is false there).
apply(isMobileAudioMuted.value)

// Re-sync if a later cloud hydrate bumps the save version (mirrors useUser): the
// blob may not be fully populated at module-eval on cloud-only builds, so honour
// a value that lands after boot. Mobile-gated; desktop stays silent + unmuted.
watch(saveDataVersion, () => {
  if (!onMobile) return
  const persisted = readPersisted()
  if (persisted === isMobileAudioMuted.value) return
  isMobileAudioMuted.value = persisted
  apply(persisted)
})

/** Toggle the mobile hard-mute and persist the choice. Only reachable from the
 *  mobile FMuteButton; a no-op-shaped call on desktop would suspend with no
 *  visible un-mute, so the button never renders the mobile variant off-mobile. */
export const toggleMobileAudioMute = (): void => {
  const next = !isMobileAudioMuted.value
  isMobileAudioMuted.value = next
  setState(MOBILE_MUTE_KEY, next)
  apply(next)
}
