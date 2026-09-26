---
name: AI Duo
description: A calm operator's desk for two coding agents, in the Codex-desktop grammar.
colors:
  canvas: "#ffffff"
  sidebar: "#f6f6f7"
  surface: "#f3f3f5"
  surface-raised: "#e9e9ec"
  hairline: "#e4e4e8"
  hairline-strong: "#d1d1d7"
  ink: "#1a1a1d"
  muted: "#55555d"
  faint: "#64646c"
  primary: "#1a1a1d"
  primary-fg: "#ffffff"
  focus: "#2a63c9"
  ok: "#17803d"
  warn: "#a35a00"
  danger: "#c8322b"
  info: "#2a63c9"
  claude: "#d97757"
  claude-fg: "#b0502c"
  codex: "#10a37f"
  codex-fg: "#0a7a5e"
  add-bg: "rgb(23 128 61 / 0.1)"
  add-fg: "#125f2e"
  del-bg: "rgb(200 50 43 / 0.09)"
  del-fg: "#9b2620"
  canvas-dark: "#17171a"
  sidebar-dark: "#111113"
  surface-dark: "#202024"
  surface-raised-dark: "#2a2a2f"
  hairline-dark: "#2b2b30"
  hairline-strong-dark: "#3b3b42"
  ink-dark: "#ececf0"
  muted-dark: "#a8a8b2"
  faint-dark: "#9a9aa4"
  focus-dark: "#6a9cf5"
  ok-dark: "#4ccb7b"
  warn-dark: "#f0b04a"
  danger-dark: "#f2736b"
  claude-fg-dark: "#e8916f"
  codex-fg-dark: "#3fcca0"
  add-bg-dark: "rgb(76 203 123 / 0.12)"
  add-fg-dark: "#8fe0ab"
  del-bg-dark: "rgb(242 115 107 / 0.12)"
  del-fg-dark: "#f8a39d"
typography:
  headline:
    fontFamily: "system-ui, 'Segoe UI Variable Text', 'Segoe UI', -apple-system, 'Helvetica Neue', sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.02em"
  title:
    fontFamily: "system-ui, 'Segoe UI Variable Text', 'Segoe UI', -apple-system, 'Helvetica Neue', sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, 'Segoe UI Variable Text', 'Segoe UI', -apple-system, 'Helvetica Neue', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
    fontFeature: "tnum"
  body-ui:
    fontFamily: "system-ui, 'Segoe UI Variable Text', 'Segoe UI', -apple-system, 'Helvetica Neue', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, 'Segoe UI Variable Text', 'Segoe UI', -apple-system, 'Helvetica Neue', sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: "system-ui, 'Segoe UI Variable Text', 'Segoe UI', -apple-system, 'Helvetica Neue', sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.4
  mono-data:
    fontFamily: "ui-monospace, 'Cascadia Code', 'Cascadia Mono', 'SF Mono', Consolas, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.6
  mono-code:
    fontFamily: "ui-monospace, 'Cascadia Code', 'Cascadia Mono', 'SF Mono', Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  code: "5px"
  md: "6px"
  lg: "8px"
  pre: "10px"
  xl: "12px"
  2xl: "16px"
  composer: "20px"
  full: "9999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  8: "32px"
  10: "40px"
components:
  button-send:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-fg}"
    rounded: "{rounded.full}"
    size: "32px"
  button-send-disabled:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.faint}"
    rounded: "{rounded.full}"
    size: "32px"
  chip:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "0 8px"
    height: "28px"
  chip-hover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  button-icon:
    textColor: "{colors.muted}"
    rounded: "{rounded.lg}"
    size: "32px"
  button-icon-hover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  button-stop:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  input-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-ui}"
    rounded: "{rounded.lg}"
    padding: "6px 10px"
  composer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.composer}"
  sidebar-row:
    textColor: "{colors.muted}"
    typography: "{typography.body-ui}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  sidebar-row-active:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
  prompt-bubble:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.2xl}"
    padding: "10px 16px"
  verdict-badge:
    textColor: "{colors.ok}"
    rounded: "{rounded.full}"
    padding: "1px 8px"
  popover:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.xl}"
    padding: "4px"
  menu-item:
    textColor: "{colors.ink}"
    typography: "{typography.body-ui}"
    rounded: "{rounded.lg}"
    padding: "6px 10px"
