# Midnight Analog — Game Design

# GAME DESIGN DOCUMENT: MIDNIGHT ANALOG

**Version:** 1.0
**Project Status:** Game Jam Production Ready  
**Target Platform:** PC (Web/WebGL / Desktop)  
**Core Themes:** 3AM Idea + Waiting for Wi-Fi

---

## 1. EXECUTIVE SUMMARY

### 1.1 The Pitch
*Midnight Analog* is a cozy yet chaotic, hand-drawn *WarioWare*-style micro-game collection. Set in a remote lakeside cabin during a heavy summer storm, the power is out, the Wi-Fi is down, and it’s 3:00 AM. Players assume the role of a bored, sleepless teenager who uses a flashlight and a spiral-bound notebook to escape reality. Every strange idea jotted down in the notebook instantly transforms into a frantic, 5-second playable doodle.

### 1.2 Core Hook & Value Proposition
* **The High-Contrast Loop:** Seamlessly flips between a moody, atmospheric, ultra-polished 3D/2.5D reality frame (the desk) and a high-octane, chaotic, 2D notebook world.
* **Extreme "Juice" Design:** Built from the ground up to maximize sensory feedback (impact frames, screen shake, tactile scribbling audio) to capture game jam judges instantly.
* **Scope Resilience:** The micro-game anthology format offers absolute scope protection. If development runs behind, micro-games can be cleanly severed; if ahead, more can be hot-plugged without breaking the architecture.

---

## 2. ART & VISUAL STYLE

The game relies on an extreme visual juxtaposition between the **Framing Reality** and the **Notebook Dimension**.

```
+-------------------------------------------------------------+
| REALITY FRAME: Moody, 2.5D, Low-Poly / Deep Amber Shadows  |
|                                                             |
|   +-----------------------------------------------------+   |
|   | NOTEBOOK DIMENSION: 2D Raw Paper, Jittery Scribbles |   |
|   | Ink Bleeds, Highlighter Neon, 12 FPS Stepped Anim   |   |
|   |                                                     |   |
|   |                  [ MICRO-GAME LOOP ]                |   |
|   +-----------------------------------------------------+   |
+-------------------------------------------------------------+
```

### 2.1 The Framing Reality (The Desk)
* **Aesthetic:** Atmospheric, low-poly or cinematic 2.5D. Dominated by deep midnight blues, rich purples, and casting shadows.
* **Lighting:** The sole light source is a stark, cone-shaped warm amber beam from an old brass flashlight sitting on the desk.
* **Environment Details:** Raindrops running down a dark windowpane in the background, a crumpled bag of chips, an offline smartphone glowing with a cycling "Searching for Network..." spinner, and a steaming mug of cocoa.

### 2.2 The Notebook Dimension (The Gameplay Page)
* **Canvas Texture:** A highly-textured, scan-line or grain-mapped ruled paper texture. Page margins are bright red; horizontal lines are light blue.
* **Line Art:** Everything inside the notebook looks like hand-sketched black or dark-blue ballpoint pen doodles. Lines must feature a **"boiling/jittering" effect** (cycling between 3 alternate drawings of the same frame to convey manic kinetic energy, locked at 12 frames per second).
* **Interactive Elements / Accents:** Splashes of vivid, semi-transparent neon highlighter colors (Yellow, Cyan, Hot Pink) denote active UI prompts, danger zones, or interactive objects.
* **The Cursor:** Stylized as a massive, rough pen-drawn hand with pointing or grabbing poses that shift based on context.

---

## 3. GAMEPLAY & CORE LOOP

The game operates on a rapid, escalating cycle of tension and release.

