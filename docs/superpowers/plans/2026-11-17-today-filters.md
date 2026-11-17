# Today Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the sidebar and drawer on Today and filter Today's sections by the same list and priority filters as the board.

**Architecture:** Split the list-and-priority part out of `cardVisible` into a shared rule, use it in `todaySections`, and stop gating the sidebar, drawer and ☰ on the board route; Select hides on Today.

**Tech Stack:** existing: TypeScript, Preact, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-today-filters-design.md`. Read `CLAUDE.md` first.

## Global Constraints

- One shared, per-device filter set for board and Today (existing `todo.filter`, `todo.priorities`, `todo.planned`).
- On Today, only the list and priority filters apply; the planned-date filter never hides anything there.
- A task with no board entry counts as Medium.
- Select is hidden on Today. Copy unchanged: empty Today keeps "Nothing planned and nothing pinned."; with every priority unticked Today shows "Every priority is hidden by the filter".
- `npm run check` passes with zero lint warnings; CLAUDE.md's runtime rule "never apply to Today" is updated to match.

## Review Focus

1. **A filter left on from the board** hides tasks on Today. The ☰ dot shows on Today so it's discoverable. Checked by hand in Task 2.
2. **Planned-date filter on with a small n.** Today still shows overdue and today's tasks. Test in Task 1.
3. **A pinned task with no board entry yet.** It shows when Medium is ticked and hides when Medium is unticked. Test in Task 1.
4. **Switching Board ↔ Today with the drawer open on a phone.** The drawer closes or stays consistent; nothing is stuck open. Checked by hand in Task 2.
5. **Select mode on, then switch to Today.** Selection ends (as it already does on leaving the board) and no Select button shows. Checked by hand in Task 2.

---

### Task 1: Filtering rule for Today

**Files:**
- Modify: `src/domain/filters.ts`, `src/domain/today.ts`
- Test: `src/domain/filters.test.ts`, `src/domain/today.test.ts`

**Interfaces:**
- Produces (`filters.ts`): `listAndPriorityVisible(task: Task, entry: BoardEntry | undefined, filters: BoardFilters): boolean` — list shown AND priority (absent entry → Medium) shown. `cardVisible` uses it, unchanged in behaviour.
- `todaySections(tasks, entries, now, filters: BoardFilters, timeZone?)` — skips tasks failing `listAndPriorityVisible`. Update every caller (Today.tsx, tests) to the new parameter order.

- [ ] **Step 1: Write the failing tests**

```ts
// today.test.ts
test('Today leaves out tasks in hidden lists and hidden priorities', ...);
test('the planned-date filter never hides tasks on Today', ...); // planned on, days 1, overdue + today still shown
test('a pinned task with no board entry counts as Medium', ...);  // entries without it; Medium ticked → shown; unticked → hidden
// filters.test.ts — existing cardVisible tests stay green
```

- [ ] **Step 2: Run** `npx vitest run src/domain` — expect FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm run check` — expect PASS.
- [ ] **Step 5: Commit** `feat(domain): Today follows the list and priority filters`

---

### Task 2: Sidebar, drawer and ☰ on Today

**Files:**
- Modify: `src/ui/App.tsx`, `src/ui/Sidebar.tsx`, `src/ui/Today.tsx`, `CLAUDE.md`

**Interfaces:**
- Consumes: `todaySections(…, filters, …)` (Task 1).
- `Sidebar` / `SidebarDrawer` gain `showSelect: boolean` (false on Today).

- [ ] **Step 1: Wire it.** In App, show the sidebar (desktop, when open), drawer (phone) and the top-bar ☰ on both routes; pass `showSelect={view === 'board'}`; pass `filters` to `Today`. Today shows "Every priority is hidden by the filter" when no priority is ticked. Update CLAUDE.md's filter rule ("board filters … never Today") to say filters are shared by board and Today, and the planned-date filter applies to the board only.
- [ ] **Step 2: Check by hand** at `/todo/?fake`, desktop and 375 px: sidebar and ☰ on Today; untick a list → its tasks leave Today; untick Medium → medium tasks leave; untick all → the priority line; date filter on → Today unchanged; Select absent on Today; with Select on, switch to Today → selection ends; phone drawer opens on Today and closes on switching page.
- [ ] **Step 3: Run** `npm run check && npm run build` — expect PASS.
- [ ] **Step 4: Commit** `feat(ui): sidebar and shared filters on Today`