---

# Design System: AI Duo

## Overview

**Creative North Star: "The Operator's Desk"**

AI Duo is a quiet, native-feeling desktop tool that a single developer keeps open for hours while two coding agents work. The system is the Codex-desktop grammar, pinned by the user: neutral greys, a slightly darker sidebar, hairline borders, a rounded composer with chip controls, a round primary send, system UI type, and mono reserved for code and data. Nothing is decorative. Everything on screen is either progress, a control, or content the user asked to see.

Density is set for scanning, not for reading at a distance. Body copy runs at 14px, controls and rows at 12.5 to 13px, metadata at 11.5px, and a single conversation column (max 760px) carries the story of a run. Detail (reasoning, tool output, the diff) sits one click away behind collapsible rows with a rotating chevron, never forced open. Light and dark are both first-class and share one semantic token set; the theme follows the OS unless the user pins it.

Colour is withheld until it means something. The canvas is achromatic; hue appears only for state (running, done, error, warning, verdict) and for the two agents, Claude and Codex, who are always shown by name plus colour and never ranked visually against each other. It rejects the dashboard-of-cards and the side-by-side "versus" layout.

**Key Characteristics:**
- Achromatic greys with hairline (1px) borders; depth by tone, not by shadow.
- Two agent hues of equal weight, each with a separate text variant tuned for contrast.
- System UI type throughout; mono only for code, paths, models, token counts and diffs.
- One primary action per view: the composer and its round send button.
- Progressive disclosure: collapsed turns show a two-line excerpt; everything else expands in place.

## Colors

A neutral grey ramp carries the whole interface; saturated colour is reserved for state and for the two agents.

### Primary
- **Ink Primary** (`primary`): the one filled control, the round send button. It is the ink colour itself (near-black in light, near-white in dark), so the primary action reads as weight, not hue.
- **Focus Blue** (`focus`): keyboard focus rings (2px outline, 2px offset) and focused input borders; also the base of text selection (28% mix).

### Secondary
- **Claude Terracotta** (`claude`): the Claude agent dot, the brand mark's left disc, and the Claude model picker dot. Brand commitment from PRODUCT.md.
- **Claude Text** (`claude-fg`, dark `claude-fg-dark`): the "Claude" name in turn headers. Darker in light, lighter in dark, so the name stays at or above 4.5:1 on both grounds.

### Tertiary
- **Codex Green** (`codex`): the Codex agent dot and the brand mark's right disc (at 90% opacity where it overlaps).
- **Codex Text** (`codex-fg`, dark `codex-fg-dark`): the "Codex" name in turn headers, contrast-tuned the same way.

### State
- **Info Blue** (`info`): "Đang chạy" status, running spinners, markdown links.
- **Verdict Green** (`ok`): done status, AGREE/APPROVE badges, copy-confirmed checks, CLI-found dots.
- **Amber Warn** (`warn`): REVISE/CHANGES_REQUESTED badges and the reconnect banner (on `warn` at 10%).
- **Signal Red** (`danger`): errors, failed exit codes, the Stop button's hover state, error panels (on `danger` at 8%).
- **Diff Add / Diff Delete** (`add-bg`/`add-fg`, `del-bg`/`del-fg`): diff rows and the +N / −N counts in the top bar and changes panel. Always mono.

### Neutral
- **Canvas** (`canvas`): main pane, changes panel, composer, popovers, inputs.
- **Sidebar Grey** (`sidebar`): the thread sidebar, one step darker than the canvas (in dark, one step deeper: `sidebar-dark`).
- **Surface** (`surface`): hover fills in the main pane, the user's prompt bubble, code blocks, tool output, diff hunk headers.
- **Surface Raised** (`surface-raised`): hover and active fills in the sidebar (where `surface` would not separate from the sidebar grey), disabled send.
- **Hairline / Hairline Strong** (`hairline`, `hairline-strong`): every border and divider; strong for composer focus-within, input hover, scrollbar thumbs, blockquote rules.
- **Ink / Muted / Faint** (`ink`, `muted`, `faint`): primary text, secondary text and controls at rest, metadata and placeholders. All three pass AA on canvas, sidebar and surface in both themes.

