<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'

import useEpicGame, { gameMode, setGameMode, bestEndless, isOnboardingRun, setPendingBoon, combo, racerActive, exitingActive, type BoonId } from '@/use/useEpicGame'
import useEpicConfig from '@/use/useEpicConfig'
import { drawScene, configureGeometry, setBallSkin, setGhostBest } from '@/use/useEpicArt'
import { powerupFraction } from '@/use/usePowerups'
import useEpicProgress, { UPGRADES } from '@/use/useEpicProgress'
import useMissions from '@/use/useMissions'
import useAchievements from '@/use/useAchievements'
import { selectedSkinSrc } from '@/use/useEpicSkins'
import { prependBaseUrl } from '@/utils/function'
import { getState, setState } from '@/use/useEpicState'
import { DAILY_BONUS_DAY_KEY, UPGRADE_SPOTLIGHT_KEY } from '@/keys'
import useBattlePass from '@/use/useBattlePass'
import { useMusic } from '@/use/useSound'
import useSounds from '@/use/useSound'
import { useScreenshake } from '@/use/useScreenshake'
import { isGamePaused } from '@/use/useGamePause'
import { isMobilePortrait, isMobileLandscape, isShortViewport } from '@/use/useUser'
import { spawnCoinExplosion } from '@/use/useCoinExplosion'
import {
  isInterstitialReady,
  isRewardedReady,
  showMidgameAd,
  showRewardedAd
} from '@/use/useAds'
import { startGameplay, stopGameplay } from '@/use/useCrazyGames'
import { isAnyModalOpen } from '@/use/useModalState'
import { playFirstStartInterstitial } from '@/use/useFirstStartInterstitial'

import StageBadge from '@/components/StageBadge.vue'
import ScoreBadge from '@/components/atoms/ScoreBadge.vue'
import PowerupBanner from '@/components/atoms/PowerupBanner.vue'
import CoinBadge from '@/components/organisms/CoinBadge.vue'
import TreasureChest from '@/components/organisms/TreasureChest.vue'
import FMuteButton from '@/components/atoms/FMuteButton.vue'
import FReward from '@/components/atoms/FReward.vue'
import DailyRewards from '@/components/organisms/DailyRewards.vue'
import AdRewardButton from '@/components/organisms/AdRewardButton.vue'
import BattlePass from '@/components/organisms/BattlePass.vue'
import AchievementsButton from '@/components/organisms/AchievementsButton.vue'
import OptionsModal from '@/components/organisms/OptionsModal.vue'
import EpicUpgradesModal from '@/components/organisms/EpicUpgradesModal.vue'
import SkinModal from '@/components/organisms/SkinModal.vue'
import MissionsModal from '@/components/organisms/MissionsModal.vue'
import IconCoin from '@/components/icons/IconCoin.vue'
import IconMovie from '@/components/icons/IconMovie.vue'

const { t } = useI18n()
const epic = useEpicGame()
const {
  phase, score, gameResult, lossCause, coinsThisRun, itemsThisRun, lastWinReward,
  stageTarget, resetForStage, begin, flip, step, revive
} = epic
const progress = useEpicProgress()
const { recordRun } = useMissions()
const { recordRun: recordAchievementRun } = useAchievements()
const { addCoins } = useEpicConfig()
const { awardCampaignWin } = useBattlePass()
const { startBattleMusic, stopBattleMusic } = useMusic()
const { playSound } = useSounds()
const { shakeStyle } = useScreenshake()

// The result overlay's single-column (non-mobile) layout overflows on a short
// viewport — e.g. the game in a portal iframe on a Chromebook (~764×385),
// where the full-size title + tiles line + bottom-anchored continue hint
// collide and clip the reward button. On those viewports we shrink the title,
// drop the tiles line, and tighten the gaps. Mobile landscape keeps its own
// purpose-built 2-column layout (isMobileLandscape), so this is scoped to the
// non-mobile short case only.
const isShortResult = computed(() => isShortViewport.value && !isMobileLandscape.value)

// ─── Canvas + render loop ─────────────────────────────────────────────────
const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let rafId = 0
let lastT = 0
let cssW = 0
let cssH = 0

const resize = (): void => {
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  cssW = window.innerWidth
  cssH = window.innerHeight
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  canvas.style.width = cssW + 'px'
  canvas.style.height = cssH + 'px'
  ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  configureGeometry(cssW, cssH)
}

const loop = (t: number): void => {
  rafId = requestAnimationFrame(loop)
  const dt = lastT ? Math.min(t - lastT, 60) : 16
  lastT = t
  if (!isGamePaused.value && phase.value === 'playing') step(dt)
  else step(0) // keep render position fresh without advancing the clock
  if (ctx) drawScene(ctx, cssW, cssH, performance.now())
}

