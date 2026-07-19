# Midnight Analog — automated play-through bug report

**Final: 21 / 20 cycles complete · 163 micro-games played**
**2 bugs found, both fixed and re-verified in the browser**

## Method

A harness injected into the running dev build (`window.__bot`) drove the real
game through synthetic `PointerEvent`s on the canvas — the same code path a
human's mouse or thumb takes. It read `window.__midnight.state()` every 33ms for
phase, score, hearts, escalation speed and the running game's own debug view,
and rotated through four play styles, one per night:

| style | behaviour |
| --- | --- |
| `skilled` | aims at real targets, taps only inside the hit window |
| `eager` | taps the target constantly, **ignoring** the ring state — the early-click case |
| `masher` | random taps all over the page at ~15/s |
| `idle` | never taps at all |

A watchdog recorded: phases that never advanced, hearts out of range, score
going backwards, non-finite numbers anywhere in game state, thrown exceptions,
`console.error`, and unhandled rejections.

To make the boss and the two swat games drivable at all, three games gained the
same dev-only `debug()` seam the other eleven already had (`findSignal`,
`mosquitoSwat`, `staticCat`). That is introspection only — no gameplay logic.

---

## BUG-1 — `shadowJump`: any mistimed or off-target tap was an instant loss

**Severity: high** · `src/use/midnight/games/shadowJump.ts` · **FIXED**

This is the exact failure mode suspected up front: clicking before the cyan ring
turned yellow broke the game.

While the runner was standing, *every* press that was not simultaneously on the
next shadow **and** inside the hit window called `missBurn()` and returned
`'lost'`:

```ts
if (d < hitR && isHot(this.ring)) { /* leap */ }
else { this.missBurn(ctx); return 'lost' }   // ← any other press at all
```

Because the check was an `else` on the *combined* condition, a tap anywhere on
the page — a stray thumb, a tap on blank paper, an eager tap a few frames before
the ring went hot — ended the run instantly, with no counterplay and no
feedback that the player had done anything wrong.

**Reproduced deterministically: 16 / 16 instant losses.** Eight trials tapping
far away on blank paper, eight tapping *on* the shadow while the ring was still
cool — every one lost immediately. Under identical `eager` input, eight other
games were won (`soda`, `mirage`, `flashlight`, `cat`, `stomp`, `thermometer`,
`fan`, `potato`). Shadow was the only game that behaved this way.

**Why it was a bug, not difficulty:** it contradicted the shared mechanic's own
documented contract. `ring.ts:14-16` states the ring "RECYCLES past the collapse
rather than vanishing — so a mistimed tap just means 'wait for the next pass',
never a dead target". `hotPotato.ts` spells it out: *"a mistimed tap must never
end the game … A tap nowhere near the hand is ignored entirely."*
`thermometerTap`, `fanFlame`, `mirageWhack`, `mosquitoSwat` and `staticCat` all
honour it.

**Fix:** split the condition into three outcomes — on the shadow and on the beat
leaps; on the shadow but off the beat gives the harmless `penClick()` + `tick`
shake and the ring recycles; away from the shadow is ignored entirely. The clock
became the game's only fail state, and the timeout is now resolved by the game
itself so the melt keeps its sizzle and alarm (`drawOutcome` already drew the
burned runner on any loss, so the visual was never orphaned).

**Verified:** the same 16 trials now leave the game running, and across the full
run `shadow` went **7 wins / 2 losses** — both losses in `idle` mode, i.e. the
correct 7s clock timeout when the player never taps at all.

---

## BUG-2 — `shadowJump` was mathematically unwinnable once the night escalated

**Severity: high** · `src/use/midnight/games/shadowJump.ts` · **FIXED**

Shadow reused the shared `makeRing(index, rng)` helper, whose index-based
stagger exists to stop several **simultaneous** rings collapsing in lockstep.
Shadow's rings are **sequential** — one per jump — so passing the jump count as
the index made the *first* ring the slowest (0.44/s ≈ 1.9s of dead waiting
before the first leap was even possible).

Measured with a frame-perfect bot, a flawless run took **6.1s**. The clock gives
`baseDuration / speed` = `7 / speed`:

| speed | clock | perfect run | winnable |
| --- | --- | --- | --- |
| 1.0 | 7.00s | 6.1s | yes, barely |
| 1.1 | 6.36s | 6.1s | razor-thin |
| **1.2** | **5.83s** | **6.1s** | **no** |
| 1.4 | 5.00s | 6.1s | no |

Escalation adds 0.1 every 4 games played, so **every night reached 1.2 by game
eight** — from then on shadow was a guaranteed heart loss no matter how well the
player read the ring. It was the only game with negative slack; the next
tightest (`thermometer`, 5.1s of 5.83s) still had room.

**Fix:** gave shadow its own brisk, near-constant ring cadence
(`0.78 + jumps * 0.06`) instead of borrowing the stagger helper, removing the
long dead wait before the first jump.

**Verified:** a flawless run now takes **~4.0s** (8/8 runs, 3.91–4.06s). During
normal play shadow was won at speed 1.2 in 4.1s — the exact case that was
previously impossible — and repeatedly at 4.0–4.2s thereafter.

---

## Final results

163 micro-games across 21 complete nights. **Zero** exceptions, `console.error`,
unhandled rejections, stuck phases, non-finite values, or out-of-range
hearts/score.

| style | won | lost |
| --- | --- | --- |
| skilled | 66 | 0 |
| eager | 56 | 0 |
| masher | 10 | 15 |
| idle | 0 | 15 |

`eager` — the early-click style — went from losing shadow on frame one to
**56-0**. Every one of the 15 games appeared many times; the boss (`signal`) was
reached and cleared 11 times. The core loop, escalation curve, boss encounter,
page-flip transitions, and both payoff screens all behave.

Type-check clean (`vue-tsc`), full suite green (235 tests / 26 files).

## Verified-good under adversarial input

- **Early taps** are harmless in every ring game: `penClick()` + `tick` shake,
  ring recycles. Confirmed by `eager` mode going 56-0.
- **Mid-game resize / phone rotation** does not strand targets. Games cache
  layout from `ink.stage` in `init()`, but the 0.72 aspect clamp holds `ph`
  constant across all landscape shapes, and after a portrait↔landscape swap the
  cached targets stayed inside the new stage box with art and hit-rings aligned.
- **Instance reuse** is safe: every game rebuilds its arrays and resets its
  flags in `init()`, and the three games holding audio loops (`findSignal`,
  `mosquitoSwat`, `saiyanPump`) all implement `dispose()`.
- **Never tapping** always resolves as a clean timeout loss — no hangs.

## Observations (not bugs)

- **Escalation rarely passes 1.2×.** Clearing the boss at game 10 ends the night
  in triumph, so the `MAX_SPEED = 2.2` ceiling is only reachable by a player who
  *fails* the boss and survives on remaining hearts. Worth knowing when tuning:
  difficulty knobs above ~1.3 are effectively dead code in a winning run.
- **`mirage` is the next-tightest game.** After each bop a new random hole
  becomes solid, and its ring may have just passed, costing up to ~2.3s of dead
  wait. A worst-case sequence can exceed the clock through pure luck rather than
  player error. Not reproduced as a loss in 14 skilled/eager plays, but it is
  the one remaining game whose fairness depends on the RNG — worth a look if
  players report it feeling arbitrary.
- **HUD crowding in `fanFlame`.** The score digit occupies page units 108–148
  and the `HEAT` label starts at 160 — a 12-unit gap that reads as "0HEAT" on
  wide viewports. Cosmetic only; nothing overlaps.
- `speed` accumulates float drift (`1.2000000000000002`). Never displayed.
- `__midnight.play(id)` does not force `act` back to `'run'`. If the previous
  night ended, the act machine never ticks the run and the pinned game sits
  frozen at 0 progress. Dev-tool wart, not player-reachable.

## Ruled out

- `score-decreased 11 → 0` in the watchdog log is the normal score reset at the
  start of a new night.
- Losses in `masher`/`idle` are correct — those styles are meant to lose.
- An early `stuck-phase` report was the harness holding a stale
  `window.__midnight` across an HMR remount (whose `onUnmounted` calls
  `game.stop()`, leaving `act:'run', phase:'idle'`), not a game hang. The
  harness was changed to re-resolve the handle every tick.