### Named Rules
**The Earned Hue Rule.** A pixel is chromatic only if it reports state, an agent, or a diff line. Surfaces, borders, headings and controls stay grey.

**The Name-Plus-Colour Rule.** An agent colour never appears without the agent's name beside it (turn headers, model pickers), and the two agents always get identical treatment in size, weight and position.

**The Two-Variant Rule.** Any hue used as text gets its own `-fg` variant per theme; the fill hue is never reused as text on a ground where it fails 4.5:1.

## Typography

**Body Font:** system-ui (Segoe UI Variable Text on Windows, with -apple-system, Helvetica Neue fallback)
**Mono Font:** ui-monospace (Cascadia Code / Cascadia Mono, SF Mono, Consolas)

**Character:** The OS's own UI face, so the app feels native in its Electron window; tabular numerals are on globally so timers and counts don't jitter. Mono marks anything machine-shaped.

### Hierarchy
- **Headline** (600, 26px, -0.02em, balanced): the empty-state question only. There is no display tier.
- **Title** (600, 13.5px): the thread title in the top bar, "Kết quả / Giải pháp cuối", and agent names in turn headers. Titles are set by weight, not size.
- **Body** (400, 14px, 1.65 in markdown / 1.5 base): agent output, the prompt bubble (1.6), the composer textarea (14.5px, relaxed). Column capped at 760px.
- **Body UI** (400, 13px): sidebar rows, menu items, turn phase labels, collapsed excerpts.
- **Label** (500, 12.5px): chips, buttons, the Stop control, form labels; 12px for top-bar metadata and status text.
- **Caption** (400, 11.5px): timestamps, phase separators (500), the changes-panel note, verdict badges at 11px/600.
- **Mono Data** (11.5 to 12px): model names, token and cost figures, tool-call labels, file paths, diff tables (11.5px, 1.6). **Mono Code** (12.5px, 1.55) for fenced code blocks; inline code at 0.86em.

Markdown headings inside agent output are deliberately small (1.2rem / 1.07rem / 0.95rem, weight 600) so a reply never out-shouts the chrome around it; inside the prompt bubble every heading collapses to 14px.

### Named Rules
**The Mono-Means-Machine Rule.** Mono is for text a machine produced or consumes: code, paths, models, commands, counts, diffs. Never for labels, headings or prose.

**The Weight-Not-Size Rule.** Hierarchy inside the working views comes from weight (600 vs 400) and ink (ink / muted / faint), within a 11.5 to 14.5px band. Only the empty state uses a headline.

## Layout

Three columns on desktop: a 264px sidebar, a flexible main pane, and an optional changes panel at `min(40vw, 560px)` from the `lg` breakpoint (1024px), separated by hairlines. The main pane has a 48px top bar (title, project, status, progress, mode, token total, compact toggle, diff count, Stop), a scrolling conversation column centred at max 760px with 20px side padding, and the composer docked beneath it inside the same 760px measure. The empty state centres a 720px column vertically: headline, one-line explanation, the hero composer, three starter rows, CLI status.

Rhythm runs on a 4px base: 4 and 8px inside controls, 12 to 20px between turns (`space-y-5`), 32 to 40px between major blocks (prompt to turns, turns to result). Controls are 28px (chips, small icon buttons) or 32px (rows, icon buttons, send, Stop).

Responsive behaviour drops information before it drops structure: below `md` (768px) the sidebar becomes an off-canvas drawer with a 40% black scrim and a menu button appears in the top bar; below `lg` the changes panel becomes a full-screen overlay and top-bar metadata collapses to a single running-progress line; model names hide below `md`, per-turn token counts below `lg`, the run total below `xl`.

### Named Rules
**The One Column Rule.** A run is told in one column. Agents are never placed side by side, and results are not split into cards.

