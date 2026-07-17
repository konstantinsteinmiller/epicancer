<script setup lang="ts">
// ─── The scene shell ───────────────────────────────────────────────────────
//
// The one mounted view. It owns the canvas, normalises input, and drives the
// run orchestrator — but contains no game logic of its own. Everything visible
// is drawn into the ink layer; the only DOM here is the canvas itself, which
// is what keeps the "it's all one drawing" illusion intact (no crisp HTML
// buttons floating over boiling pen strokes).
//
// The game starts straight into the first scene with no main menu (GDD
// §General).
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInkCanvas } from '@/use/ink/useInkCanvas'
import { drawPaper } from '@/use/ink/paper'
import {
  installInkAudioGate, bassThump, chime, sourBuzz, stopAllInkLoops, tick,
  inkDrop, rainAmbience, penClick, type Loop
} from '@/use/ink/useInkAudio'
import { useMidnightGame } from '@/use/midnight/useMidnightGame'
import { drawBriefing, drawJudgment, drawBossBanner, drawPageFlip } from '@/use/midnight/overlays'
import { drawMatchTimer, drawHearts, drawScore } from '@/use/midnight/hud'
import {
  drawDesk, drawDeskNotebook, drawDive, drawSummary, drawFilledPage, stepRain
} from '@/use/midnight/desk'
import { routerConnect } from '@/use/midnight/games/routerConnect'
import { saiyanPump } from '@/use/midnight/games/saiyanPump'
import { staticCat } from '@/use/midnight/games/staticCat'
import { windowDash } from '@/use/midnight/games/windowDash'
import { flashlightFlicker } from '@/use/midnight/games/flashlightFlicker'
import { toastTrap } from '@/use/midnight/games/toastTrap'
import { sodaExplode } from '@/use/midnight/games/sodaExplode'
import { bugStomp } from '@/use/midnight/games/bugStomp'
import { mirageWhack } from '@/use/midnight/games/mirageWhack'
import { thermometerTap } from '@/use/midnight/games/thermometerTap'
import { hotPotato } from '@/use/midnight/games/hotPotato'
import { fanFlame } from '@/use/midnight/games/fanFlame'
import { shadowJump } from '@/use/midnight/games/shadowJump'
import { mosquitoSwat } from '@/use/midnight/games/mosquitoSwat'
import { findSignal } from '@/use/midnight/games/findSignal'
import { registerCheatHooks } from '@/use/useCheats'
import { acquireAppPause } from '@/use/useGamePause'
import { bestScore, ideasPlayed, markOnboarded, needsHint } from '@/use/useMidnightProgress'
import useSounds from '@/use/useSound'
import type { InkRenderer } from '@/use/ink/inkRenderer'
import type { MicroGameCtx, Pointer } from '@/use/midnight/types'

const { t } = useI18n()
const { playRandomVariant, playSound } = useSounds()

// ── Input ────────────────────────────────────────────────────────────────
// One normalised pointer for mouse AND touch. Micro-games never see a DOM
// event — they read page-unit coordinates, so the same code serves a desktop
// mouse and a thumb on a 320px phone.
const pointer: Pointer = {
  x: 0, y: 0, down: false, pressed: false, released: false, dx: 0, dy: 0, seen: false
}
let lastX = 0
let lastY = 0
let pendingPressed = false
let pendingReleased = false

/** Per-frame pointer travel beyond which we call it a teleport rather than a
 *  swipe, in page units (the page is 1000 wide). A real flick covers a few tens
 *  of units per frame; crossing a third of the page in one is a jump. */
const TELEPORT_UNITS = 340

const toPage = (clientX: number, clientY: number): void => {
  const cv = canvasRef.value
  const r = ink.value
  if (!cv || !r) return
  const rect = cv.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  pointer.x = ((clientX - rect.left) / rect.width) * r.pw
  pointer.y = ((clientY - rect.top) / rect.height) * r.ph
  pointer.seen = true
}