// ─── Input ────────────────────────────────────────────────────────────────
// First click-to-start of the session routes through here. On GameMonetize /
// GameDistribution it shows the moderation-mandated first-play interstitial
// BEFORE the run (and its music) begins — `playFirstStartInterstitial` hard-
// stops audio and resolves only on the ad's close/no-fill, then `begin()` starts
// the run and the phase watcher starts battle music fresh. The `startingRun`
// guard stops a second tap during the ad from kicking the run off underneath it.
// No-op fast-path on every other build / subsequent start (the helper returns
// immediately), so non-GM/GD starts feel instant.
let startingRun = false
const startRun = async (): Promise<void> => {
  if (startingRun || phase.value !== 'idle') return
  startingRun = true
  try {
    await playFirstStartInterstitial()
    if (phase.value === 'idle') begin()
  } finally {
    startingRun = false
  }
}
const onPointerDown = (e: PointerEvent): void => {
  // Claim keyboard focus on the pointer gesture. In a portal iframe
  // (GameMonetize / Playgama / itch) the iframe's window does NOT hold keyboard
  // focus on load — keystrokes go to the parent document. Clicking inside the
  // frame normally focuses it, but the `e.preventDefault()` below (needed to
  // suppress touch-scroll / selection on the `touch-none` canvas) ALSO cancels
  // that implicit focus transfer. Without this, a player who STARTS the run by
  // tapping/clicking never gives the frame focus, so Space/ArrowUp never reach
  // the window keydown listener and the ball can't be controlled — while
  // starting the run with Space works (the frame already had focus). Reclaim it
  // explicitly; `window.focus()` on a user gesture is a no-op when already
  // focused and safe on the top-level window too.
  try { window.focus() } catch { /* cross-origin parent can refuse — ignore */ }
  e.preventDefault()
  if (showResult.value || showSecondChance.value) return
  if (phase.value === 'idle') void startRun()
  else if (phase.value === 'playing') flip()
}
const onKey = (e: KeyboardEvent): void => {
  if (e.code !== 'Space' && e.code !== 'ArrowUp' && e.code !== 'Enter') return
  // Ignore OS key-repeat: a held key must not fire a flip on every repeat tick.
  if (e.repeat) return
  const tgt = e.target
  if (tgt instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tgt.tagName)) return
  e.preventDefault()
  if (showResult.value || showSecondChance.value) return
  if (phase.value === 'idle') void startRun()
  else if (phase.value === 'playing') flip()
}

// ─── HUD state ──────────────────────────────────────────────────────────────
const showOptions = ref(false)
const showUpgrades = ref(false)
const showSkins = ref(false)
const showResult = ref(false)
const showSecondChance = ref(false)
const showBoon = ref(false)
const isAdInFlight = ref(false)
// First-run-of-day 2× offer (roadmap #5): true while the current result screen
// is the player's first finished run today, until it's consumed on continue.
const firstRunBonusActive = ref(false)
const isEndless = computed(() => gameMode.value === 'endless')

// HUD score number. Endless has no goal → show tiles travelled (counts up).
// Campaign counts DOWN the tiles left to clear the stage, so the finish line is
// foreseeable instead of the run ending abruptly at an unknown distance.
const displayScore = computed(() => {
  if (isEndless.value) return score.value
  const left = Math.ceil(stageTarget.value - score.value)
  return Number.isFinite(left) ? Math.max(0, left) : score.value
})

// ─── Upgrade spotlight (roadmap #16) ────────────────────────────────────────
// The first time the player can afford ANY upgrade — and only on the menu/idle
// screen — pulse the Upgrades button to teach the coin→power loop. One-shot,
// gated on a persisted flag; cleared the moment they open the modal.
const upgradeSpotlightSeen = ref(getState<boolean>(UPGRADE_SPOTLIGHT_KEY, false) === true)
const canAffordAnyUpgrade = computed(() =>
  UPGRADES.some((u) => progress.isUnlocked(u.id) && progress.canBuy(u.id))
)
const showUpgradeSpotlight = computed(() =>
  !upgradeSpotlightSeen.value && phase.value === 'idle' && !showUpgrades.value && canAffordAnyUpgrade.value
)
const openUpgrades = (): void => {
  showUpgrades.value = true
  if (!upgradeSpotlightSeen.value) {
    upgradeSpotlightSeen.value = true
    setState(UPGRADE_SPOTLIGHT_KEY, true)
  }
}
const coinBadgeRef = ref<InstanceType<typeof CoinBadge> | null>(null)
const coinBadgeEl = computed<HTMLElement | null>(() => coinBadgeRef.value?.rootEl ?? null)

const bannerFraction = ref(0)
let bannerTimer = 0

// Show the "tap/click to change direction" reminder only on the first two
// campaign stages — by stage 3 the player has the controls down, so hide it to
// keep the playfield clean. (Endless is post-campaign, so never show it there.)
const showHint = computed(() =>
  phase.value === 'playing' && !isEndless.value && progress.stage.value < 3
)
const hintText = computed(() => isMobilePortrait.value ? t('hints.tapToTurn') : t('hints.clickToTurn'))
const startText = computed(() => isMobilePortrait.value ? t('startTouch') : t('startDesktop'))

// 2× reward button cooldown (30s after use), shared across win + lose screens.
const SECOND_CHANCE_COOLDOWN = 30_000
const TWO_X_COOLDOWN = 30_000
let lastSecondChanceAt = 0
let twoXReadyAt = 0
const twoXUsed = ref(false)
const tickNow = ref(Date.now())

const runTotalCoins = computed(() => coinsThisRun.value + (gameResult.value === 'win' ? lastWinReward.value : 0))
const twoXAvailable = computed(() =>
  !twoXUsed.value && isRewardedReady.value && runTotalCoins.value > 0 &&
  (firstRunBonusActive.value || tickNow.value >= twoXReadyAt)
)
const secondChanceEligible = (): boolean =>
  isRewardedReady.value && Date.now() - lastSecondChanceAt > SECOND_CHANCE_COOLDOWN

