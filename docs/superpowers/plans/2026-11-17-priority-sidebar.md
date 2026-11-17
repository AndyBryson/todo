# Priorities, Filters, Sidebar and Right-click Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jira-style priority labels that sync, board filters by list / priority / planned date kept per device, a left sidebar (drawer on phone) holding lists, the filter and Select, and a right-click / long-press card menu.

**Architecture:** Priority is an optional field on each board entry in `board.json`, merged like column and order; the board file now keeps unknown entry fields. A pure `cardVisible` in `src/domain/` decides what the board shows; `buildBoard` takes the combined filters. The UI gets a `Sidebar` with lists, a `FilterMenu` and Select, and a `CardMenu` opened by `contextmenu`.

**Tech Stack:** existing: TypeScript, Preact, idb, SortableJS, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-priority-sidebar-design.md` (approved; its "Builder's calls" section is binding). Read `CLAUDE.md` first.

## Global Constraints

- Priority values, stored lowercase: `"highest" | "high" | "medium" | "low" | "lowest"`. Medium is stored as an absent field; any other stored value reads as Medium.
- Markers, as text glyphs with `role="img"`: Highest `▲▲`, High `▲` (red); Low `▼`, Lowest `▼▼` (blue); Medium none. `aria-label` exactly `Priority: Highest` / `Priority: High` / `Priority: Low` / `Priority: Lowest`.
- UI copy, exactly: sidebar heading `Lists`; button `Filter` (with the active count in brackets when non-zero, e.g. `Filter (2)`); dropdown headings `Priorities to show` and `Planned date`; date option `Hide after today + [n] days`; empty-board line `Every priority is hidden by the filter`; menu items `Open`, `Priority`, `Move to`, `Pin to Today` / `Unpin`, `Delete…`; drawer button accessible name `Lists and filters`.
- Per-device storage keys: `todo.filter` (list filter, unchanged), `todo.priorities` (array of shown levels), `todo.planned` (`{ on: boolean, days: number }`). Defaults: all priorities shown; planned filter off, 14 days. Days accept whole numbers 1–365; anything else snaps back to the last valid value.
- Filters apply to the board only, never Today. Done cards ignore the planned-date filter.
- `board.json` output for entries with no priority and no unknown fields must be byte-identical to today's, so devices don't rewrite the file on update.
- UK English. `npm run check` passes with zero lint warnings for every commit.

## Review Focus

1. **An existing `board.json` after the update.** Reading then writing it changes nothing, so no device rewrites Drive just because it updated. Test in Task 1.
2. **Every priority unticked.** The board shows `Every priority is hidden by the filter` instead of five empty columns. Checked by hand in Task 4.
3. **Right-click in Select mode or on a Done card.** In Select mode it selects (no menu); on Done there's no Pin, and Move to reopens. Checked by hand in Task 5.
4. **Long-press on a phone.** Hold and release opens the menu; hold and move drags; neither triggers the other or the browser's own callout. Checked by hand in Task 5 (the in-app browser emulates touch only partly, so also on a real phone after deploy).
5. **Rubbish in the days field** (empty, 0, 999, "abc"). It snaps back to the last valid value and the filter keeps working. Checked by hand in Task 4.

---

### Task 1: Board file — priority and unknown fields

**Files:**
- Modify: `src/domain/types.ts`, `src/domain/board.ts`
- Test: `src/domain/board.test.ts`

**Interfaces:**
- Produces (`types.ts`): `export const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'] as const; export type Priority = (typeof PRIORITIES)[number];` `BoardEntry` gains `priority?: Exclude<Priority, 'medium'>` and `extra?: Record<string, unknown>` (unrecognised entry fields, kept for round trips).
- Produces (`board.ts`): `priorityOf(entry: BoardEntry): Priority` (absent → `'medium'`).
- `parseEntry` keeps unknown keys in `extra` and a valid non-medium `priority`; an invalid or `"medium"` value is dropped (reads as Medium) without rejecting the entry. `serialiseBoard` writes the five known fields in today's order, then `priority` if set, then `extra` keys sorted. `completeEntry`, `reopenEntry`, `placeInColumn` and `reconcile` already spread entries — verify they carry `priority` and `extra`.

- [ ] **Step 1: Write the failing tests**

```ts
test('an existing board file reads and writes back byte for byte', () => {
  const raw = serialiseBoard({ a: entry(), b: entry({ column: 'Next', openColumn: 'Next' }) }); // captured BEFORE this task's change: paste the literal JSON string
  expect(serialiseBoard(parseBoardFile(raw))).toBe(raw);
});
test('a priority round-trips', ...);            // entry({priority:'low'}) → parse(serialise) keeps 'low'
test('an unknown entry field survives parse, merge and serialise', ...); // {..., colour:'teal'} still present
test('an invalid or medium priority reads as Medium and keeps the entry', ...); // 'urgent', 'medium' → priorityOf === 'medium', no priority key written
test('priority survives completing and reopening', ...);
test('a newer priority change on one device wins the merge', ...);
```

