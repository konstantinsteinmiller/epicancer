import { onMounted, onUnmounted, ref } from 'vue'
import { toggleDebug } from '@/use/useMatch'

// `cheat` stays a top-level localStorage flag — it's an explicit dev toggle
// that gates the whole keyboard-shortcut module, so we don't want it living
// inside the gameplay save blob (where a cloud restore could re-enable
// cheats on a clean device).
const storedCheat = localStorage.getItem('cheat') || 'false'
const isCheat = ref<boolean>(JSON.parse(storedCheat))

// ─── Always-on key-sequence cheat: type "cmarc" to flip debug mode. ──────
//
// Sits OUTSIDE the `useCheats` factory so it works even when the regular
// cheat module is gated off — flipping `isDebug` is itself the entry point
// to dev tooling (editor button, perf meter, etc.).
//
// Exported + idempotent so a boot-time caller (App.vue setup) can guarantee
// it installs at app start. The old module-level `installDebugUnlock()` call
// only ran when this file's side-effects were retained — but App.vue's bare
// `import useCheats` is tree-shaken in production (the default export is never
// called there), and the only other importer is the LAZY game scene, so on a
// built bundle the sequence listener wasn't attached until the player was
// already in-game (and never at all if they typed it on the menu). Calling
// the exported initialiser from executed setup code can't be tree-shaken.
let debugUnlockInstalled = false
export const installDebugUnlock = (): void => {
  if (typeof window === 'undefined' || debugUnlockInstalled) return
  debugUnlockInstalled = true
  const target = 'cmarc'
  let buf = ''
  const isTypingTarget = (el: EventTarget | null): boolean => {
    if (!(el instanceof HTMLElement)) return false
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    return el.isContentEditable
  }
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) { buf = ''; return }
    const k = e.key.toLowerCase()
    // Non-character keys (Shift, Tab, arrow keys) don't reset the buffer
    // outright — they just don't extend it — so the cheat survives a stray
    // modifier press. Anything else of length 1 gets appended.
    if (k.length !== 1) return
    buf = (buf + k).slice(-target.length)
    if (buf === target) {
      buf = ''
      toggleDebug()
    }
  })
}
// Best-effort module-level install for dev (vite serve keeps side-effects);
// App.vue also calls installDebugUnlock() in setup so production builds — where
// this bare side-effect can be tree-shaken — still attach the listener at boot.
installDebugUnlock()

// ─── Debug hook registry ───────────────────────────────────────────────────
//
// The cheat shortcuts drive the running game (force a win, jump to the boss,
// refill hearts), but this module is imported by App.vue at boot while the
// game scene is lazy. Importing `useMidnightGame` here would both pull the
// gameplay chunk into the entry bundle and create a cycle (the scene imports
// the cheats). So the scene REGISTERS its handlers on mount instead, and the
// shortcuts no-op harmlessly whenever no scene is mounted.

export interface CheatHooks {
  /** Force the running micro-game to resolve as a win. */
  winRound: () => void
  /** Force the running micro-game to resolve as a loss. */
  loseRound: () => void
  /** End the current micro-game and queue the boss as the next page. */
  jumpToBoss: () => void
  /** Refill the heart track to full. */
  refillHearts: () => void
  /** Skip the desk intro straight into the notebook. */
  skipIntro: () => void
  /** Jump to the morning payoff / summary page. */
  jumpToMorning: () => void
}

let hooks: Partial<CheatHooks> = {}

/** Called by the game scene on mount. Returns an unregister function for
 *  unmount so a stale scene's closures can't be driven after teardown. */
export const registerCheatHooks = (next: Partial<CheatHooks>): (() => void) => {
  hooks = next
  return () => { hooks = {} }
}

const run = (name: keyof CheatHooks, label: string) => () => {
  const fn = hooks[name]
  if (!fn) {
    console.warn(`[CHEAT] ${label} — no game scene mounted.`)
    return
  }
  fn()
  console.warn(`[CHEAT] ${label}`)
}

const useCheats = () => {
  if (!isCheat.value) return {}

  const cheatsMap: Record<string, () => void> = {
    'ctrl+shift+1': run('winRound', 'Forced round WIN.'),
    'ctrl+shift+2': run('loseRound', 'Forced round LOSS.'),
    'ctrl+shift+3': run('refillHearts', 'Hearts refilled.'),
    'ctrl+shift+alt+b': run('jumpToBoss', 'Boss queued as next page.'),
    'ctrl+shift+alt+s': run('skipIntro', 'Skipped the desk intro.'),
    'ctrl+shift+alt+m': run('jumpToMorning', 'Jumped to the morning payoff.')
  }

  const heldKeys = new Set<string>()
  const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta'])

  const normalizeKey = (e: KeyboardEvent): string | null => {
    const codeMatch = e.code.match(/^Digit(\d)$/)
    if (codeMatch) return codeMatch[1]!
    const k = e.key.toLowerCase()
    return MODIFIER_KEYS.has(k) ? null : k
  }

  const buildShortcut = (e: KeyboardEvent): string => {
    const parts: string[] = []
    if (e.ctrlKey || e.metaKey) parts.push('ctrl')
    if (e.shiftKey) parts.push('shift')
    if (e.altKey) parts.push('alt')
    const sorted = [...heldKeys].sort()
    parts.push(...sorted)
    return parts.join('+')
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const key = normalizeKey(e)
    if (key) heldKeys.add(key)
    const shortcut = buildShortcut(e)
    if (cheatsMap[shortcut]) {
      e.preventDefault()
      cheatsMap[shortcut]!()
    }
  }

  const handleKeyUp = (e: KeyboardEvent) => {
    const key = normalizeKey(e)
    if (key) heldKeys.delete(key)
  }

  const handleBlur = () => {
    heldKeys.clear()
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown, { passive: false })
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('keyup', handleKeyUp)
    window.removeEventListener('blur', handleBlur)
  })

  return { isCheat }
}

export default useCheats
