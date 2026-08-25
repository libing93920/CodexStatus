# Four Distinct Themes Implementation Plan

> **For agentic workers**: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: Implement 4 premium theme previews for CodexStatus Line (`zen-wabi.html`, `vintage-cockpit.html`, `botanical-journal.html`, `liquid-chrome.html`) each with 100% custom DOM, CSS, and interactive styles, and wire them into the main `index.html` gallery.

**Architecture**: 
Each preview file is completely self-contained with its own `<style>` and `<script>` blocks (inline `countUp`, `replay`, `toggleWp`, and tab switching). There is no cross-dependency on any shared CSS or JS, preserving absolute design freedom.

**Tech Stack**: HTML5, CSS3 (gradients, animations, clip-paths, flex/grid), and Vanilla JavaScript.

## Global Constraints
- Each file must support a horizontal capsule (approx. 250x56px), a vertical orb (approx. 54x170px), and a panel (approx. 480x600px).
- All previews must display the same demo numbers: 42% (5h quota), 98% (weekly quota), 6 days reset, Terra Mx model, 3-person team (阿宁, 老王, 小柒), 7-bar usage chart.
- JavaScript must execute `replay()` on window load, setting up counts and transition animations for progress bars.
- Must support dark/light wallpaper toggle.

---

### Task 1: 🍃 枯山水·和风禅意 Theme

**Files**:
- Create: `design-previews/zen-wabi.html`
- Test: Open `design-previews/zen-wabi.html` in browser, verify console log is clean.

**Interfaces**:
- Produces: Standalone `zen-wabi.html` preview.

- [ ] **Step 1: Write HTML Structure**  
Create the skeleton with a natural bamboo/washi styled topbar, wallpaper container with custom decorative bamboo and ripple confetti elements, a mount stage for the asymmetric river-stone capsule, an Ema-styled vertical orb, and a Shoji paper-sliding panel with 3 tabs.
- [ ] **Step 2: Implement Wabi-Sabi CSS Styles**  
Add styles for `--paper`, `--ink`, `--shaku-wood`. Use asymmetric `border-radius` for the stone capsule, vertical writing styles for ranks, and paper-slat dividers for Shoji grids. 
- [ ] **Step 3: Implement Sumi Ink Bleed & Wobble Animations**  
Write keyframes for ink bleeding (slowly widening and expanding progress bar width) and the gentle hanging swing of the Ema orb (`transform: rotate(..)` loop).
- [ ] **Step 4: Implement Local JS Logic & Verify**  
Write self-contained countUp and tab-switching script. Open in browser, check that the slide-in and ink-filling plays smoothly with zero errors.
- [ ] **Step 5: Commit**  
`git add design-previews/zen-wabi.html` and commit with message `feat: add Zen & Wabi-Sabi theme`.

---

### Task 2: 🛞 机械座舱·苏式仪表 Theme

**Files**:
- Create: `design-previews/vintage-cockpit.html`
- Test: Open `design-previews/vintage-cockpit.html` in browser.

**Interfaces**:
- Produces: Standalone `vintage-cockpit.html` preview.

- [ ] **Step 1: Write HTML Structure**  
Create a cockpit-console container, with heavy steel panel headers, two circular gauge pointer elements inside the details cards, vacuum neon pressure tube for vertical orb, and heavy iron-plated tabs.
- [ ] **Step 2: Implement Heavy Military CSS Styles**  
Apply `--military-olive`, `--gauge-dial`, `--neon-amber`. Add rivets via `box-shadow` or pseudo-circles on control borders. Style numbers as nixie-tube glow.
- [ ] **Step 3: Implement Mechanical Gauge Needle & Nixie Glow Animations**  
Implement keyframe rotations for the dial needle (`.needle { transform: rotate(...) }`) with a brief overshoot inertia swing. Add slight flicker effects to numeric glow.
- [ ] **Step 4: Implement JS Needle-Update & Verify**  
Extend local JS to dynamically calculate rotation angles from telemetry attributes on load. Open and verify needles align exactly to 42% and 98% with clean animation.
- [ ] **Step 5: Commit**  
`git add design-previews/vintage-cockpit.html` and commit with message `feat: add Vintage Cockpit theme`.