For the first test, generate the expected string once with the current code and paste it as a literal, so the test pins today's exact format.
- [ ] **Step 2: Run** `npx vitest run src/domain/board.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm run check` — expect PASS.
- [ ] **Step 5: Commit** `feat(domain): store priority on board entries and keep unknown fields`

---

### Task 2: Filters and the board view

**Files:**
- Create: `src/domain/filters.ts`, `src/domain/filters.test.ts`
- Modify: `src/domain/board.ts` (`buildBoard`), `src/domain/board.test.ts`, every `buildBoard` caller (`src/ui/Board.tsx`)

**Interfaces:**
- Consumes: `Priority`, `priorityOf` (Task 1).
- Produces (`filters.ts`):
  - `export interface BoardFilters { lists: ReadonlySet<string> | null; priorities: ReadonlySet<Priority>; planned: { on: boolean; days: number } }`
  - `export const DEFAULT_FILTERS: BoardFilters` (lists null, all five priorities, planned `{ on: false, days: 14 }`).
  - `cardVisible(task: Task, entry: BoardEntry, filters: BoardFilters, today: LocalDate): boolean` — list shown AND priority shown AND (planned off OR no `due` OR `due <= addDays(today, days)` OR entry is in Done).
  - `activeFilterCount(filters: BoardFilters): number` — 1 if any priority is unticked, plus 1 if planned is on.
- `buildBoard(tasks, lists, entries, filters: BoardFilters, now: Date)` replaces the old `filter` parameter and uses `cardVisible` with `localDate(now)`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a card planned exactly today + n shows; the day after hides', ...);
test('a card with no planned date always shows', ...);
test('an overdue card shows when the date filter is on', ...);
test('Done cards ignore the date filter', ...);
test('unticked priorities hide their cards; absent priority counts as Medium', ...);
test('list, priority and date filters combine', ...);
test('activeFilterCount counts the priority group once and the date filter once', ...);
test('buildBoard leaves out cards the filters hide', ...); // board.test.ts
```

- [ ] **Step 2: Run** `npx vitest run src/domain` — expect FAIL.
- [ ] **Step 3: Implement** per Interfaces; update `Board.tsx` to pass `{ ...DEFAULT_FILTERS, lists: effectiveFilter }` for now (Task 4 wires the real filters).
- [ ] **Step 4: Run** `npm run check` — expect PASS.
- [ ] **Step 5: Commit** `feat(domain): filter the board by priority and planned date`

---

### Task 3: Setting priority, markers and the detail select

**Files:**
- Modify: `src/store/edits.ts`, `src/store/edits.test.ts`, `src/ui/Card.tsx`, `src/ui/CardDetail.tsx`, `src/ui/app.css`

**Interfaces:**
- Consumes: `Priority`, `priorityOf` (Task 1).
- Produces: `setPriority(store: Store, taskId: string, priority: Priority, now: string): Promise<void>` — one commit; resolves the ID; stores `priority` (deleting the key for `'medium'`) and stamps `updatedAt`; queues nothing for Google; no-op (no save) when unchanged; throws for an unknown task or a task with no board entry.

- [ ] **Step 1: Write the failing tests** (`edits.test.ts`)

```ts
test('setting a priority saves it on the card and queues nothing for Google', ...);
test('setting Medium removes the stored priority', ...);
test('setting the same priority again saves nothing', ...);
```

- [ ] **Step 2: Run** `npx vitest run src/store` — expect FAIL.
- [ ] **Step 3: Implement** `setPriority`. Card: marker after the date per Global Constraints. CardDetail: a `Priority` select (five levels, Medium default) for top-level tasks, calling `setPriority` through `act`.
- [ ] **Step 4: Run** `npm run check` — expect PASS. Manual: with `npm run dev` at `/todo/?fake`, set each level in the detail panel and see the card marker change.
- [ ] **Step 5: Commit** `feat: set a task's priority and show it on its card`

---

### Task 4: Sidebar, filter dropdown and phone drawer