const todayKey = (): string => new Date().toISOString().slice(0, 10)
// Feed the finished run into daily missions and decide whether the first-run-of-
// day 2× bonus applies to this result screen (roadmap #2 + #5).
const finishRun = (cleared: boolean): void => {
  const run = { tiles: score.value, coins: coinsThisRun.value, items: itemsThisRun.value, cleared }
  recordRun(run)
  recordAchievementRun(run) // lifetime milestone counters (roadmap #13)
  firstRunBonusActive.value = getState<string>(DAILY_BONUS_DAY_KEY, '') !== todayKey()
}

// Near-miss "Almost!" line (roadmap #2): on a campaign loss, how many tiles the
// player was short of the goal — shown only when they were genuinely close.
const nearMissTiles = computed(() => {
  if (gameResult.value !== 'lose' || isEndless.value) return 0
  const needed = Math.ceil(stageTarget.value - score.value)
  return needed > 0 && needed <= 10 ? needed : 0
})

// Instant one-tap retry (roadmap #3): skip the close/reopen dance — drop both
// post-run modals and start a fresh attempt immediately.
const retry = (): void => {
  if (isAdInFlight.value) return
  showResult.value = false
  showSecondChance.value = false
  showBoon.value = false
  // Fresh attempt — the run's collected coins are forfeited (no grantRunCoins /
  // CoinExplosion) and we never route through the win/lose screen.
  resetForStage()
  begin()
  startBattleMusic() // onDeath stopped it; bring the battle track back
}

// ─── Result / death / win flow ──────────────────────────────────────────────
const onDeath = async (): Promise<void> => {
  stopBattleMusic()
  await wait(450)
  if (phase.value !== 'dead') return // revived already (shouldn't happen here)
  if (secondChanceEligible()) {
    lastSecondChanceAt = Date.now()
    showSecondChance.value = true
  } else {
    void presentLoseScreen()
  }
}

const onAcceptContinue = async (): Promise<void> => {
  if (isAdInFlight.value) return
  isAdInFlight.value = true
  showSecondChance.value = false
  try {
    const ok = await showRewardedAd()
    if (ok) {
      revive()
      startBattleMusic()
    } else {
      await presentLoseScreen()
    }
  } finally {
    isAdInFlight.value = false
  }
}

const onSkipContinue = (): void => {
  showSecondChance.value = false
  void presentLoseScreen()
}

// Interstitial delay (ms) after the win/lose result screen appears, before the
// ad is requested — gives the result stinger a beat to land first. The ad call
// flips `isAdShowing`, which the universal pause gate (`useGamePauseAudio`)
// turns into a synchronous full audio suspend (bg-music + every SFX), and the
// gate drops — resuming audio — only after the ad finishes / fails / no-fills.
const RESULT_INTERSTITIAL_DELAY_MS = 600

// Lose-screen interstitial cadence: fire on every Nth lose only. Wins always
// request one (the high-value, low-frequency placement); loses are frequent,
// so spamming the ad network on every defeat just burns its internal
// frequency-cap quota and starves the win ads. Throttling loses to 1-in-3
// leaves headroom for the win interstitial to actually fill.
const LOSE_AD_EVERY = 2
let loseScreenCount = 0

/** Show a result-screen interstitial after the standard delay. Always requests
 *  when the provider's SDK is live — `showMidgameAd` is a safe no-op on
 *  no-fill / cooldown, and the readiness gate keeps non-ad builds (Noop /
 *  native) from needlessly suspending audio for an ad that never shows. */
const presentResultInterstitial = async (): Promise<void> => {
  await wait(RESULT_INTERSTITIAL_DELAY_MS)
  if (isInterstitialReady.value) {
    await showMidgameAd()
  }
}

const presentLoseScreen = async (): Promise<void> => {
  twoXUsed.value = false
  finishRun(false)
  // Keep the bg music silent for the whole result screen — it resumes only when
  // the player continues (onResultContinue).
  stopBattleMusic()
  // Play the auto-midgame interstitial FIRST — before the lose screen is
  // revealed — mirroring the win flow (onWin). Showing the result first made it
  // flash on-screen for the pre-ad beat and then had its Game-Over sting cut off
  // the instant the ad opened over it (CG QA). Every 3rd lose only (see
  // LOSE_AD_EVERY); wins always request one. Gate the reveal behind the ad only
  // when one is actually ready, so non-ad builds (Noop / native, no-fill) fall
  // straight through with no extra delay.
  loseScreenCount += 1
  if (loseScreenCount % LOSE_AD_EVERY === 0 && isInterstitialReady.value) {
    await presentResultInterstitial()
  }
  // Game-Over sting as the lose screen appears (distinct from the crash SFX) —
  // now AFTER the ad, so it can't be cut off.
  playSound('lose', 0.08)
  showResult.value = true
  void grantRunCoins()
}

