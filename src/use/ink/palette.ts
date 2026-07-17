// ─── The two-world palette ─────────────────────────────────────────────────
//
// Midnight Analog lives on one hard visual contrast (GDD §2): the REALITY
// frame is a moody 2.5D desk lit by a single amber flashlight, and the
// NOTEBOOK is stark white paper with ballpoint ink. Keeping both palettes in
// one file makes the juxtaposition explicit — and keeps the dive transition,
// which literally interpolates between them, honest.
//
// Values are sampled to match `src/assets/art/vision-board-gameplay.png`.

/** The desk at 3AM. Deep midnight blues and purples, warm amber pool. */
export const REALITY = {
  /** Darkest corners of the room, beyond the flashlight's reach. */
  roomDark: '#0a0d1c',
  /** Mid-room shadow — the wood of the desk out past the beam. */
  deskShadow: '#1b1830',
  /** The desk timber where the light just catches it. */
  deskWood: '#4a3526',
  /** Warm timber inside the beam. */
  deskWoodLit: '#8a5a33',
  /** The flashlight's core — a stark warm amber. */
  beamCore: '#ffd9a0',
  /** The beam's falloff edge. */
  beamEdge: '#c98a3c',
  /** The brass barrel of the torch. */
  brass: '#c9a227',
  /** Rain-streaked windowpane. */
  windowGlass: '#1e2a45',
  /** The phone's cold "no signal" glow — the only non-warm light in frame. */
  phoneGlow: '#3f6fb5',
  /** Purple bounce in the mid-shadows. */
  purpleBounce: '#332a52'
} as const

/** Inside the notebook. Paper, ballpoint, highlighter. */
export const NOTEBOOK = {
  /** Base paper white — very slightly warm, never pure #fff. */
  paper: '#f7f4ea',
  /** Paper in shadow (page curl, gutter). */
  paperShade: '#ddd7c6',
  /** The ruled horizontal lines. */
  ruleBlue: '#9fc0e8',
  /** The margin rule down the left. */
  marginRed: '#e08a92',
  /** Ballpoint ink — a dark blue-black, never pure black. */
  ink: '#1a2238',
  /** Lighter ink for construction lines / shading. */
  inkSoft: '#465070',
  /** Pencil grey for the boss's charcoal shading. */
  pencil: '#5c5c66',
  /** Red marker for the "OK" stamp and corrections. */
  markerRed: '#c62828',
  /** Green for the connected LED / success wifi waves. */
  markerGreen: '#2e9e4f'
} as const

/** Highlighter accents. Semi-transparent, multiply-blended (GDD §2.2:
 *  "splashes of vivid, semi-transparent neon highlighter"). These mark
 *  interactivity — if it glows, you can touch it. */
export const HIGHLIGHT = {
  yellow: '#ffe94d',
  cyan: '#4de1ff',
  pink: '#ff4dcd',
  green: '#7cff4d',
  orange: '#ffa23a'
} as const

/** The morning payoff — the sunrise that ends a survived night (GDD §5,
 *  vision-board panel 8: "deep blues turn to soft pinks and oranges"). */
export const MORNING = {
  skyLow: '#ffb27a',
  skyHigh: '#7fb4e8',
  sunCore: '#fff3c4',
  roomWarm: '#4a3a52'
} as const

export type HighlightColor = keyof typeof HIGHLIGHT
