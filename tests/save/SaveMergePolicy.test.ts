import { describe, expect, it } from 'vitest'
import {
  computeMeta,
  decideMerge,
  localLooksFresh,
  parseMeta,
  SAVE_KEYS,
  SCHEMA_VERSION,
  serializeMeta,
  type SaveMeta
} from '@/utils/save/SaveMergePolicy'
import { STATE_KEY } from '@/use/useMidnightState'

// Tiny in-memory snapshot reader used by every test below. Lets each
// scenario describe its localStorage state as a plain object literal.
const reader = (snap: Record<string, string>): { get: (k: string) => string | null } => ({
  get: (k: string) => (k in snap ? snap[k]! : null)
})

/** The real shape: every field lives INSIDE the one `midnight_state` blob, so
 *  the policy has to read through it rather than off top-level keys. */
const blob = (fields: Record<string, unknown>): Record<string, string> => ({
  [STATE_KEY]: JSON.stringify(fields)
})

describe('SaveMergePolicy.computeMeta', () => {
  it('scores a fresh save at 0 — an empty save must never beat a real one', () => {
    const meta = computeMeta(reader({}), '2026-04-27T10:00:00Z')
    expect(meta).toEqual({
      savedAt: '2026-04-27T10:00:00Z',
      progressScore: 0,
      schemaVersion: SCHEMA_VERSION,
      maxStage: 0
    })
  })

  it('counts bestScore * 500 and carries it as maxStage', () => {
    const meta = computeMeta(reader(blob({ [SAVE_KEYS.BEST_SCORE]: 7 })))
    expect(meta.progressScore).toBe(7 * 500)
    expect(meta.maxStage).toBe(7)
  })

  it('counts nights * 150 and bosses * 400', () => {
    const meta = computeMeta(reader(blob({
      [SAVE_KEYS.NIGHTS]: 4,
      [SAVE_KEYS.BOSSES]: 2
    })))
    expect(meta.progressScore).toBe(4 * 150 + 2 * 400)
  })

  it('combines every term per the formula', () => {
    const meta = computeMeta(reader(blob({
      [SAVE_KEYS.BEST_SCORE]: 12,
      [SAVE_KEYS.NIGHTS]: 9,
      [SAVE_KEYS.BOSSES]: 3
    })))
    expect(meta.progressScore).toBe(12 * 500 + 9 * 150 + 3 * 400)
    expect(meta.maxStage).toBe(12)
  })

  it('clamps negative / garbage values to 0 rather than scoring them', () => {
    expect(computeMeta(reader(blob({ [SAVE_KEYS.BEST_SCORE]: -3 }))).progressScore).toBe(0)
    expect(computeMeta(reader(blob({ [SAVE_KEYS.BEST_SCORE]: 'abc' }))).progressScore).toBe(0)
  })

  it('survives a malformed state blob', () => {
    expect(computeMeta(reader({ [STATE_KEY]: '{not json' })).progressScore).toBe(0)
  })

  it('also reads values written as stray top-level keys (mid-migration client)', () => {
    // `isPayloadKey` accepts bare `ma_*` keys, so a snapshot can legitimately
    // carry them outside the blob; the score must still see them.
    const meta = computeMeta(reader({ [SAVE_KEYS.BEST_SCORE]: '6' }))
    expect(meta.progressScore).toBe(3000)
  })
})

describe('SaveMergePolicy.localLooksFresh', () => {
  it('is true for an empty snapshot', () => {
    expect(localLooksFresh(reader({}))).toBe(true)
  })

  it('is false once ANY progress exists — this gates the boot sanity guard', () => {
    expect(localLooksFresh(reader(blob({ [SAVE_KEYS.BEST_SCORE]: 1 })))).toBe(false)
    expect(localLooksFresh(reader(blob({ [SAVE_KEYS.NIGHTS]: 1 })))).toBe(false)
    expect(localLooksFresh(reader(blob({ [SAVE_KEYS.BOSSES]: 1 })))).toBe(false)
  })

  it('sees progress INSIDE the blob, not just at the top level', () => {
    // The single-blob model means a top-level lookup would find nothing and
    // call every returning player fresh — which would let a failed hydrate
    // push empty defaults over their cloud save.
    expect(localLooksFresh(reader(blob({ [SAVE_KEYS.NIGHTS]: 40 })))).toBe(false)
  })
})