const onWin = async (): Promise<void> => {
  awardCampaignWin()
  twoXUsed.value = false
  finishRun(true)
  // Silence the bg music while the post-run screens are up (SFX still play).
  stopBattleMusic()
  // Play the auto-midgame interstitial FIRST — before the Stage Clear screen.
  // Showing the result first made it flash on-screen for the pre-ad beat and
  // then had its win sting cut off the instant the ad opened over it (CG QA).
  // Gate the reveal behind the ad only when one is actually ready; non-ad
  // builds (Noop / native, no-fill) fall straight through with no extra delay.
  if (isInterstitialReady.value) {
    await presentResultInterstitial()
  }
  // Win stinger now plays with the result reveal — after the ad, so it can't be
  // cut off. On a campaign clear the boon picker comes AFTER the player
  // continues, before the next stage (onResultContinue).
  playSound('happy', 0.08)
  playSound('celebration-3', 0.08)
  showResult.value = true
  void grantRunCoins()
}

const onTwoX = async (): Promise<void> => {
  if (isAdInFlight.value || !twoXAvailable.value) return
  isAdInFlight.value = true
  try {
    const bonus = runTotalCoins.value
    const ok = await showRewardedAd()
    if (ok) {
      addCoins(bonus)
      twoXUsed.value = true
      twoXReadyAt = Date.now() + TWO_X_COOLDOWN
      const el = rewardCoinRef.value
      if (el && coinBadgeEl.value) spawnCoinExplosion({ sourceEl: el, targetEl: coinBadgeEl.value, count: 26 })
    }
  } finally {
    isAdInFlight.value = false
  }
}

const rewardCoinRef = ref<HTMLElement | null>(null)

// Bank the run's coins (collected + win reward) to the wallet only now, on the
// result screen, and fly them into the CoinBadge with a CoinExplosion. The 2×
// rewarded button (onTwoX) banks a second copy on top to double them.
const grantRunCoins = async (): Promise<void> => {
  const total = runTotalCoins.value
  if (total <= 0) return
  addCoins(total)
  await nextTick()
  const el = rewardCoinRef.value
  if (el && coinBadgeEl.value) {
    spawnCoinExplosion({ sourceEl: el, targetEl: coinBadgeEl.value, count: Math.min(40, 12 + Math.round(total / 4)) })
  }
}

// Consume the first-run-of-day bonus when the player leaves the result screen,
// so the 2× offer is one-shot per day regardless of whether they watched it.
const consumeFirstRunBonus = (): void => {
  if (!firstRunBonusActive.value) return
  firstRunBonusActive.value = false
  setState(DAILY_BONUS_DAY_KEY, todayKey())
}

const onResultContinue = (): void => {
  if (isAdInFlight.value) return
  showResult.value = false
  consumeFirstRunBonus()
  // Campaign clear: NOW offer the pick-1-of-3 boon — after the win screen, before
  // the next stage starts. Losses and endless runs skip straight to the next run.
  if (gameResult.value === 'win' && !isEndless.value) {
    showBoon.value = true
    return
  }
  resetForStage()
  startBattleMusic()
}

// Boon picked on a campaign clear: stash it for the next stage, then set up that
// stage (resetForStage consumes the pending boon); the player taps to start it.
const onChooseBoon = (boon: BoonId): void => {
  setPendingBoon(boon)
  showBoon.value = false
  resetForStage()
  startBattleMusic()
}

const toggleEndless = (): void => {
  setGameMode(isEndless.value ? 'campaign' : 'endless')
  resetForStage()
}

// The three stage-clear boons offered by the picker (roadmap #13).
const boonOptions: BoonId[] = ['secondChance', 'startPowerup', 'coinBoost']

