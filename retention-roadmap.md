# Midnight Analog — Retention & Conversion Roadmap

Ordered by **impact ÷ effort**, not by ambition. Each item names the metric it
moves, why it moves it, and where in the code it goes. Everything here assumes
the shipped architecture: micro-games are hot-pluggable (`src/use/midnight/types.ts`),
the run orchestrator owns escalation (`useMidnightGame.ts`), and all persisted
state lives in one `midnight_state` blob (`useMidnightState.ts`).

**The single biggest risk to every metric below:** the game currently ships
**3 micro-games**. WarioWare-likes live or die on variety, and a player sees all
three inside 30 seconds. Items #1 and #2 exist because nothing else on this list
matters if the content well is dry.

Effort key: **S** ≈ half a day · **M** ≈ 1–2 days · **L** ≈ 3–5 days

---

## Tier 1 — Do these first (content depth + the first 60 seconds)

### 1. Ship 9 more micro-games (target: 12 total) — **L**
*Moves: avg playtime, D1 retention, hard-to-put-down.*

Three games means the loop is fully explored before the first boss. Twelve is
the threshold where a run stops being predictable. The seam is already narrow —
one file implementing `MicroGame`, one line in the registry.

Cheap candidates that reuse existing systems:
- **"SHAKE!"** — a dying flashlight; shake the mouse/device to keep the beam alive
  (reuses `pointer.dx/dy` from Melt).