describe('SaveMergePolicy.parseMeta / serializeMeta', () => {
  it('round-trips a valid meta blob', () => {
    const meta: SaveMeta = {
      savedAt: '2026-04-27T18:30:00Z',
      progressScore: 1234,
      schemaVersion: SCHEMA_VERSION,
      maxStage: 4
    }
    expect(parseMeta(serializeMeta(meta))).toEqual(meta)
  })

  it('returns null for null / empty / non-string inputs', () => {
    expect(parseMeta(null)).toBeNull()
    expect(parseMeta(undefined)).toBeNull()
    expect(parseMeta('')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseMeta('{nope')).toBeNull()
  })

  it('returns null when required fields are missing or wrong-typed', () => {
    expect(parseMeta(JSON.stringify({}))).toBeNull()
    expect(parseMeta(JSON.stringify({ savedAt: 'x', progressScore: 'oops', schemaVersion: 1, maxStage: 1 }))).toBeNull()
    expect(parseMeta(JSON.stringify({ savedAt: 'x', progressScore: NaN, schemaVersion: 1, maxStage: 1 }))).toBeNull()
  })
})

describe('SaveMergePolicy.decideMerge', () => {
  const meta = (overrides: Partial<SaveMeta>): SaveMeta => ({
    savedAt: '2026-04-27T12:00:00Z',
    progressScore: 0,
    schemaVersion: SCHEMA_VERSION,
    maxStage: 1,
    ...overrides
  })

  it('returns \'local-only\' when remote is null (network unreachable etc.)', () => {
    expect(decideMerge(meta({ progressScore: 5000 }), null)).toEqual({ kind: 'local-only' })
  })

  it('returns \'remote-only\' when local is null (truly fresh device)', () => {
    expect(decideMerge(null, meta({ progressScore: 5000 }))).toEqual({ kind: 'remote-only' })
  })

  it('returns \'remote-wins\' when remote score > local score', () => {
    const local = meta({ progressScore: 2000, maxStage: 4 })
    const remote = meta({ progressScore: 8000, maxStage: 12 })
    expect(decideMerge(local, remote)).toEqual({ kind: 'remote-wins' })
  })

  it('returns \'remote-wins\' when local was completely empty (score 0)', () => {
    const local = meta({ progressScore: 0, maxStage: 1 })
    const remote = meta({ progressScore: 8000, maxStage: 12 })
    expect(decideMerge(local, remote)).toEqual({ kind: 'remote-wins' })
  })

  it('returns \'local-wins\' when local score > remote (player advanced offline)', () => {
    const local = meta({ progressScore: 8000 })
    const remote = meta({ progressScore: 2000 })
    expect(decideMerge(local, remote)).toEqual({ kind: 'local-wins' })
  })

  it('returns \'remote-wins\' when scores tie but remote savedAt is newer', () => {
    const local = meta({ progressScore: 5000, savedAt: '2026-04-27T10:00:00Z' })
    const remote = meta({ progressScore: 5000, savedAt: '2026-04-27T11:00:00Z' })
    expect(decideMerge(local, remote)).toEqual({ kind: 'remote-wins' })
  })

  it('returns \'tie-keep-local\' when scores AND timestamps match', () => {
    const local = meta({ progressScore: 5000, savedAt: '2026-04-27T10:00:00Z' })
    const remote = meta({ progressScore: 5000, savedAt: '2026-04-27T10:00:00Z' })
    expect(decideMerge(local, remote)).toEqual({ kind: 'tie-keep-local' })
  })

  it('returns \'tie-keep-local\' when scores match and local savedAt is newer', () => {
    const local = meta({ progressScore: 5000, savedAt: '2026-04-27T11:00:00Z' })
    const remote = meta({ progressScore: 5000, savedAt: '2026-04-27T10:00:00Z' })
    expect(decideMerge(local, remote)).toEqual({ kind: 'tie-keep-local' })
  })

  it('falls back to \'tie-keep-local\' when timestamps are unparseable on a score tie', () => {
    const local = meta({ progressScore: 5000, savedAt: 'garbage' })
    const remote = meta({ progressScore: 5000, savedAt: 'also garbage' })
    expect(decideMerge(local, remote)).toEqual({ kind: 'tie-keep-local' })
  })
})