const onDown = (e: PointerEvent): void => {
  // Capture so a drag that leaves the canvas (flinging the plug off-page)
  // still delivers move/up here instead of silently dropping the cord.
  ;(e.target as Element).setPointerCapture?.(e.pointerId)
  toPage(e.clientX, e.clientY)
  pointer.down = true
  pendingPressed = true
}
const onMove = (e: PointerEvent): void => { toPage(e.clientX, e.clientY) }
const onUp = (e: PointerEvent): void => {
  toPage(e.clientX, e.clientY)
  pointer.down = false
  pendingReleased = true
}

// ── Acts ─────────────────────────────────────────────────────────────────
// Above the run's own phase machine sits a coarser one: the framing story.
// desk (title, "wake up") → dive (into the ink) → run (the notebook) →
// summary (the morning payoff). The run orchestrator knows nothing about
// these; it just reports that the night ended.
type Act = 'desk' | 'dive' | 'run' | 'summary'
const act = ref<Act>('desk')
/** Seconds in the current act. */
let actT = 0
const diveP = ref(0)
const DIVE_S = 1.15
/** True when the night ended at the boss's morning rather than at zero hearts. */
const survived = ref(false)
/** Set by the Space keydown; consumed by the sim tick so the act machine has
 *  a single place that starts a night. */
let wakeRequested = false

const setAct = (next: Act): void => {
  act.value = next
  actT = 0
}

const beginDive = (): void => {
  wakeRequested = false
  diveP.value = 0
  setAct('dive')
  inkDrop()
  inkCanvas.shake('thud')
  rain?.setIntensity(0)
}

// ── The run ──────────────────────────────────────────────────────────────
// The anthology. Instances are long-lived and reset in `init()` per play, so
// adding a game here is the whole integration (see `midnight/types.ts`).
const registry = {
  micro: [
    routerConnect(), mosquitoSwat(), saiyanPump(),
    staticCat(), windowDash(), flashlightFlicker(), toastTrap(), sodaExplode(),
    bugStomp(), mirageWhack(), thermometerTap(), hotPotato(), fanFlame(), shadowJump()
  ],
  boss: findSignal()
}
const game = useMidnightGame(registry)

const services = {
  shake: (p: any, m?: number) => inkCanvas.shake(p, m),
  impactFrame: (n?: number) => inkCanvas.impactFrame(n),
  get heat() { return game.heat.value },
  t: (key: string) => t(key)
}

const makeCtx = (r: InkRenderer): MicroGameCtx => ({
  ink: r,
  pointer,
  services,
  t: game.getGameT(),
  remaining: Math.max(0, game.getDuration() - game.getGameT()),
  duration: game.getDuration()
})

// ── Phase-change side effects ────────────────────────────────────────────
// Sound and one-shot feedback keyed off phase TRANSITIONS. Watching from the
// sim loop rather than a Vue watcher keeps it in the same frame as the state
// change — a watcher would fire a tick late, and a bass thump that lands one
// frame after the verb appears reads as broken.
let prevPhase = ''
let tickAcc = 0

const onPhaseEnter = (phase: string): void => {
  switch (phase) {
    case 'briefing':
      bassThump(game.speed.value)
      inkCanvas.shake('tick')
      break
    case 'bossBanner':
      inkCanvas.shake('slam')
      inkCanvas.impactFrame(2)
      break
    case 'judgment':
      if (game.lastOutcome.value === 'won') {
        chime()
      } else {
        sourBuzz()
        // The page rip is the one sound with texture worth sampling.
        playRandomVariant('plastic-torn', 2, 0.5)
        inkCanvas.shake('rip')
      }
      break
  }
}