## Elevation & Depth

Depth is tonal: canvas, a darker sidebar, `surface` fills for hover and quoted content, hairline borders for structure. Shadows exist in exactly two roles, both theme-aware.

### Shadow Vocabulary
- **Card** (`--shadow`: `0 1px 2px rgb(20 20 30 / 0.05), 0 10px 28px -14px rgb(20 20 30 / 0.18)`; dark `0 1px 2px rgb(0 0 0 / 0.3), 0 12px 32px -14px rgb(0 0 0 / 0.6)`): the composer, which is the one resting surface allowed to lift, and the floating "jump to latest" pill.
- **Pop** (`--shadow-pop`: `0 4px 10px -2px rgb(20 20 30 / 0.1), 0 16px 40px -12px rgb(20 20 30 / 0.22)`; dark `0 4px 12px -2px rgb(0 0 0 / 0.4), 0 18px 44px -12px rgb(0 0 0 / 0.7)`): popovers and menus, and the sidebar when it opens as a mobile drawer.

### Named Rules
**The Only-The-Composer-Floats Rule.** At rest, the composer is the only lifted surface. Everything else is flat and separated by tone or hairline; shadow-pop is for things that sit above the page temporarily.

## Shapes

Soft, rounded rectangles that grow with the object's size: 5px on inline code, 6px on small icon buttons and tool rows, 8px on chips, rows, inputs and menu items, 10px on code blocks, 12px on popovers and starter rows, 16px on the prompt bubble and result block, 20px on the composer. Circles are reserved for status: the send button, agent and status dots (8px and 6px), the brand's two overlapping discs, verdict badges, the jump pill, scrollbar thumbs. Borders are always 1px hairlines; the only thicker line is the 2px focus ring. The one left rule in the system is the 2px blockquote border and the tool-call list's 1px tree line, both neutral.

## Components

### Buttons
Quiet by default: almost every button is a ghost that only gains a fill on hover.
- **Send (primary):** 32px circle in Ink Primary with an up-arrow; hover drops to 85% opacity, press scales to 95%; disabled turns to Surface Raised with faint arrow; shows a spinner while submitting.
- **Icon button:** 32px (28px in the changes panel) square, 8px radius (6px when 28px), muted icon at 16px; hover fills `surface` and inks the icon.
- **Stop:** the only outlined button. 32px, hairline border, filled square glyph plus label; hover shifts border, fill (8%) and text to `danger`. Present in the top bar whenever a run is running.
- **Text action:** "Xem toàn bộ", "Xem thay đổi": 12.5px muted, ink on hover, underline on hover where it navigates.

### Chips
- **Style:** the composer's controls (project, mode, agent/model, advanced). 28px high, 8px radius, 12.5px/500 muted with a 14px leading icon and a 12px chevron at 60% opacity. No border and no fill at rest.
- **State:** hover and `aria-expanded` share one state: `surface` fill and ink text. Disabled at 50% opacity.

### Verdict Badge
Pill, 11px/600, 1px 8px padding, text in the state colour over the same colour at 10% with a 25% inset ring. Green for AGREE / APPROVE ("Đồng ý", "Approve"), amber for REVISE / CHANGES_REQUESTED ("Cần sửa", "Yêu cầu sửa"). The raw verdict is in the tooltip.

### Cards / Containers
- **Prompt bubble:** right-aligned, max 88% width, `surface` fill, 16px radius, 10px 16px padding, no border. Long prompts clamp at 256px with a bottom fade mask and a "Xem toàn bộ" toggle.
- **Result block:** 16px radius, hairline border, `surface` at 60%, 16px 20px padding, preceded by a title row with copy action.
- **Error panel:** `danger` at 8% fill, danger text in mono, 8 to 12px radius, no border.
- **Code / tool output:** `surface` fill, hairline border, 8 to 10px radius, mono 11.5 to 12.5px, max height 256px with internal scroll for tool output.