---

### Task 3: 📜 植物学家手账·标本室 Theme

**Files**:
- Create: `design-previews/botanical-journal.html`
- Test: Open `design-previews/botanical-journal.html` in browser.

**Interfaces**:
- Produces: Standalone `botanical-journal.html` preview.

- [ ] **Step 1: Write HTML Structure**  
Create an open notebook design. Capsule is a gold-rimmed brass frame enclosing a maple leaf specimen. Panel represents parchment pages with hand-drawn fern drawings and tape indexes.
- [ ] **Step 2: Implement Parchment & Ink CSS Styles**  
Apply `--parchment`, `--leather`, `--forest-fir`. Style progress tracks as growing vine stems. Style buttons as round red wax stamp seals.
- [ ] **Step 3: Implement Vine Sprouting & Wax Seal Compression Animations**  
Write SVG/CSS stroke animations to make vines grow upward and push out tiny leaf sprouts. Add a soft-press indentation scale effect on wax seal button click.
- [ ] **Step 4: Implement JS Growing Track Logic & Verify**  
Wire the local JS to trigger vine path progress on load. Verify that numbers count up in hand-written cursive font (Georgia fallbacks) with zero rendering bugs.
- [ ] **Step 5: Commit**  
`git add design-previews/botanical-journal.html` and commit with message `feat: add Botanical Journal theme`.

---

### Task 4: 🪞 全息铬金·液态金属 Theme

**Files**:
- Create: `design-previews/liquid-chrome.html`
- Test: Open `design-previews/liquid-chrome.html` in browser.

**Interfaces**:
- Produces: Standalone `liquid-chrome.html` preview.

- [ ] **Step 1: Write HTML Structure**  
Create a glossy dark glass container. The capsule contains an amorphous svg mercury blob. The vertical orb contains a double helix. Panel cards have ultra-thin borders.
- [ ] **Step 2: Implement Chrome Metal & Holographic CSS Styles**  
Apply `--chrome-void`, `--acid-green`. Set up SVG blur and contrast filters (`feGaussianBlur`, `feColorMatrix`) on the capsule container to make overlapping elements merge like liquid mercury.
- [ ] **Step 3: Implement Liquid Mercury Sloshing & Edge Rainbow Shimmer Animations**  
Create liquid wave keyframes for SVG paths. Animate `conic-gradient` angle around the panel card borders to create a rotating neon refraction.
- [ ] **Step 4: Implement JS Fluid Morphing & Verify**  
Check that the CSS filter fusion runs at high FPS without lagging. Verify that progress wave scales smoothly to 42% and 98% with liquid ripples.
- [ ] **Step 5: Commit**  
`git add design-previews/liquid-chrome.html` and commit with message `feat: add Liquid Chrome theme`.

---

### Task 5: 🔗 Gallery Integration & Verification

**Files**:
- Modify: `design-previews/index.html`
- Test: Open `design-previews/index.html` in browser, verify all 10 theme card links (6 old + 4 new) work correctly.

**Interfaces**:
- Consumes: The four new HTML preview files.
- Produces: Updated comprehensive theme gallery entry.

- [ ] **Step 1: Modify Gallery CSS inside index.html**  
Add specific card styling blocks inside `index.html` `<style>` for `.card--zenwabi`, `.card--cockpit`, `.card--botanist`, `.card--chrome` matching their parent visual identity.
- [ ] **Step 2: Add Theme Cards to Gallery DOM**  
Insert 4 new `<a>` cards into the gallery grid, each with an overview paragraph, a unique set of palette swatches, and correct href links.
- [ ] **Step 3: Verify All Links and Visual Layout**  
Run a check in PowerShell to confirm all 10 files are fully balanced, with no broken file links. Verify all preview cards display beautifully in the merged gallery.
- [ ] **Step 4: Commit and Finish**  
Commit changes with message `feat: integrate 4 premium themes into index gallery`.
