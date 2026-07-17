import { ref, computed, type Ref } from 'vue'
import { upgradedValue } from '@/use/useEpicProgress'

// ─── Power-ups ──────────────────────────────────────────────────────────────
//
// Mario-Kart-style item-box pickups. Only ONE power-up is active at a time — a
// fresh pickup replaces the current one. Durations are the spec base values
// plus the global `powerupDuration` upgrade bonus (+0.75s/level).

export type PowerupType = 'invuln' | 'magnet' | 'dodge' | 'slowmo' | 'push'

export interface PowerupDef {
  type: PowerupType
  /** Base duration in seconds (before upgrades). */
  baseDuration: number
  /** i18n key suffix + theme colour for the HUD banner. */
  color: string
}

export const POWERUPS: Record<PowerupType, PowerupDef> = {
  invuln: { type: 'invuln', baseDuration: 6, color: '#ffd23f' },
  magnet: { type: 'magnet', baseDuration: 6, color: '#3fa9ff' },
  dodge: { type: 'dodge', baseDuration: 5, color: '#37e0a0' },
  slowmo: { type: 'slowmo', baseDuration: 5, color: '#b06bff' },
  push: { type: 'push', baseDuration: 10, color: '#ff7a3f' }
}

const ALL_TYPES: PowerupType[] = ['invuln', 'magnet', 'dodge', 'slowmo', 'push']

interface ActivePowerup {
  type: PowerupType
  /** ms timestamp (performance.now-based game clock) at which it ends. */
  endsAt: number
  /** Full duration in ms — used to render the banner's countdown fraction. */
  durationMs: number
}

const active: Ref<ActivePowerup | null> = ref(null)

/** Effective duration for a power-up type, in seconds, incl. upgrades. */
export const powerupDuration = (type: PowerupType): number =>
  POWERUPS[type].baseDuration + upgradedValue('powerupDuration')

const usePowerups = () => {
  /** Activate a power-up. `clock` is the game's monotonic ms time.
   *  `durationMult` scales the rolled duration — a LUCKY item box passes `2`
   *  for the telegraphed double-duration drop (roadmap #12); defaults to `1`. */
  const activate = (type: PowerupType, clock: number, durationMult = 1): void => {
    const durationMs = powerupDuration(type) * 1000 * durationMult
    active.value = { type, endsAt: clock + durationMs, durationMs }
  }

  /** Roll a random power-up type (uniform). */
  const randomType = (): PowerupType =>
    ALL_TYPES[Math.floor(Math.random() * ALL_TYPES.length)]!

  /** Expire the active power-up if its time is up. Call each tick. */
  const update = (clock: number): void => {
    if (active.value && clock >= active.value.endsAt) active.value = null
  }

  const isActive = (type: PowerupType): boolean => active.value?.type === type

  const clear = (): void => { active.value = null }

  const remainingMs = (clock: number): number =>
    active.value ? Math.max(0, active.value.endsAt - clock) : 0

  return { active, activate, randomType, update, isActive, clear, remainingMs }
}

/** Banner fraction (1→0) for the active power-up, given the game clock. */
export const powerupFraction = (clock: number): number => {
  if (!active.value) return 0
  return Math.max(0, Math.min(1, (active.value.endsAt - clock) / active.value.durationMs))
}

export const activePowerup = computed(() => active.value)

export default usePowerups