const update = (dt: number): void => {
  const r = ink.value
  if (!r) return

  // Resolve per-frame pointer edges before the game reads them.
  pointer.pressed = pendingPressed
  pointer.released = pendingReleased
  pendingPressed = false
  pendingReleased = false

  // Teleport guard. `dx/dy` is meant to be "how far the hand moved this frame".
  // But a pointer can JUMP: the mouse leaves the canvas and re-enters on the
  // far side, a touch lifts and lands elsewhere, or the first event after a new
  // page arrives from wherever the cursor happened to be. Those are not
  // gestures, and a game that reads `dx/dy` as motion would get a colossal
  // single-frame delta it never asked for. Anything faster than a plausible
  // flick is treated as a reposition: it moves the pointer, but reports no
  // movement delta. (No current game reads dx/dy, but it's cheap input hygiene
  // that keeps the seam safe for any that later do.)
  const rawDx = pointer.x - lastX
  const rawDy = pointer.y - lastY
  const teleport = Math.hypot(rawDx, rawDy) > TELEPORT_UNITS
  pointer.dx = teleport ? 0 : rawDx
  pointer.dy = teleport ? 0 : rawDy

  actT += dt
  stepRain(dt)

  // ── The act machine (desk → dive → run → summary) ──
  if (act.value === 'desk') {
    // Any press wakes the kid up. The GDD's "Press Space" prompt is honoured
    // by the keydown handler, but a tap has to work too — most players are on
    // a phone and there is no space bar.
    if (pointer.pressed || wakeRequested) beginDive()
    lastX = pointer.x
    lastY = pointer.y
    return
  }

  if (act.value === 'dive') {
    diveP.value = Math.min(1, diveP.value + dt / DIVE_S)
    if (diveP.value >= 1) {
      setAct('run')
      game.start(makeCtx(r))
      prevPhase = ''
    }
    lastX = pointer.x
    lastY = pointer.y
    return
  }

  if (act.value === 'summary') {
    // Give the payoff a beat before it's dismissible, so an eager tap on the
    // last micro-game doesn't skip straight past the sunrise.
    if (actT > 1.6 && (pointer.pressed || wakeRequested)) {
      wakeRequested = false
      beginDive()
    }
    lastX = pointer.x
    lastY = pointer.y
    return
  }

  game.update(makeCtx(r), dt)

  // The run ended — hand off to the payoff.
  if (game.phase.value === 'gameover' || game.phase.value === 'morning') {
    survived.value = game.phase.value === 'morning'
    // The desk intro only holds long for a player who has never finished a
    // night; once they've seen one end, they've been onboarded.
    markOnboarded()
    setAct('summary')
    stopAllInkLoops()
    if (survived.value) playRandomVariant('celebration', 1, 0.4)
    else playSound('lose', 0.4)
    lastX = pointer.x
    lastY = pointer.y
    return
  }

  if (game.phase.value !== prevPhase) {
    prevPhase = game.phase.value
    onPhaseEnter(prevPhase)
  }

  // The ticking match. Accelerates as the fuse burns down — the audio half of
  // the panic curve whose visual half is the flame.
  if (game.phase.value === 'playing') {
    const left = 1 - game.getGameT() / Math.max(0.001, game.getDuration())
    const urgency = 1 - Math.max(0, left)
    const interval = 0.5 - urgency * 0.32
    tickAcc += dt
    if (tickAcc >= interval) {
      tickAcc = 0
      tick(urgency)
    }
  } else {
    tickAcc = 0
  }

  lastX = pointer.x
  lastY = pointer.y
}

// ── Draw ─────────────────────────────────────────────────────────────────
// A scratch canvas for the page-flip snapshot. Allocated lazily and resized
// to match, so the flip never pays an allocation mid-transition.
let scratch: HTMLCanvasElement | null = null

const snapshot = (r: InkRenderer): HTMLCanvasElement | null => {
  const src = r.ctx.canvas
  if (!scratch) scratch = document.createElement('canvas')
  if (scratch.width !== src.width || scratch.height !== src.height) {
    scratch.width = src.width
    scratch.height = src.height
  }
  const g = scratch.getContext('2d')
  if (!g) return null
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, scratch.width, scratch.height)
  g.drawImage(src, 0, 0)
  return scratch
}

// Whether the onboarding hint shows is decided by `needsHint` in
// useMidnightProgress — the SAME predicate the orchestrator uses to lengthen
// the briefing, so the longer briefing and the visible hint can never
// disagree.

const draw = (r: InkRenderer): void => {
  // ── The reality frame wraps the notebook (GDD §2) ──
  if (act.value === 'desk' || act.value === 'dive') {
    drawDesk(r, { warmth: 0, zoom: act.value === 'dive' ? diveP.value : 0 })
    drawDeskNotebook(
      r,
      act.value === 'dive' ? diveP.value : 0,
      t('gameName'),
      act.value === 'desk' ? t('desk.prompt') : null,
      actT
    )
    if (act.value === 'dive') drawDive(r, diveP.value)
    return
  }

  if (act.value === 'summary') {
    drawSummaryAct(r)
    return
  }

  drawRun(r)
}