**Files:**
- Create: `src/ui/Sidebar.tsx`, `src/ui/FilterMenu.tsx`
- Modify: `src/ui/App.tsx` (filter state and persistence), `src/ui/Board.tsx` (Select moves out; empty-board line), `src/ui/app.css`
- Delete: `src/ui/ListFilter.tsx` (replaced by the sidebar's list tick boxes)

**Interfaces:**
- Consumes: `BoardFilters`, `DEFAULT_FILTERS`, `activeFilterCount` (Task 2).
- Produces: `Sidebar` props `{ lists: TaskList[]; filters: BoardFilters; onFilters(f: BoardFilters): void; selecting: boolean; onToggleSelect(): void }`. Selection state stays in `Board`; lift only the `selecting` flag and its toggle to wherever both `Sidebar` and `Board` can reach it.

- [ ] **Step 1: Build it.**
  - Desktop (board route only): fixed-width sidebar on the left with `Lists` (tick boxes with list colour; none ticked = all, as today), the `Filter` button opening `FilterMenu`, and `Select`. The board fills the rest. Today has no sidebar.
  - `FilterMenu`: `Priorities to show` (five tick boxes with markers), `Planned date` (`Hide after today + [n] days`: tick box + number). Changes apply immediately. Closes on Escape or a click outside.
  - Persist with the storage keys and defaults in Global Constraints, each read and write in try/catch. Keep the existing `todo.filter` behaviour.
  - When no priority is ticked, the board shows `Every priority is hidden by the filter` in place of the columns.
  - Phone: a ☰ button (accessible name `Lists and filters`) at the start of the board's top row, left of the column switcher, opens the sidebar as a drawer from the left. The drawer closes on its own close button, Escape, a tap outside, and when Select is turned on; it stays open while ticking lists or filters.
- [ ] **Step 2: Manual check** at `/todo/?fake`, desktop and 375 px: tick and untick lists; untick Low and Lowest (their cards vanish, `Filter (1)`); untick all (the empty-board line); turn on the date filter with 3 days (far cards vanish, overdue and undated stay, Done unaffected, `Filter (2)`); type empty, 0, 999 and abc in the days field (snaps back); reload (settings kept); Select from the sidebar still works with hidden cards excluded from Select all; no console errors.
- [ ] **Step 3: Run** `npm run check && npm run build` — expect PASS.
- [ ] **Step 4: Commit** `feat(ui): sidebar with lists, filter and Select; drawer on phone`

---

### Task 5: Right-click card menu

**Files:**
- Create: `src/ui/CardMenu.tsx`
- Modify: `src/ui/Card.tsx`, `src/ui/Column.tsx` or `src/ui/Board.tsx` (one menu instance for the board), `src/ui/app.css`

**Interfaces:**
- Consumes: `setPriority` (Task 3), `moveCardToBottom`, `setPinned`, `deleteTask` (existing), `openDetail` (existing).
- Produces: `CardMenu` props `{ card: Card; x: number; y: number; onClose(): void; act(fn: () => Promise<unknown>): Promise<boolean>; store: Store }`.

- [ ] **Step 1: Build it.**
  - Opens on the card's `contextmenu` event (right-click; long-press on touch; the context-menu key or Shift+F10 on a focused card) at the pointer, kept on screen. Off in Select mode (right-click then does nothing special).
  - Items: `Open`; `Priority` ▸ five levels with the current one marked; `Move to` ▸ five columns, current one marked and disabled (moves to the bottom, using `moveCardToBottom`); `Pin to Today` / `Unpin` (hidden for Done cards); `Delete…` (same confirm text as the detail panel).
  - Keyboard: focus moves into the menu; Up/Down move, Right/Enter open a submenu, Left/Escape back out or close, Enter chooses. Closes on Escape, a click outside, scroll, or choosing.
  - Touch: iPhone Safari never fires `contextmenu` on a long-press, and on phones the board already uses a 300 ms hold to start a drag. So on touch, a **hold then release without moving** opens the menu, and a **hold then move** drags as today. Detect it from Sortable: `onChoose` marks the start, `onUnchoose` / `onEnd` with no movement (same list, same index, no `onMove` seen) opens the menu at the touch point. Suppress the browser's own long-press callout on cards (`-webkit-touch-callout: none`, `user-select: none` on the card body), and `preventDefault` the `contextmenu` event on touch so Android doesn't show both.
- [ ] **Step 2: Manual check** at `/todo/?fake`, desktop and 375 px: right-click a card → each item works (priority marker updates, Move to lands at the bottom, Pin shows ★, Delete confirms); on a Done card no Pin, Move to reopens; in Select mode no menu; keyboard-only via Shift+F10; at phone width hold-and-release opens the menu and hold-and-move drags; no console errors.
- [ ] **Step 3: Run** `npm run check && npm run build` — expect PASS.
- [ ] **Step 4: Commit** `feat(ui): right-click a card for priority, column, pin and delete`
