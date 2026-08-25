# 4 Distinct Premium Themes Design Spec

**Date**: 2026-08-25  
**Project**: CodexStatus Line Theme Previews  
**Author**: opencode

## 1. Overview
This specification outlines the visual form language, component restyling, unique animations, and assets for 4 highly distinct premium UI theme previews. To ensure complete freedom in visual design, these themes will NOT share a rigid CSS structure. Each theme will be a standalone, self-contained HTML file containing custom DOM elements and tailored CSS styling, sharing only the core API quota telemetry mock numbers and tab behaviors.

## 2. Theme Designs

### Theme 1: 🍃 枯山水·和风禅意 (Zen & Wabi-Sabi)
*   **Filename**: `design-previews/zen-wabi.html`
*   **Aesthetic**: Natural wood, raw stones, shoji screens, brush ink, bamboo. Simple, asymmetric, wabi-sabi.
*   **Colors**:
    *   Paper/Ash: `#faf6f0`
    *   Ink: `#1c2226`
    *   Sumi Muted: `#525c66`
    *   Shaku Wood: `#d9b48f`
    *   Vermillion Red: `#b0312a`
    *   Bamboo Green: `#52705b`
*   **Capsule/Orb**:
    *   Capsule shaped as a soft, irregular river stone (using variable `border-radius: 60% 40% 50% 50% / 40% 50% 50% 60%` that shifts slightly on hover). Ink water ripples (`radial-gradient`) animate behind the progress count.
    *   Orb designed as a hanging wooden *Ema* (votive wooden tablet) with an asymmetric red string hanging at the top.
*   **Panel**:
    *   A Japanese sliding paper window (*Shoji*).
    *   Background displays a slow-swaying bamboo branch silhouette (custom CSS animation).
    *   Tabs styled as torn-edge washi paper.
    *   All buttons look like calligraphed stamp prints.
    *   Chart bars are styled as raw segmented bamboo canes.
*   **Unique Animations**:
    *   Ink bleeding: Progress bars animate like ink slowly soaking and spreading along a fiber trace.
    *   Wabi wobble: Ema tablet has a tiny random pendulum swing.

---

### Theme 2: 🛞 机械座舱·苏式仪表 (Vintage Cockpit)
*   **Filename**: `design-previews/vintage-cockpit.html`
*   **Aesthetic**: Riveted steel, heavy military green, circular mechanical dial gauges, physical toggle switches, glowing nixie tubes.
*   **Colors**:
    *   Military Olive: `#2b3629`
    *   Rust Steel: `#121611`
    *   Gauge Dial Face: `#1c211b`
    *   Fluorescent Amber: `#ffaa00`
    *   Emergency Red: `#cc1100`
    *   Dial Needle: `#ff3300`
*   **Capsule/Orb**:
    *   Capsule styled as a bolted iron panel with a small curved dial aperture. A physical dial pointer moves in a 90-degree arc tracking the percentage.
    *   Orb styled as a vertical glass vacuum pressure gauge with a glowing red filament (representing the progress bar) that shifts height.
*   **Panel**:
    *   Heavy steel dashboard console in matte olive green.
    *   Quota telemetry presented as two circular analog gauge dials. The gauge needles (`.needle`) dynamically rotate via CSS `transform: rotate(calc(var(--w) * 1.8deg - 45deg))` upon load.
    *   Tabs are heavy physical toggle levers (clack sound feel via spring-back animation).
    *   Close button is a prominent emergency shutdown button under a red cover.
*   **Unique Animations**:
    *   Needle bounce: Gauges over-rotate and settle back slightly (mechanical inertia).
    *   Nixie tube flicker: Numbers flicker during countUp mimicking hot cathode discharge.

---

### Theme 3: 📜 植物学家手账·标本室 (Botanical Journal)
*   **Filename**: `design-previews/botanical-journal.html`
*   **Aesthetic**: Pressed dried leaves, botanical illustrations, brass clips, wax seals, coffee stains.
*   **Colors**:
    *   Aged Parchment: `#e8dfc7`
    *   Rich Leather: `#422b18`
    *   Forest Fir: `#1e3825`
    *   Autumn Maple: `#a6422b`
    *   Muted Fern: `#7c8a66`
    *   Indigo Pen Ink: `#122340`
*   **Capsule/Orb**:
    *   Capsule styled as a glass specimen plate bound by a brass frame. Inside, a detailed leaf skeleton is pressed behind the progress percentage.
    *   Orb styled as a hanging leather-edged bookmark with pressed clover.
*   **Panel**:
    *   A leather journal spread open.
    *   Pages feature elegant handwritten cursive notes, faint ink stains, and hand-sketched botanical details.
    *   Charts are represented as red wine/coffee glass stains of varying heights.
    *   Progress bars are growing leafy vine stalks (CSS `stroke-dashoffset` or keyframe width animation showing tiny sprouts).
    *   Tabs are paper index tags taped to the page edge.
    *   Buttons are circular red wax seals that depress and gain small fissure cracks when clicked.
*   **Unique Animations**:
    *   Sprouting: Vine progress bar sprouts tiny leaves as it fills.
    *   Wax seal seal press: The wax seal button has a physical soft-squish compress animation.

---

### Theme 4: 🪞 全息铬金·液态金属 (Liquid Chrome)
*   **Filename**: `design-previews/liquid-chrome.html`
*   **Aesthetic**: Acid graphics, high-reflective liquid mercury, neon holographic gradients, fluid morphing.
*   **Colors**:
    *   Deep Void: `#030308`
    *   Chrome Metal: `#ffffff`
    *   Liquid Mercury Shadow: `#252530`
    *   Holographic Purple: `#7b2ff7`
    *   Acid Neon Green: `#00f5a0`
    *   Cyan Void: `#00d2ff`
*   **Capsule/Orb**:
    *   Capsule styled as an amorphous mercury blob floating in a vacuum. It uses CSS blur + contrast filter tricks to create a morphing fluid boundary.
    *   Orb is a holographic test tube with a rotating neon mercury double helix inside.
*   **Panel**:
    *   Suspended plate of chrome glass with an iridescent glow.
    *   The panel has a continuous moving neon gradient around its razor-thin edge (`conic-gradient` animation).
    *   Charts are pulsating SVG sine waves of liquid metal.
    *   Progress bar uses animated SVG wave paths to create a sloshing liquid mercury effect inside a hollow glass chamber.
    *   Tabs and buttons are floating, semi-transparent frosted acrylic tiles.
*   **Unique Animations**:
    *   Mercury morphing: Liquid capsule morphs endlessly like a lava lamp.
    *   Neon refraction: Metallic cards shimmer with rainbow light as the mouse sweeps over them.

## 3. Implementation Process
1.  Verify spec with user.
2.  Commit spec to Git.
3.  Write detailed step-by-step implementation plan.
4.  Implement each theme file independently with customized HTML/CSS/JS.
5.  Update `index.html` to catalog all 10 themes (the 6 liked ones + 4 new premium ones).
6.  Perform visual sanity and tag verification, then open the browser for validation.
