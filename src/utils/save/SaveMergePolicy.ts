// ─── Save merge policy ────────────────────────────────────────────────────
//
// Decides what to do when a hydrate brings back remote data that disagrees
// with the local snapshot. Pure module — no Vue, no I/O, no side effects.
// Strategies call into this; the SaveManager wires the result back into
// localStorage via the LocalStorageAccessor it owns.
//
// Each persisted save now carries a meta blob (`__save_meta__`) alongside
// the player's actual keys. The blob lets the next hydrate score local vs.
// remote and pick a winner deterministically without prompting.
//
// Score formula:
//   bestScore      × 500   (deepest single night — the headline record)
// + nightsSurvived × 150   (breadth of play)
// + bossesCleared  × 400   (the rarest achievement in the game)
//
// Midnight Analog has no currency, no upgrades and no unlockables, so the
// score is a pure "how much of this player's history would we destroy"
// measure. `maxStage` in the meta blob carries `bestScore` — it keeps the
// field name the save layer and its tests already speak.
//
// Conflict policy:
//   - higher score wins
//   - tie on score → newer savedAt wins
//   - same time too → keep local (no needless writes)

import { BEST_SCORE_KEY, NIGHTS_SURVIVED_KEY, BOSSES_CLEARED_KEY } from '@/keys'
import { STATE_KEY } from '@/use/useMidnightState'

/** Where the meta blob is stored in localStorage / on the remote backend.
 *  NOT prefixed with `__save_internal__` — this key needs to round-trip
 *  through the strategy's mirror just like player data. */
export const META_KEY = '__save_meta__'

/** Bumped when the meta blob's shape changes in a non-additive way. */
export const SCHEMA_VERSION = 1

// ─── Game-specific keys the score formula needs to read ────────────────────
//
// Sourced from `src/keys.ts` (single source of truth shared with the
// composables that own these keys). Importing keeps this module pure (no
// Vue imports — `keys.ts` is a flat constants file) AND eliminates the
// drift risk the previous duplicated declaration had.

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SaveMeta {
  /** ISO timestamp of when this save was generated. */
  savedAt: string
  /** Output of the score formula above. */
  progressScore: number
  schemaVersion: number
  /** Best single-night score the save represents. Named `maxStage` because
   *  the strategies and the backup layer already speak that field; Midnight
   *  Analog has no stages, so it carries `ma_best_score`. */
  maxStage: number
}

/** Narrow read-only view over a localStorage snapshot. */
export interface SnapshotReader {
  get(key: string): string | null
}

/**
 * Hydrate-time merge resolution. The SaveManager's job is to:
 *   - apply the chosen side's keys to local
 *   - schedule a flush back to remote when the chosen side is local
 *
 * midnight-analog softened a remote-wins loss by paying the player bonus coins.
 * Midnight Analog has no currency to pay them in — a lost save costs a
 * high-score line, not a purse — so a losing side is simply overwritten.
 */
export type MergeResolution =
/** Remote had higher progress; overwrite local. */
  | { kind: 'remote-wins' }
  /** Local had higher progress; keep local and push it to remote on next flush. */
  | { kind: 'local-wins' }
  /** Local was empty; remote is the seed. Same as remote-wins but no "loss". */
  | { kind: 'remote-only' }
  /** Remote returned no data; nothing to merge. */
  | { kind: 'local-only' }
  /** Both sides identical; keep local, skip the rewrite. */
  | { kind: 'tie-keep-local' }

// ─── Helpers ──────────────────────────────────────────────────────────────