/** The morning payoff and the summary page (vision-board panel 8). */
const drawSummaryAct = (r: InkRenderer): void => {
  // The room warms from midnight blue to sunrise over the first beat — the
  // relief the whole night has been building to.
  const warmth = Math.min(1, actT / 1.8)
  drawDesk(r, { warmth, connected: survived.value && warmth > 0.5 })

  // The notebook, now full of the night's drawings.
  const w = r.pw * 0.52
  const h = r.ph * 0.42
  const x = r.cx - w / 2
  const y = r.ph * 0.62 - h / 2
  drawDeskNotebook(r, 0, t('gameName'), null, actT)
  drawFilledPage(r, x, y, w, h, Math.min(1, game.score.value / 12))

  // The summary slides up over it after the room has warmed.
  if (actT > 0.9) {
    r.ctx.save()
    const slide = Math.min(1, (actT - 0.9) / 0.4)
    r.ctx.translate(0, (1 - slide) * r.ph * 0.5)
    r.ctx.globalAlpha = slide
    drawSummary(
      r,
      {
        score: game.score.value,
        best: bestScore.value,
        isNewBest: game.newBest.value,
        ideasTotal: ideasPlayed.value,
        survived: survived.value
      },
      {
        title: survived.value ? t('summary.morning') : t('summary.lightsOut'),
        ideas: t('summary.ideas'),
        best: t('summary.best'),
        newBest: t('summary.newBest'),
        again: t('summary.again')
      },
      actT
    )
    r.ctx.restore()
  }
}

const drawRun = (r: InkRenderer): void => {
  // The jitter amplifies as the night escalates (GDD §3.4).
  r.roughMul = 1 + game.heat.value * 0.8

  const phase = game.phase.value
  const g = game.current.value
  const ctx = makeCtx(r)

  drawPaper(r, { spiral: true, blank: g?.isBoss })

  if (phase === 'flip') {
    // Draw the outgoing page, snapshot it, repaint the incoming blank page,
    // then warp the snapshot over the top.
    g?.draw(ctx)
    const snap = snapshot(r)
    drawPaper(r, { spiral: true })
    if (snap) drawPageFlip(r, snap, game.getPhaseT() / 0.45)
    return
  }

  if (phase === 'judgment' && g && game.lastOutcome.value) {
    const o = game.lastOutcome.value
    if (g.drawOutcome) g.drawOutcome(ctx, o, game.getPhaseT())
    else g.draw(ctx)
    drawHearts(r, game.hearts.value, game.MAX_HEARTS, safeTop.value)
    drawJudgment(r, o, game.getPhaseT() / 1.1)
    return
  }

  if (g && (phase === 'playing' || phase === 'briefing' || phase === 'bossBanner')) {
    g.draw(ctx)
  }

  if (phase === 'playing') {
    drawMatchTimer(r, 1 - game.getGameT() / Math.max(0.001, game.getDuration()), safeTop.value)
  }
  if (phase !== 'bossBanner') {
    drawHearts(r, game.hearts.value, game.MAX_HEARTS, safeTop.value)
    drawScore(r, game.score.value, safeTop.value)
  }

  if (phase === 'briefing' && g) {
    drawBriefing(
      r,
      t(g.verbKey),
      needsHint(g.id) ? t(g.hintKey) : null,
      // Progress through the ACTUAL briefing duration (longer when a hint is
      // showing), so the verb's punch-in/out timing tracks the real phase.
      game.getPhaseT() / Math.max(0.001, game.getBriefingDuration())
    )
  }
  if (phase === 'bossBanner') {
    drawBossBanner(r, t('game.bossBanner'), game.getPhaseT() / 1.4)
  }
}

const inkCanvas = useInkCanvas({ update, draw })
const { canvasRef, ink } = inkCanvas

