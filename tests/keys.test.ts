// Pins the literal string values of SAVE_KEYS. These keys are a contract
// with every player's localStorage — renaming them strands existing
// players' progress on the old key. `src/keys.ts` is the single source of
// truth; these values must stay byte-identical.

import { describe, expect, it } from 'vitest'
import { SAVE_KEYS } from '@/utils/save/SaveMergePolicy'
import { BEST_SCORE_KEY, NIGHTS_SURVIVED_KEY, BOSSES_CLEARED_KEY } from '@/keys'

describe('SAVE_KEYS values are stable', () => {
  it('BEST_SCORE key is the literal "ma_best_score"', () => {
    expect(SAVE_KEYS.BEST_SCORE).toBe('ma_best_score')
  })
  it('NIGHTS key is the literal "ma_nights_survived"', () => {
    expect(SAVE_KEYS.NIGHTS).toBe('ma_nights_survived')
  })
  it('BOSSES key is the literal "ma_bosses_cleared"', () => {
    expect(SAVE_KEYS.BOSSES).toBe('ma_bosses_cleared')
  })

  it('re-exports the same literals `src/keys.ts` owns', () => {
    // Guards against the two files drifting apart — the save layer's scoring
    // and the gameplay writer MUST agree on the field names, or a returning
    // player's save scores as empty and loses to a fresh install.
    expect(SAVE_KEYS.BEST_SCORE).toBe(BEST_SCORE_KEY)
    expect(SAVE_KEYS.NIGHTS).toBe(NIGHTS_SURVIVED_KEY)
    expect(SAVE_KEYS.BOSSES).toBe(BOSSES_CLEARED_KEY)
  })
})