const safeInt = (v: string | null, fallback: number): number => {
  if (v == null) return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

const safeJson = <T>(v: string | null, fallback: T): T => {
  if (v == null) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Compute a fresh meta blob from the current localStorage snapshot.
 * Pure — no side effects.
 */
/** Pull a sub-field out of the consolidated `maw_state` blob if present.
 *  Falls through to a top-level read for back-compat with any pre-migration
 *  snapshot that still has individual keys (e.g. the score formula was just
 *  invoked between BlobStorage construction and the first migration write). */
const readField = (read: SnapshotReader, field: string): string | null => {
  const blob = read.get(STATE_KEY)
  if (blob != null) {
    try {
      const parsed = JSON.parse(blob)
      if (parsed && typeof parsed === 'object' && field in parsed) {
        const v = (parsed as Record<string, unknown>)[field]
        if (v == null) return null
        return typeof v === 'string' ? v : JSON.stringify(v)
      }
    } catch { /* fall through to direct read */ }
  }
  return read.get(field)
}

export const computeMeta = (
  read: SnapshotReader,
  savedAt: string = new Date().toISOString()
): SaveMeta => {
  // A fresh save floors at 0, not 1 — unlike a stage number, "best night" of
  // zero is a real, meaningful value (nobody has survived anything yet), and
  // flooring it at 1 would give an empty save a non-zero progressScore and let
  // it beat a genuinely-empty remote for no reason.
  const bestScore = Math.max(0, safeInt(readField(read, BEST_SCORE_KEY), 0))
  const nights = Math.max(0, safeInt(readField(read, NIGHTS_SURVIVED_KEY), 0))
  const bosses = Math.max(0, safeInt(readField(read, BOSSES_CLEARED_KEY), 0))

  const progressScore =
    bestScore * 500
    + nights * 150
    + bosses * 400

  return { savedAt, progressScore, schemaVersion: SCHEMA_VERSION, maxStage: bestScore }
}

/**
 * Parse a meta blob from a stored value. Returns null for missing /
 * malformed blobs (treat as "no prior meta exists" — typically a save
 * that predates this layer or a value the SDK never wrote).
 */
export const parseMeta = (raw: string | null | undefined): SaveMeta | null => {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const m = parsed as Partial<SaveMeta>
  if (
    typeof m.savedAt !== 'string' ||
    typeof m.progressScore !== 'number' || !Number.isFinite(m.progressScore) ||
    typeof m.schemaVersion !== 'number' || !Number.isFinite(m.schemaVersion) ||
    typeof m.maxStage !== 'number' || !Number.isFinite(m.maxStage)
  ) return null
  return {
    savedAt: m.savedAt,
    progressScore: m.progressScore,
    schemaVersion: m.schemaVersion,
    maxStage: m.maxStage
  }
}

export const serializeMeta = (meta: SaveMeta): string => JSON.stringify(meta)

/**
 * Compare local and remote metas, return the resolution.
 *
 * Rules (in order):
 *   1. No remote → 'local-only'
 *   2. No local  → 'remote-only'
 *   3. remote.score > local.score → 'remote-wins'
 *   4. local.score > remote.score → 'local-wins'
 *   5. Equal scores → newer savedAt wins
 *   6. Equal everything → 'tie-keep-local'
 */
export const decideMerge = (
  localMeta: SaveMeta | null,
  remoteMeta: SaveMeta | null
): MergeResolution => {
  if (!remoteMeta) return { kind: 'local-only' }
  if (!localMeta) return { kind: 'remote-only' }

  if (remoteMeta.progressScore > localMeta.progressScore) {
    return { kind: 'remote-wins' }
  }
  if (localMeta.progressScore > remoteMeta.progressScore) {
    return { kind: 'local-wins' }
  }

  // Equal scores → newer timestamp wins.
  const lt = Date.parse(localMeta.savedAt)
  const rt = Date.parse(remoteMeta.savedAt)
  if (Number.isFinite(rt) && Number.isFinite(lt) && rt > lt) {
    return { kind: 'remote-wins' }
  }
  return { kind: 'tie-keep-local' }
}

/**
 * Allowlist of keys that participate in the persisted payload.
 *
 * Replacing the old "anything not internal" rule because that let
 * unrelated localStorage entries — vConsole layout, ad-tech experiment
 * flags (`prebid11_*`, `dummy_*_exp`, `li-module-enabled`, `bid_pf_*`),
 * dev toggles, and whatever the next library decides to scribble — get
 * mirrored to the cloud. The CrazyGames Data Module then included all
 * of that in its upload, ballooning the POST body and giving QA a
 * misleading picture of what the game stores.
 *
 * Composables ALL store under one of two prefixes (`src/keys.ts` plus
 * the one-off `ca_battles_since_ad` in `SpinnerArena.vue`), and the
 * save-meta blob has its own well-known literal. That's the entire
 * surface the cloud should ever see — anything else is by definition
 * not our state.
 */
/**
 * Single-blob model: every persisted gameplay value lives inside the
 * `midnight_state` localStorage entry (see `useMidnightState.ts`). The cloud
 * mirrors exactly two keys — the state blob and the meta blob.
 *
 * Individual `ma_*` game keys plus the reused-platform `spinner_*` / `ca_*`
 * keys are also accepted as payload so any stray per-key write (defensive, or
 * a mid-migration snapshot from an older client) round-trips safely instead of
 * being silently dropped.
 */
const PAYLOAD_PREFIXES = ['ma_', 'spinner_', 'ca_'] as const

export const isPayloadKey = (key: string): boolean => {
  if (key === META_KEY) return true
  if (key === STATE_KEY) return true
  for (const prefix of PAYLOAD_PREFIXES) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

// Re-exported so tests / other modules don't have to re-declare them.
export const SAVE_KEYS = {
  BEST_SCORE: BEST_SCORE_KEY,
  NIGHTS: NIGHTS_SURVIVED_KEY,
  BOSSES: BOSSES_CLEARED_KEY
} as const

/**
 * True when local holds nothing worth protecting — no record, no nights, no
 * boss clears. Drives the SaveManager's sanity guard: if a hydrate FAILED and
 * local still looks like fresh defaults, we must not push those defaults over
 * a cloud save that may hold a real history.
 *
 * Reads through `readField` so it sees values inside the `midnight_state`
 * blob, which is where they actually live — a direct top-level `local.get`
 * would never find them and would call every save fresh.
 */
export const localLooksFresh = (read: SnapshotReader): boolean =>
  safeInt(readField(read, BEST_SCORE_KEY), 0) <= 0
  && safeInt(readField(read, NIGHTS_SURVIVED_KEY), 0) <= 0
  && safeInt(readField(read, BOSSES_CLEARED_KEY), 0) <= 0
