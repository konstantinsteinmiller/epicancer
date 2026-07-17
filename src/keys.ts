// ─── Game-progress field catalogue ──────────────────────────────────────────
//
// Field names INSIDE the single `midnight_state` blob (see `useMidnightState.ts`).
// These are not separate localStorage keys — they're properties of the one
// persisted object — but they're still a contract with the player base:
// renaming any of them strands existing players' progress on the old field.
// Treat them as load-bearing constants.
//
// The `ma_` prefix marks Midnight Analog gameplay progress. Settings reused
// from the shared platform layer keep their `spinner_user_*` names; the save
// merge policy carries both prefixes (see `SaveMergePolicy.PAYLOAD_PREFIXES`).

/** Highest number of micro-games survived in a single night. */
export const BEST_SCORE_KEY = 'ma_best_score'
/** Lifetime count of completed nights (a night ends at death or after the
 *  boss's morning payoff). Drives the GamePix progression ping. */
export const NIGHTS_SURVIVED_KEY = 'ma_nights_survived'
/** Lifetime count of micro-games played across all nights — the "3 AM ideas
 *  brought to life" counter shown on the summary page. */
export const IDEAS_PLAYED_KEY = 'ma_ideas_played'
/** Per-micro-game lifetime win/play tallies: { [gameId]: { wins, plays } }.
 *  Feeds the summary page and the "your worst idea" flavour line. */
export const GAME_STATS_KEY = 'ma_game_stats'
/** True once the player has finished the desk intro at least once — lets
 *  returning players skip straight past the "Press Space to Wake Up" hold. */
export const ONBOARDED_KEY = 'ma_onboarded'
/** Highest boss (Find The Signal) clear count. */
export const BOSSES_CLEARED_KEY = 'ma_bosses_cleared'
/** Mobile-only hard audio mute (boolean). On phones the OS volume rocker owns the
 *  device level and the Web Audio gain has no effect, so the on-screen mute is a
 *  silence toggle instead: suspend all audio + block new music/SFX. Persisted so
 *  it sticks across sessions; only ever honoured on mobile (see useMobileAudioMute).
 */
export const MOBILE_MUTE_KEY = 'ma_mobile_mute'