```
                  +-----------------------+
                  |  Start Session (3AM)  |
                  +-----------+-----------+
                              |
                              v
                  +-----------------------+
         +------> |  Display Instruction  | (1.5s Text Flash)
         |        +-----------+-----------+
         |                    |
         |                    v
         |        +-----------------------+
         |        |   Run Micro-Game      | (5s Max Ticking Match)
         |        +-----------+-----------+
         |                    |
         |                    +---------+
         |                    |         |
         |         (Success)  v         v  (Failure)
         |         +------------+     +------------+
         |         | Gain Win   |     | Lose Heart |
         |         | Speed Up   |     | Screen Rip |
         |         +------------+     +------------+
         |                    |         |
         |                    +----+----+
         |                         |
         +-------------------------+
                    | (After X Games)
                    v
         +-----------------------+
         |       Boss Stage      | (Extended 30s Puzzle)
         +-----------------------+
```

1. **The Briefing:** A punchy, one-word verb instruction flashes in huge, raw marker ink across the center of the screen (e.g., *"SMASH!"*, *"SWAT!"*, *"BALANCED!"*) accompanied by a deep bass thump. (1.5 seconds)
2. **The Execution:** The player has exactly 5 seconds to solve the physical or spatial puzzle using mouse movements/clicks or basic keyboard keys.
3. **The Judgment:** Success immediately plays a high-pitched chime, stamping the page with a thick crimson **"OK"** or a star. Failure triggers a paper-ripping sound, crossing out the page in heavy black ink.
4. **The Escalation:** After every 4 games, the transition speed accelerates by 10%, the lo-fi background beat pitches up, and the jitter frequency of the pencil sketches amplifies.

---

## 4. DETAILED MINI-GAME FUNCTIONALITY

### 4.1 Micro-Game 1: Disconnect (Verb: "SMASH!")
* **Visuals:** A shaky, hand-drawn network router sitting on a blue ledger line. A giant, thick, coiled power cable hangs out loosely, violently snapping back and forth like a severed live wire. A bright red, pixelated LED blinks angrily on the router face.
* **Objective:** Force the power cord back into the port.
* **Mechanics & Input:** * The player’s cursor transforms into a heavy, sketch-shaded hand.
    * The player must left-click and hold the end of the thrashing power cord to grab it.
    * The cord uses basic 2D Verlet rope physics, creating elastic drag. The player must physically drag the mouse cursor downward and drop it perfectly over the flashing red port within the time limit.
* **Win Condition:** Cord collides with the target area. The LED flashes neon-green, a large marker wave of Wi-Fi signals arcs outward, and a booming mechanical *"CLACK"* plays.
* **Lose Condition:** Timer hits zero before connection. The router explodes into an ink splatter, leaving a dark smudge on the paper.

### 4.2 Micro-Game 2: Mosquito Slap (Verb: "SWAT!")
* **Visuals:** A extreme close-up of a freckled, hairy forearm drawn across the notebook page. Three stylized cartoon mosquitoes with giant glowing red eyes and transparent vibrating wings hover over different parts of the skin.
* **Objective:** Slap all mosquitoes matching the rhythmic contraction rings.
* **Mechanics & Input:** * A rhythm-action mechanic. Each mosquito features an outer circle that rapidly shrinks toward its body.
    * The player must hover their cursor over a mosquito and left-click *exactly* when the outer ring collapses into the inner circle.
* **Win Condition:** All three pests are clicked with precise timing. Each successful click triggers a giant comical hand overlay slamming onto the arm with a loud **"SMACK!"** textual pop-up and a splatter of red ink.
* **Lose Condition:** Missing the timing window or running out of time. The mosquito stings, a red highlighter lump swells up on the arm, and a tiny, irritating high-pitched buzzing audio clip plays loop-style.

### 4.3 Micro-Game 3: Melt (Verb: "BALANCE!")
* **Visuals:** A three-scoop ice cream cone (Mint, Berry, Chocolate) rendered in heavy, rough cross-hatched shading. The top scoop is heavily leaning over to the left, dripping thick neon-pink droplets down towards a hand-drawn pristine white rug at the bottom of the page.
* **Objective:** Keep the melting ice cream centered on the cone.
* **Mechanics & Input:**
    * A physics balancing game. The cone acts as a pivot.
    * Moving the mouse cursor rapidly left and right across the upper half of the screen creates "wind gusts," visually represented by beautiful, sweeping blue sketch lines.
    * The player must blow wind from the left or right to counteract the tipping physics of the melting ice cream scoops.
