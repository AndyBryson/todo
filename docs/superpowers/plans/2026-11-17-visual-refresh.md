# Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the app to the approved "colourful lanes" look (mockup C without the gradient) on desktop and phone, light and dark.

**Architecture:** One stylesheet (`src/ui/app.css`) gets a full set of design tokens for light and dark, then component styles are reworked against them. Markup changes are limited to hooks the styles need: a column colour custom property, a list-colour custom property on cards, and pill classes in the top bar.

**Tech Stack:** existing: Preact, plain CSS, system font. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-visual-refresh-design.md`. Read `CLAUDE.md` first.

## Global Constraints

- Colours, exactly: top bar `#3b5bdb`; page `#f2f4f8`; column headers Backlog `#868e96`, Next `#4c6ef5`, Doing `#f08c00`, Waiting `#ae3ec9`, Done `#2f9e44`; sidebar buttons `#edf0ff` background with `#3b5bdb` text. Any header colour whose white text is under 4.5:1 is darkened just enough to pass, and the value used is recorded in a CSS comment.
- Radii: column panels 12 px; cards 8 px.
- Text: base 14 px on desktop; card title 14 px; card meta 12 px; column headers 12–13 px bold.
- Dark mode follows `prefers-color-scheme` only; no in-app switch. Light is the primary design.
- No layout, behaviour, copy or feature changes. No new font downloads, no new dependencies.
- Visible focus rings on every interactive element, in both themes.
- `npm run check` and `npm run build` pass for every commit.

## Review Focus

1. **White text on the amber Doing header.** `#f08c00` with white text is about 2.6:1; it must be darkened (or the text darkened) to pass 4.5:1. Checked in Task 1 with a contrast calculation recorded in the commit.
2. **Dark mode.** Every surface, menu, input and the drawer is readable on dark; nothing keeps a light-only hard-coded colour. Checked by hand in Task 2 with the browser's colour-scheme emulation.
3. **Drag and drop after the restyle.** The Sortable ghost and fallback clone still look right and drops still land. Checked by hand in Task 2.
4. **Phone at 375 px.** Switcher pills, cards, drawer, Add sheet and selection bar fit with no horizontal scroll. Checked by hand in Task 2.
5. **Native controls.** Date input, selects and tick boxes are styled but still usable with keyboard and on iPhone. Checked by hand in Task 2.

---

### Task 1: Tokens, top bar, board, columns and cards

**Files:**
- Modify: `src/ui/app.css`, `src/ui/Column.tsx`, `src/ui/Card.tsx`, `src/ui/App.tsx` (top-bar nav markup only if needed for pills)

**Interfaces:**
- Produces: CSS custom properties on `:root` (light) and under `@media (prefers-color-scheme: dark)`: `--bg`, `--surface`, `--surface-2`, `--text`, `--muted`, `--border`, `--accent` (`#3b5bdb` light), `--accent-soft` (`#edf0ff` light), `--topbar`, `--topbar-text`, `--col-backlog`, `--col-next`, `--col-doing`, `--col-waiting`, `--col-done`, `--on-col` (header text colour), `--shadow-1`, `--shadow-2`, `--radius-panel` (12px), `--radius-card` (8px), plus the existing `--priority-high`, `--priority-low`, `--notice`, `--error`, `--bar-h`. Task 2 uses only these names.
- Column: the `<section class="column">` gets `style={{ '--col': 'var(--col-<name lower case>)' }}`; its heading becomes the coloured header.
- Card: the `<li class="card">` gets `style={{ '--list': colour }}` (from the existing `card.colour`); the left edge uses it; the chip dot on the board is removed (the list name stays as text).

- [ ] **Step 1: Write the tokens** (light and dark) and base text sizes per Global Constraints. Compute white-on-header contrast for all five header colours in both themes (any online or scripted WCAG formula); darken failing ones minimally; record values and ratios in a comment next to the tokens.
- [ ] **Step 2: Restyle** the top bar (solid `--topbar`, pill tabs, sync status right), page background, board, column panels with coloured headers, and cards (border, list-colour left edge, meta line). Keep the Sortable ghost/fallback classes styled.
- [ ] **Step 3: Check by eye** with `npm run dev` at `/todo/?fake`, desktop 1440 px, light and dark: top bar, columns, card edges, markers, step counts, pin; drag a card between columns.
- [ ] **Step 4: Run** `npm run check && npm run build` — expect PASS.
- [ ] **Step 5: Commit** `style: colourful lanes — tokens, top bar, columns and cards`

---

### Task 2: Everything else, phone and dark mode

**Files:**
- Modify: `src/ui/app.css`; markup only where a style needs a hook (`Sidebar.tsx`, `FilterMenu.tsx`, `CardMenu.tsx`, `SelectionBar.tsx`, `CardDetail.tsx`, `Checklist.tsx`, `Today.tsx`, `QuickAdd.tsx`, `PhoneNav.tsx`, `Board.tsx`)

**Interfaces:**
- Consumes: the tokens from Task 1 (no new colour literals outside the token blocks, except list colours, which come from `listColour`).

- [ ] **Step 1: Restyle** the sidebar (white panel, list rows tinted with their own colour at low opacity, pale-indigo Filter/Select buttons with the dot cue), Filter menu, right-click menu, selection bar, card detail panel (sticky header kept), checklist, quick add, Today rows and headings, notices, empty-board line, phone drawer and bottom bar. Style native `select`, text/number/date `input` and tick boxes to match (`accent-color` for tick boxes; keep native pickers working).
- [ ] **Step 2: Phone switcher:** each column pill uses its column colour — selected filled with `--on-col` text, others outlined.
- [ ] **Step 3: Check by eye** at `/todo/?fake`: desktop 1440 px (sidebar open and closed), 375 px (board, switcher, drawer, Add sheet, selection bar, no horizontal scroll), card detail, Filter menu, right-click menu, Today, empty-board line, keyboard focus rings — each in light and dark (browser colour-scheme emulation). Drag, right-click and selection still work.
- [ ] **Step 4: Run** `npm run check && npm run build` — expect PASS.
- [ ] **Step 5: Commit** `style: colourful lanes — sidebar, menus, detail, phone and dark mode`