### Inputs / Fields
- **Composer:** 20px radius, hairline border, canvas fill, card shadow. Textarea is borderless 14.5px with faint placeholder (96px min in the hero, 44px docked). Focus-within strengthens the border to `hairline-strong`; there is no ring on the textarea itself. Chip row sits under the text, send at the right.
- **Field** (advanced options, custom path): 8px radius, hairline border, canvas fill, 13px, 6px 10px padding; hover strengthens the border, focus turns it Focus Blue with no outline. Paths and commands are typed in mono.

### Navigation
- **Sidebar:** 264px, `sidebar` grey, right hairline. Header 48px with the two-disc mark and "AI Duo" at 14px/600. "Phiên mới" (with Ctrl N key hint) and the search field are 32px rows. Threads group under project folders (12px/500 faint headers with a rotating chevron, count revealed on hover). Rows are 32px, 13px, 8px radius: muted at rest, `surface-raised` fill and ink when active or hovered. Leading status mark: blue spinner when running, red dot for error, faint dot for cancelled, empty slot when done. Trailing: relative time (faint), or "Đang chạy" in info blue. The theme cycler (system / light / dark) is pinned at the bottom above a hairline.
- **Mobile:** the sidebar slides in over a 40% black scrim (200ms ease-out) with shadow-pop and a close button.

### Popover / Menu
Opens upward from composer chips. 12px radius, hairline border, canvas fill, shadow-pop, 4px inner padding, 256px default width. Group labels 11.5px/500 faint; items 13px with optional muted 14px icon, faint 12px hint line, and a check for the selected option. Arrow keys move between items; Escape and outside press close and return focus to the trigger.

### Turn Row (signature)
The unit of a run. A full-width hover row: 8px agent dot, agent name in its `-fg` colour at 13.5px/600, phase label muted 13px, optional verdict badge, then right-aligned faint metadata (model in mono, token/cost in mono, error, spinner, elapsed time in tabular figures, rotating chevron). Collapsed, it shows a two-line muted excerpt indented 16px; expanded, it shows markdown, tool-call groups ("Chạy N lệnh · sửa N file") that expand into a tree of mono command rows with exit codes, and info or error lines. A running turn with no output breathes "Đang suy nghĩ…" (faint, opacity 0.55 to 1 over 1.8s). Phases and rounds are separated by a centred 11.5px/500 faint label between two hairlines.

### Diff View
Per-file sections with a sticky canvas header: rotating chevron, mono path with the directory faint and the basename ink, "mới / đã xoá" tag, +N / −N counts. The table is mono 11.5px at 1.6 line height with two faint line-number gutters, a +/− mark column, `add-bg`/`del-bg` row fills with `add-fg`/`del-fg` text, and hunk headers on `surface`. The changes panel opens with a hairline note that nothing is committed.

## Do's and Don'ts

### Do:
- **Do** route every colour through the semantic tokens so light and dark stay in lockstep; set a pinned theme on `data-theme` before first paint and leave it unset to follow the OS.
- **Do** pair every agent colour with the agent's name and give Claude and Codex identical size, weight and placement.
- **Do** use the `-fg` text variant (never the fill hue) whenever an agent or state colour is text.
- **Do** keep detail collapsed behind a chevron row and show a one-to-two-line summary when closed.
- **Do** set code, paths, models, commands, counts and diffs in mono, and everything else in the system UI face.
- **Do** keep hover as a `surface` fill (`surface-raised` inside the sidebar), and focus as the 2px Focus Blue outline with 2px offset.
- **Do** honour `prefers-reduced-motion`: all animation and transition collapses to near zero; motion is limited to 150 to 200ms colour, chevron and drawer transitions, the spinner, and the thinking breathe.

### Don't:
- **Don't** introduce a brand accent or tint on surfaces, borders or headings; hue is reserved for state, agents and diffs.
- **Don't** place the two agents side by side or build a dashboard of cards; one column tells the run.
- **Don't** add shadows to resting surfaces other than the composer.
- **Don't** add filled or coloured buttons beyond the round send; Stop is outlined and turns red only on hover.
- **Don't** use OpenAI or Anthropic logos or product branding; agents are identified by name and colour only.
- **Don't** use mono for labels or headings, or raise working-view type above 14.5px.