* **Win Condition:** Keep the vertical center of mass of the ice cream within a 15-degree safe arc for 5 consecutive seconds.
* **Lose Condition:** The ice cream tips past 45 degrees. The scoops slip entirely off the cone, crashing onto the rug with a wet splat sound, and the text **"RUINED!"** gets heavily scribbled over the interface.

### 4.4 Boss Game: Find The Signal (Verb: "TUNE IT!")
* **Visuals:** An expansive, double-page landscape drawing modeled loosely after a scratchy, charcoal version of a starry night sky. The player’s doodle avatar stands precariously on top of a jagged pencil-drawn roof holding a giant metal Yagi/rabbit-ear TV antenna. The entire viewport is obscured by dense, opaque layers of grey cross-hatched pencil shading that simulates analog TV static.
* **Objective:** Rotate the antenna to clear the static and capture a signal before the storm knocks out the transmission.
* **Mechanics & Input:**
    * This is an extended, 20-second multi-phase encounter.
    * The player moves the mouse in a wide circular pattern to rotate the antenna.
    * As the antenna approaches the hidden "hot spot" angle (randomized each run), the dense grey pencil shading begins to fade out smoothly, and loud, harsh acoustic white noise static transitions into a crystal-clear, retro synth melody.
    * Once the angle is found, the player must hold still for 3 seconds while a progress bar (styled as a filling ink tube) charges up.
* **Win Condition:** Progress bar fully fills. The static vanishes completely, revealing a beautifully vibrant, colored marker drawing of a clear morning sky. The camera zooms out smoothly back to the real-world 2.5D desk frame.
* **Lose Condition:** Timer expires. A bolt of highlighter-yellow lightning cuts across the page, ripping it in half, returning the player to the desk with a completely burnt notebook edge.

---

## 5. THE JUICE & POLISH SYSTEM

To secure game jam victories, *Midnight Analog* implements specific game-feel enhancements:

* **Impact Frames:** On successful hits (like the Mosquito Smash), the entire rendering engine flashes inverted black-and-white colors for 2 frames to create maximum visual impact.
* **Dynamic Screen Shake:** Camera shake profile varies based on the action. Router smashing creates a low-frequency, heavy structural thud shake; mosquito slapping creates a high-frequency, sudden snapping jar.
* **Paper Physics:** When moving between micro-games, the next page doesn't just cut in. It uses a custom vertex shader that warps and bends the mesh to emulate a physical paper sheet being aggressively flipped or crumpled by a hand.
* **The Tactile Audio Suite:** Every UI interaction must sound material. Clicking buttons must sound like a heavy mechanical pencil clicking or a marker cap popping off. Pausing the game should sound like closing a thick leather-bound book.


## General
In GENERAL for all work: Do your work on an ultra high-fidelity basis, don't do just good enough! that's important. Make the interactions feel real good,
add vfx juice where applicable (take care of optimizing to not overload the CPU/GPU).
Don't take shortcuts to save on tokens or implementation time.

The game starts right into the first scene and has no usual main-menu.

The game needs to be fully responsive (all mobile orientations, min portrait sizes: 320x658px, tablet and desktop sizes) and optimized for mobile portrait and landscape play,
but also tablets and desktop (up to fullscreen). Don't use fixed pixel values if possible, use percentage or vw and vh to define size relations.
Take safe-area into account. Take into account that images are
not selectable like in normal web environments, but allow drag and click events to perform game logic.
Follow web-game standards: fast jump into the game by optimizing hot-path loading and delaying uncritical assets until after
the game has started to show.

Save all state variables in one object named `midnight_state`.

---

## After implementing the game -> Roadmap
create a roadmap(min 15 features/action points, sorted by highest impact, best performance, highest game feel improvements)
for future features that would increase the Day1 retention, the average playtime, the easy-to-pickup and hard-to-put-down
metrics, that increase conversion of new players with actionable implementations suggestions. So that I can tackle these features later if I value them benefical.