- **"SWAT!" variant** — a moth at the window; one big target, tighter window.
- **"CATCH!"** — the cocoa mug tips; drag to catch it (reuses the Verlet/drag rig).
- **"SPELL!"** — trace a letter with the pen cursor before the ink dries.
- **"SQUASH!"** — a spider descends on a thread (Verlet rope, inverted goal).
- **"POUR!"** — refill the mug; stop at the line (single-axis timing).
- **"HUSH!"** — a floorboard creaks; release the mouse before a parent wakes.
- **"REWIND!"** — a cassette unspools; circle the pointer to wind it back
  (reuses the boss's angular input).
- **"DODGE!"** — rain leaks through the ceiling onto the notebook; move the page.

**Do not** gate these behind progression. Variety IS the retention mechanic.

### 2. Difficulty tiers per micro-game — **M**
*Moves: avg playtime, hard-to-put-down.*

Right now escalation only shortens the clock (`durationFor`). At speed 2.2× the
router is the same puzzle, just rushed — which reads as unfair rather than hard.
Give each game 3 authored variants (Melt: 1→2→3 wind gusts fighting you; Router:
1→2→3 ports where only the lit one counts; Mosquito: 3→4→5 bugs, faster rings).

Implementation: add `level: 0|1|2` to `MicroGameCtx`, derived from `heat` in the
orchestrator. This is the change that makes item #1's games each worth 3×.

### 3. First-session tutorial beat — **S**
*Moves: new-player conversion, D1.*

`isFirstEncounter()` already shows a hint line under the verb. Go further: on a
player's **very first** micro-game, freeze the clock until they act, and pulse
the target. One un-timed rep teaches the grammar ("the verb tells me what to
do") that every later round depends on. Costs 4 seconds once; saves the players
who currently lose 3 hearts before understanding the game.
Gate on `isFirstNight` (already exported from `useMidnightProgress`).

### 4. Second chance on a rewarded ad — **M**
*Moves: avg playtime, ARPDAU, D1.*

At 0 hearts, offer "Keep dreaming?" for a rewarded ad, once per night. This is
the highest-revenue-per-line item on the list and it fits the fiction exactly
(you're fighting to stay awake). Wire through the existing `useAds` abstraction.

**Traps this codebase already knows about** (see `new-web-game-playbook`):
the ad must show **before** the summary page renders, rewarded readiness must be
checked before the button is drawn (never show a button that no-ops), and audio
must be silent for the ad's first frame — `installInkAudioGate()` already
hard-zeroes the master bus on the pause gate, so route it through that.

---

## Tier 2 — Session shape and reasons to come back

### 5. Daily "Idea of the Day" seed — **M**
*Moves: D1 retention.*

One deterministic run per day (seed = date), same for every player, one score.
The single highest-leverage D1 mechanic in score-attack games: it creates a
reason to open the tab tomorrow that isn't "I felt like it". Reuse the existing
per-play `seed` plumbing in `startGame` — pass a date-derived seed instead of
`Math.random()`.

### 6. Personal-best ghost line on the match timer — **S**
*Moves: hard-to-put-down.*

Draw a faint notch on the burning match at the point where the player's best run
ended. Chasing a visible line is dramatically stickier than chasing a number
they'd have to remember. Pure `hud.ts` addition; `bestScore` is already reactive.

### 7. Streak counter with a visible break — **S**
*Moves: hard-to-put-down, avg playtime.*

Consecutive wins stamp a growing tally in the page margin; a loss scribbles it
out. The scribble-out is the point — loss aversion is what drives "one more go".
`overlays.ts` + a counter in the orchestrator.

### 8. Near-miss telemetry → difficulty smoothing — **M**
*Moves: D1 (churn prevention).*

Track per-game loss rate in the existing `ma_game_stats` bucket. If a player has
lost the same micro-game 3× running, quietly give that game +15% clock next
time. Never advertise it. The alternative is a player who bounces because Melt
specifically is unreadable to them.

### 9. "Your worst idea" flavour on the summary — **S**
*Moves: D1, shareability.*

`ma_game_stats` already holds per-game wins/plays. The summary page has room:
"You are 2/11 at balancing ice cream." Self-deprecating stats are memorable and
give the summary a reason to be read rather than skipped.

### 10. Endless vs. Story framing — **M**
*Moves: avg playtime.*

The summary already asks "Stay up another night?". Make the boss clear a real
chapter break: night 2 opens with a different desk dressing (more mugs, more
paper balls, later clock). Same systems, different `DeskOpts` — visible progress
for near-zero cost.

---

## Tier 3 — Feel, polish, and the long tail

### 11. Haptics on mobile — **S**
*Moves: game feel.*

`navigator.vibrate` on the SMACK, the CLACK, and heart loss. The GDD's whole
thesis is tactility; on a phone, haptics are 80% of that for 5 lines of code.
Gate behind a settings toggle and respect `prefers-reduced-motion`.

### 12. Slow-motion on the winning frame — **S**
*Moves: game feel.*

On a win, drop the sim to 0.25× for ~120 ms before the OK stamp. The single
cheapest "juice" trick that exists, and the `update(dt)` loop already takes a
scalable `dt` — multiply it in `useInkCanvas.frame`.

### 13. Real recorded SFX for the top 5 sounds — **M**
*Moves: game feel, review scores.*

The synth suite (`useInkAudio.ts`) is parametric and costs zero bytes, which is
the right default. But the CLACK, the SMACK and the page rip are the three
sounds a player hears most, and a real recording beats a synth on texture every
time. Keep the synth as the fallback; layer samples on top via the existing
`useSound` path (it already preloads on idle).

### 14. Accessibility: colour-blind + reduced-motion modes — **S**
*Moves: conversion (reach), store compliance.*

The interactivity language is currently *colour* (cyan = grab, yellow = target,
pink = act now). That fails ~8% of male players. Add a shape channel: dashed
rings for "wait", solid for "now". Also honour `prefers-reduced-motion` by
damping the shake presets — the boss's static veil in particular is intense.

### 15. Lower the boss's cost of entry — **S**
*Moves: D1.*

The boss lands at 10 micro-games. Most players will never see it — and it's the
best content in the game. Put the first boss at **5** for a player's first night
only (`isFirstNight` is already there), then 10 thereafter. Showing the ceiling
early is what makes someone come back to reach it properly.

### 16. Page-crumple transition on heart loss — **S**
*Moves: game feel.*

The page-flip warp (`drawPageFlip`) already slices and shears the outgoing page.
A crumple is the same machinery with a radial displacement instead of a
travelling wave. Losing a heart currently only scribbles; making the page
physically recoil sells the failure.

### 17. Cloud-save the daily seed result — **S**
*Moves: D1 across devices.*

`SaveManager` + the strategies already mirror the whole blob. Adding the daily
result is one field; it makes the daily meaningful for players who move between
phone and desktop.

### 18. Micro-game "remix" nights — **M**
*Moves: avg playtime, long tail.*

Every 3rd night, invert a rule globally: the verbs lie (do the opposite), or the
page is upside down, or the ink is invisible until you move. One flag in the
orchestrator, reusing all existing games. This is how the anthology format keeps
paying out after the content well is deep.

---

## Explicitly NOT recommended

- **Currency / shop / battle pass.** The epicrolla meta-progression was removed
  deliberately. This is a 3-minute score-attack game about a bored teenager; a
  coin economy would add grind, a persistent balance to protect (and therefore a
  save-conflict problem the merge policy is now happily free of), and would
  contradict the fiction. Retention here comes from *variety* (#1) and a *reason
  to return tomorrow* (#5) — not from a purse.
- **Leaderboards before item #1 ships.** A global board on 3 micro-games just
  advertises how quickly the game is exhausted.