const fireCoinExplosion = (sourceEl: HTMLElement): void => {
  if (coinBadgeEl.value) spawnCoinExplosion({ sourceEl, targetEl: coinBadgeEl.value })
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

watch(phase, (p, prev) => {
  if (p === 'playing' && prev !== 'playing') startBattleMusic()
  if (p === 'dead' && prev === 'playing') void onDeath()
  if (p === 'won' && prev === 'playing') void onWin()
})

// ─── CrazyGames gameplay lifecycle (single source of truth) ──────────────────
//
// Per the CG SDK rules: call `gameplayStart()` "whenever the player starts
// playing or resumes playing after a break (game start, resume, revive, enter
// next level)" and `gameplayStop()` "on every game break (entering a menu,
// ending level, pausing the game)". CG ALSO states: do NOT call gameplayStop
// when the player switches focus / leaves the game area — the platform handles
// that automatically. So the signal is deliberately NOT tied to the full
// `isGamePaused` gate (which OR's in tab-visibility + platform pause); it tracks
// only the breaks WE own: the run is live (`playing`) and no blocking modal /
// menu is open. Driving both calls off one computed covers every transition
// for free and can never desync:
//   • start — run begins, a revive flips `dead → playing`, the next stage
//              starts, or the last menu/modal closes during a live run.
//   • stop  — win/lose result screen (phase leaves `playing`) or a menu opens.
// Ad breaks are handled separately inside `useCrazyGames`' ad wrappers (they
// stop/resume gameplay around the video, as CG recommends). Both SDK calls are
// idempotent and no-op on non-CG builds, so this is safe to run unconditionally.
// Replaces the old phase-only driver + the per-modal `stopGameplay()` calls
// (which stopped but never restarted).
const isLiveGameplay = computed(
  () => phase.value === 'playing' && !isAnyModalOpen.value
)
watch(isLiveGameplay, (live) => {
  if (live) startGameplay()
  else stopGameplay()
}, { immediate: true })

// Push the equipped ball skin to the renderer now and whenever it changes
// (buying/equipping in the SkinModal). `setBallSkin` invalidates the decoded
// texture so the next frame re-samples from the new skin.
watch(selectedSkinSrc, (src) => setBallSkin(prependBaseUrl(src)), { immediate: true })

// Keep the renderer's best-tile ghost line (roadmap #2) in sync with the
// personal best, so the "line to beat" is always drawn at the right row.
watch(() => progress.bestScore.value, (v) => setGhostBest(v), { immediate: true })

// ─── Lifecycle ──────────────────────────────────────────────────────────────
onMounted(() => {
  resetForStage()
  nextTick(resize)
  window.addEventListener('resize', resize)
  window.addEventListener('keydown', onKey)
  rafId = requestAnimationFrame(loop)
  bannerTimer = window.setInterval(() => {
    bannerFraction.value = powerupFraction(epic.clock())
    tickNow.value = Date.now()
  }, 100)
})
onUnmounted(() => {
  cancelAnimationFrame(rafId)
  window.removeEventListener('resize', resize)
  window.removeEventListener('keydown', onKey)
  clearInterval(bannerTimer)
  stopBattleMusic()
})
</script>

<template lang="pug">
  div.epic-arena.relative.w-screen.overflow-hidden(class="h-screen h-dvh bg-[#0a1224]")
    canvas(
      ref="canvasRef"
      class="block touch-none absolute inset-0"
      :style="shakeStyle"
      @pointerdown="onPointerDown"
      @contextmenu.prevent
    )

    //- HUD overlay (non-interactive except where re-enabled)
    div.absolute.inset-0.pointer-events-none
      //- Top bar: StageBadge (left) + CoinBadge (right)
      div.flex.justify-between.items-start(
        class="p-2"
        :style="{\
          paddingTop: 'calc(0.5rem + env(safe-area-inset-top, 0px))',\
          paddingLeft: 'calc(0.5rem + env(safe-area-inset-left, 0px))',\
          paddingRight: 'calc(0.5rem + env(safe-area-inset-right, 0px))'\
        }"
      )
        StageBadge(
          :stage-id="progress.stage.value"
          :cleared="score"
          :target="stageTarget"
          :endless="isEndless"
        )
        //- Right column: coin badge with the idle-reward treasure chest tucked
        //- directly beneath it. The chest's coin-explosion VFX flies to the coin
        //- badge element (`coinBadgeEl`). `gap-4` leaves room for the chest's
        //- `-bottom-4` countdown/reward label.
        div.flex.flex-col.items-end.gap-4
          CoinBadge(ref="coinBadgeRef")
          TreasureChest(:target-el="coinBadgeEl")

      //- Center-top stack: big score, then the combo multiplier, then the Racer
      //- banner — all in ONE flex column so the combo/racer always sit directly
      //- under the (variable-height) score with a fixed gap, never overlapping it
      //- regardless of how the score scales across viewports. The combo is white
      //- → orange at 2× → golden at the 3× cap (roadmap #6).
      div.absolute.left-0.right-0.flex.flex-col.items-center.z-10(
        class="z-[5]"
        :style="{ top: 'calc(3.2rem + env(safe-area-inset-top, 0px))' }"
      )
        ScoreBadge(v-if="(phase === 'playing' || phase === 'dead') && !exitingActive" :score="displayScore")
        div.pointer-events-none.font-black.game-text.italic.animate-pulse(
          v-show="phase === 'playing' && combo > 1.05 && !exitingActive"
          :class="isMobileLandscape ? 'text-base mt-0.5' : 'text-xl sm:text-3xl mt-1'"
          :style="{ color: combo >= 3 ? '#ffd23c' : (combo >= 2 ? '#ff9a3c' : '#ffffff'), textShadow: '2px 2px 0 #000' }"
        ) ×{{ combo.toFixed(2) }}
        div.pointer-events-none.font-black.game-text.italic.uppercase.tracking-widest.animate-pulse(
          v-show="racerActive"
          :class="isMobileLandscape ? 'text-lg mt-0.5' : 'text-2xl sm:text-4xl mt-1'"
          :style="{ color: '#ff3df0', textShadow: '2px 2px 0 #000' }"
        ) {{ t('powerups.racer') }}

      //- Tap-to-start prompt
      div.absolute.inset-0.flex.items-center.justify-center.z-10(
        v-if="phase === 'idle'"
        class="pointer-events-none"
      )
        div.text-center
          //- Mode toggle (campaign ⇄ endless) sits ABOVE the "Tap to Start"
          //- label so it's clear of the screen centre where the player taps to
          //- begin — avoids accidental mode switches. Endless shows the best.
          div.mb-4.flex.flex-col.items-center.gap-1.pointer-events-auto
            button.cursor-pointer.transition-transform.rounded-lg.border-2.px-4.py-1.font-black.uppercase.game-text.text-white(
              class="hover:scale-[103%] active:scale-95 bg-gradient-to-b from-[#50aaff] to-[#2266ff] border-[#0f1a30] text-sm"
              @click.stop="toggleEndless"
            ) {{ isEndless ? t('endless.toCampaign') : t('endless.toEndless') }}
            div.text-yellow-200.game-text(v-if="isEndless" class="text-xs opacity-80") {{ t('endless.best', { n: bestEndless }) }}
          div.text-white.font-black.uppercase.tracking-wider.animate-pulse.game-text(
            class="text-3xl sm:text-5xl mb-2"
          ) {{ startText }}
          //- The "roll upward / change direction" primer only helps brand-new
          //- players — drop it from stage 3 on (and in endless), same as the
          //- in-run control hint.
          div.text-white.italic.game-text(
            v-if="!isEndless && progress.stage.value < 3"
            class="text-sm sm:text-lg opacity-60"
          ) {{ t('startSubhint') }}

      //- "Tap/Click to change direction" hint (just below the score)
      Transition(name="fade")
        div.absolute.left-0.right-0.flex.justify-center.z-10(
          v-if="showHint"
          :style="{ top: 'calc(8.5rem + env(safe-area-inset-top, 0px))' }"
        )
          div.text-white.italic.game-text.opacity-70(class="text-xs sm:text-sm px-3 py-1 rounded-full bg-black/30") {{ hintText }}

      //- Active power-up banner (bottom-center, above the button rows)
      div.absolute.left-0.right-0.flex.justify-center(
        :style="{ bottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }"
      )
        PowerupBanner(:fraction="bannerFraction")

      //- Bottom-left: mute + settings + meta buttons
      div.absolute.pointer-events-auto.z-50.flex.flex-col.items-start.gap-1(
        :style="{\
          bottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',\
          left: 'calc(0.5rem + env(safe-area-inset-left, 0px))'\
        }"
      )
        FMuteButton
        //- Settings + the meta-button row are hidden DURING a run so they don't
        //- distract or get tapped by accident; `scale-80 sm:scale-100` matches
        //- the DailyRewards button footprint for a uniform row.
        button.cursor-pointer.transition-transform.mb-1(
          v-show="phase !== 'playing'"
          class="hover:scale-[103%] active:scale-90 scale-80 sm:scale-100"
          @click="showOptions = true"
        )
          div.relative
            div.absolute.inset-0.translate-y-1.rounded-lg(class="bg-[#102e7a]")
            div.relative.rounded-lg.border-2.flex.items-center.justify-center.p-2(
              class="bg-gradient-to-b from-[#50aaff] to-[#2266ff] border-[#0f1a30]"
            )
              svg(viewBox="0 0 24 24" class="w-7 h-7 text-white" fill="currentColor")
                path(d="M12 4 a1 1 0 0 1 1 1 v1.6 a6 6 0 0 1 1.8 0.7 l1.1 -1.1 a1 1 0 0 1 1.4 1.4 l -1.1 1.1 a6 6 0 0 1 0.7 1.8 H18 a1 1 0 1 1 0 2 h-1.6 a6 6 0 0 1 -0.7 1.8 l1.1 1.1 a1 1 0 0 1 -1.4 1.4 l-1.1 -1.1 a6 6 0 0 1 -1.8 0.7 V18 a1 1 0 1 1 -2 0 v -1.6 a6 6 0 0 1 -1.8 -0.7 l-1.1 1.1 a1 1 0 0 1 -1.4 -1.4 l1.1 -1.1 a6 6 0 0 1 -0.7 -1.8 H6 a1 1 0 1 1 0 -2 h1.6 a6 6 0 0 1 0.7 -1.8 L7.2 7.6 a1 1 0 0 1 1.4 -1.4 l1.1 1.1 a6 6 0 0 1 1.8 -0.7 V5 a1 1 0 0 1 1 -1 Z M12 9 a3 3 0 1 0 0 6 a3 3 0 0 0 0 -6 Z")
        div.flex.items-end(v-show="phase !== 'playing'" class="gap-0 sm:gap-2")
          DailyRewards(@coins-awarded="fireCoinExplosion")
          MissionsModal(@coins-awarded="fireCoinExplosion")
          AchievementsButton(@coins-awarded="fireCoinExplosion")
          AdRewardButton(@coins-awarded="fireCoinExplosion")
          BattlePass(@coins-awarded="fireCoinExplosion")

      //- Bottom-right: upgrades + skins. Hidden during a run (no distraction /
      //- accidental modal opens); buttons scaled to match the DailyRewards size.
      div.absolute.pointer-events-auto.z-50.flex.flex-col.items-end.gap-2(
        v-show="phase !== 'playing'"
        :style="{\
          bottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',\
          right: 'calc(0.5rem + env(safe-area-inset-right, 0px))'\
        }"
      )
        //- Upgrades. Spotlit (pulsing ring + "Spend!" tag) the first time the
        //- player can afford an upgrade on the menu screen (roadmap #16).
        div.relative
          //- One-time spotlight hint floating left of the button.
          //- NOTE: slash utilities (top-1/2, -translate-y-1/2) MUST live in
          //- class="" — Pug treats a slash in dot-class shorthand as a parse
          //- break and dumps the rest of the tag out as literal text.
          div.absolute.right-full.mr-2.whitespace-nowrap.rounded-lg.border-2.px-2.py-1.font-black.uppercase.game-text.text-white.animate-pulse(
            v-if="showUpgradeSpotlight"
            class="top-1/2 -translate-y-1/2 bg-gradient-to-b from-[#ffcd00] to-[#f7a000] border-[#0f1a30] text-[10px]"
          ) {{ t('upgrades.spotlight') }} →
          button.cursor-pointer.transition-transform(
            class="hover:scale-[103%] active:scale-90 scale-80 sm:scale-100"
            :class="showUpgradeSpotlight ? 'animate-pulse' : ''"
            @click="openUpgrades"
          )
            div.relative
              div.absolute.inset-0.translate-y-1.rounded-lg(class="bg-[#102e7a]")
              div.relative.rounded-lg.border-2.flex.items-center.justify-center.p-2(
                class="bg-gradient-to-b from-[#50aaff] to-[#2266ff]"
                :class="showUpgradeSpotlight ? 'border-yellow-300 ring-4 ring-yellow-300/70' : 'border-[#0f1a30]'"
              )
                svg(viewBox="0 0 24 24" class="w-7 h-7 text-white" fill="currentColor")
                  path(d="M4 14 L12 6 L20 14 H15 V20 H9 V14 Z" stroke="black" stroke-width="0.8")
        //- Skins shop
        button.cursor-pointer.transition-transform(
          class="hover:scale-[103%] active:scale-90 scale-80 sm:scale-100"
          @click="showSkins = true"
        )
          div.relative
            div.absolute.inset-0.translate-y-1.rounded-lg(class="bg-[#102e7a]")
            div.relative.rounded-lg.border-2.flex.items-center.justify-center.p-2(
              class="bg-gradient-to-b from-[#50aaff] to-[#2266ff] border-[#0f1a30]"
            )
              //- T-shirt / wardrobe glyph for the cosmetics shop.
              svg(viewBox="0 0 24 24" class="w-7 h-7 text-white" fill="currentColor")
                path(d="M8 3 L5 6 L3 9 L6 11 L7 10 V20 H17 V10 L18 11 L21 9 L19 6 L16 3 L14 5 a2.2 2.2 0 0 1 -4 0 Z" stroke="black" stroke-width="0.8")

    //- Second-chance overlay (watch ad & continue / skip)
    Transition(name="fade")
      div.fixed.inset-0.flex.items-center.justify-center.backdrop-blur-md.p-4(
        v-if="showSecondChance"
        class="z-[110] bg-black/70"
        :style="{\
          paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))',\
          paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))'\
        }"
      )
        div.flex.flex-col.items-center.gap-4.rounded-2xl.border-2.shadow-2xl(
          class="bg-gradient-to-b from-[#1a1f3a] to-[#0a0e22] border-yellow-300 px-6 py-5 max-w-sm"
        )
          div.font-black.uppercase.tracking-wider.game-text.text-yellow-300(class="text-2xl sm:text-3xl") {{ t('secondChance.title') }}
          div.text-white.game-text.text-center.opacity-80(class="text-sm sm:text-base") {{ t('secondChance.body') }}
          button.cursor-pointer.transition-transform.flex.items-center.justify-center.gap-2(
            class="w-full px-4 py-2 rounded-lg bg-gradient-to-b from-emerald-400 to-emerald-700 border-2 border-emerald-200 text-white font-black uppercase game-text hover:scale-[103%] active:scale-95 disabled:opacity-50 disabled:cursor-wait"
            :disabled="isAdInFlight"
            @click="onAcceptContinue"
          )
            IconMovie(class="w-5 h-5 shrink-0")
            span {{ t('secondChance.watch') }}
          //- Retry: abandon this run and restart the stage immediately. Does
          //- NOT bank the run's coins (no reward / CoinExplosion) and never
          //- routes through the win/lose screen — it's a clean fresh attempt.
          button.cursor-pointer.transition-transform.flex.items-center.justify-center.gap-2(
            class="w-full px-4 py-2 rounded-lg bg-gradient-to-b from-emerald-400 to-emerald-700 border-2 border-emerald-200 text-white font-black uppercase game-text hover:scale-[103%] active:scale-95 disabled:opacity-50"
            :disabled="isAdInFlight"
            @click="retry"
          )
            svg(viewBox="0 0 24 24" class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round")
              path(d="M3 12 a9 9 0 1 0 3 -6.7 L3 8")
              path(d="M3 4 v4 h4")
            span {{ t('result.retry') }}
          button.cursor-pointer.transition-transform(
            class="w-full px-4 py-2 rounded-lg bg-slate-700 border-2 border-slate-500 text-white font-bold uppercase game-text hover:scale-[103%] active:scale-95 disabled:opacity-50"
            :disabled="isAdInFlight"
            @click="onSkipContinue"
          ) {{ t('secondChance.skip') }}

    //- Win / Lose result overlay
    FReward(
      v-model="showResult"
      :show-continue="!isAdInFlight"
      @continue="onResultContinue"
    )
      template(#ribbon)
        span.text-white.font-black.uppercase.italic.game-text(class="sm:text-2xl") {{ t('rewards') }}
      //- Result body. Landscape mobile uses a 2-column layout (title/message +
      //- tiles on the left, coins + 2× button on the right) with smaller type so
      //- nothing overlaps in the short viewport; portrait/desktop stay a single
      //- centred column.
      div(
        :class="[ \
          isMobileLandscape \
            ? 'grid grid-cols-2 items-center gap-x-6 gap-y-1 px-2' \
            : 'flex flex-col items-center', \
          { 'gap-2': !isMobileLandscape && isShortResult, 'gap-4': !isMobileLandscape && !isShortResult } \
        ]"
      )
        //- ── Left column (landscape) / top (portrait): outcome + tiles ──
        div.flex.flex-col.items-center(:class="isMobileLandscape ? 'gap-1' : 'gap-4 contents'")
          div.font-black.uppercase.tracking-wider.game-text(
            class="text-3xl sm:text-5xl"
            :class="[gameResult === 'win' ? 'text-green-400' : 'text-red-400', { '!text-2xl': isMobileLandscape, '!text-3xl': isShortResult }]"
          ) {{ gameResult === 'win' ? t('result.win') : t('result.lose') }}
          div.text-white.game-text.text-center.opacity-80(
            v-if="gameResult === 'lose'"
            class="text-sm sm:text-base"
            :class="{ '!text-xs leading-tight': isMobileLandscape }"
          ) {{ lossCause === 'hole' ? t('result.fell') : t('result.crashed') }}
          //- "Almost!" near-miss nudge — only when the player was genuinely close.
          div.text-yellow-200.game-text.text-center.font-black.animate-pulse(
            v-if="nearMissTiles > 0"
            class="text-sm sm:text-base"
            :class="{ '!text-xs leading-tight': isMobileLandscape }"
          ) {{ t('result.almost', { n: nearMissTiles }) }}
          //- Tiles travelled this run. Hidden on short single-column viewports
          //- (e.g. Chromebook iframe ~764×385) where every row counts toward
          //- keeping the reward button on-screen.
          div.flex.items-center.gap-2.text-white.game-text(
            v-if="!isShortResult"
            class="text-base sm:text-lg"
          )
            span.opacity-70.uppercase.tracking-wider.text-xs {{ t('result.tiles') }}
            span.font-black.text-yellow-200(class="text-xl sm:text-2xl" :class="{ '!text-lg': isMobileLandscape }") {{ score }}
        //- ── Right column (landscape) / continues below (portrait): coins + 2× ──
        div.flex.flex-col.items-center(:class="isMobileLandscape ? 'gap-1' : 'gap-4 contents'")
          //- Coins collected (+ win reward)
          div.flex.flex-col.items-center.gap-1(ref="rewardCoinRef")
            div.flex.items-center.gap-3
              IconCoin(:class="isMobileLandscape ? 'w-6 h-6 text-yellow-300' : 'w-8 h-8 text-yellow-300'")
              span.text-yellow-400.font-black.game-text(class="text-2xl sm:text-4xl" :class="{ '!text-2xl': isMobileLandscape }") +{{ runTotalCoins }}
            div.text-white.game-text.opacity-70(v-if="gameResult === 'win'" class="text-xs") {{ t('result.winReward', { n: lastWinReward }) }}
          //- 2× rewarded button
          button.cursor-pointer.transition-transform.flex.items-center.justify-center.gap-2(
            v-if="twoXAvailable"
            class="rounded-xl bg-gradient-to-b from-[#ffcd00] to-[#f7a000] border-2 border-[#0f1a30] text-white font-black uppercase game-text hover:scale-[103%] active:scale-95 disabled:opacity-50"
            :class="isMobileLandscape ? 'px-4 py-1.5 text-xs' : 'px-5 py-2'"
            :disabled="isAdInFlight"
            @click="onTwoX"
          )
            IconMovie(class="w-5 h-5 shrink-0")
            span {{ firstRunBonusActive ? t('result.firstRunDouble') : t('result.double') }}

    //- Stage-clear boon picker (roadmap #13): pick one of three for next stage.
    Transition(name="fade")
      div.fixed.inset-0.flex.items-center.justify-center.backdrop-blur-md.p-4(
        v-if="showBoon"
        class="z-[110] bg-black/70"
        :style="{\
          paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))',\
          paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))'\
        }"
      )
        div.flex.flex-col.items-center.gap-4.rounded-2xl.border-2.shadow-2xl(
          class="bg-gradient-to-b from-[#1a1f3a] to-[#0a0e22] border-yellow-300 px-6 py-5 max-w-sm w-full"
        )
          div.font-black.uppercase.tracking-wider.game-text.text-yellow-300(class="text-2xl sm:text-3xl") {{ t('boon.title') }}
          div.flex.flex-col.gap-2.w-full
            button.cursor-pointer.transition-transform.flex.flex-col.items-start.rounded-xl.border-2.px-4.py-2.text-left(
              v-for="b in boonOptions"
              :key="b"
              class="gap-0.5 bg-black/30 border-white/15 hover:scale-[102%] active:scale-95 hover:border-yellow-300"
              @click="onChooseBoon(b)"
            )
              span.font-black.game-text.text-white(class="text-sm sm:text-base") {{ t('boon.names.' + b) }}
              span.text-white.game-text.opacity-70.leading-tight(class="text-[10px] sm:text-xs") {{ t('boon.descriptions.' + b) }}

    OptionsModal(:is-open="showOptions" @close="showOptions = false")
    EpicUpgradesModal(v-model="showUpgrades")
    SkinModal(v-model="showSkins")
</template>

<style scoped lang="sass">
.fade-enter-active, .fade-leave-active
  transition: opacity 0.3s ease
.fade-enter-from, .fade-leave-to
  opacity: 0
</style>