// ── Safe area ────────────────────────────────────────────────────────────
// The canvas fills the viewport edge-to-edge (that's the point — the page IS
// the screen), so the notch has to reach the ink layer as a NUMBER rather than
// as CSS padding. Read the env() inset once and convert to page units.
const safeTop = ref(0)
const readSafeArea = (): void => {
  const r = ink.value
  const cv = canvasRef.value
  if (!r || !cv) return
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden;'
  document.body.appendChild(probe)
  const px = probe.getBoundingClientRect().height
  probe.remove()
  const rect = cv.getBoundingClientRect()
  safeTop.value = rect.height > 0 ? (px / rect.height) * r.ph : 0
}

let releaseCheats: (() => void) | null = null
let releaseAudioGate: (() => void) | null = null
/** The rainstorm outside. Runs only while we're at the desk — inside the
 *  notebook the GDD swaps it for the lo-fi track (vision-board panel 2). */
let rain: Loop | null = null

/** GDD/vision-board panel 1: "[ Press Space to Wake Up ]". Also accepts Enter,
 *  because a prompt that only takes one specific key is a needless wall. The
 *  flag is consumed by the sim tick, not acted on here, so every path into a
 *  night goes through the same code. */
const onKeyDown = (e: KeyboardEvent): void => {
  if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return
  if (act.value !== 'desk' && act.value !== 'summary') return
  e.preventDefault()
  wakeRequested = true
  penClick()
}

onMounted(() => {
  releaseAudioGate = installInkAudioGate()
  readSafeArea()
  window.addEventListener('keydown', onKeyDown)

  // The desk's rain. Web Audio won't start before a gesture, so this is a
  // no-op until the player's first interaction — which is fine: the first
  // thing they do is press to wake up, and the rain fades as they dive.
  rain = rainAmbience()
  rain?.setIntensity(1)

  releaseCheats = registerCheatHooks({
    winRound: () => game.forceOutcome('won'),
    loseRound: () => game.forceOutcome('lost'),
    jumpToBoss: () => game.queueBoss(),
    refillHearts: () => game.refillHearts(),
    skipIntro: () => { if (act.value === 'desk') beginDive() },
    jumpToMorning: () => {
      if (act.value !== 'run') return
      survived.value = true
      setAct('summary')
    }
  })

  // Dev-only inspection handle. The loop is on a timer, so "reload and look"
  // can't reliably land on a given micro-game; this lets a dev (or an
  // automated browser session) pin one open and freeze it. Stripped from
  // production builds by the `import.meta.env.DEV` guard.
  if (import.meta.env.DEV) {
    let releasePause: (() => void) | null = null
    ;(window as unknown as Record<string, unknown>).__midnight = {
      /** Drop into a micro-game by id: router | mosquito | saiyan | cat |
       *  window | flashlight | toast | soda | stomp | signal (boss). */
      play: (id: string) => {
        const r = ink.value
        return r ? game.debugPlay(makeCtx(r), id) : false
      },
      /** Freeze the sim (reuses the real pause gate) so a screenshot is stable. */
      freeze: () => { releasePause = releasePause ?? acquireAppPause() },
      resume: () => { releasePause?.(); releasePause = null },
      /** Settle the running game, to inspect the outcome/judgment beats. */
      win: () => game.forceOutcome('won'),
      lose: () => game.forceOutcome('lost'),
      /** Jump straight to an act, skipping the desk hold / dive. */
      act: (a: Act) => {
        if (a === 'run') { const r = ink.value; if (r) { setAct('run'); game.start(makeCtx(r)); prevPhase = '' } }
        else setAct(a)
      },
      state: () => ({
        act: act.value,
        phase: game.phase.value,
        game: game.current.value?.id ?? null,
        score: game.score.value,
        hearts: game.hearts.value,
        speed: game.speed.value,
        // The running game's own debug view, when it offers one. Lets a
        // browser session assert on physics (the cone's lean, the cord's
        // wobble) instead of eyeballing screenshots.
        detail: (game.current.value as unknown as { debug?: () => unknown })?.debug?.() ?? null
      })
    }
  }
})

onUnmounted(() => {
  game.stop()
  stopAllInkLoops()
  rain = null
  window.removeEventListener('keydown', onKeyDown)
  releaseCheats?.()
  releaseAudioGate?.()
})
</script>

<template lang="pug">
  div.relative.w-full.h-full.overflow-hidden
    canvas.block.w-full.h-full.touch-none(
      ref="canvasRef"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    )
</template>
