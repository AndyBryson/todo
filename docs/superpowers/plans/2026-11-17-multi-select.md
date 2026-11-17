# Multi-select Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select several board cards and move them all to one column in a single all-or-nothing save.

**Architecture:** A new store edit, `moveCardsToBottom`, applies the existing single-card move rules card by card against a working copy of the state inside one `store.commit`, then returns the combined change. The board gets a selection mode, Select all per column and a bottom bar with "Move to".

**Tech Stack:** existing: TypeScript, Preact, idb, SortableJS, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-multi-select-design.md`. Read `CLAUDE.md` first.

## Global Constraints

- One edit is one `store.commit` whose function reads the latest state (`src/store/edits.ts`). No new dependencies.
- UI copy, exactly: header button `Select` (and `Cancel` while selecting); column heading button `Select all`; bar text `<n> selected`; bar control label `Move to`; bar button `Cancel`.
- Moves into Done complete in Google and clear the pin; moves out of Done reopen — same as a single drag.
- Only cards visible under the current list filter can be selected; hidden cards are never moved or reordered.
- UK English, plain wording. `npm run check` passes with zero lint warnings for every commit.

## Review Focus

1. **A selected card changes underneath the selection** (completed or deleted on another device before you press Move). It is skipped or moved by the same rules, never an error that blocks the rest. Test in Task 1.
2. **Selecting cards from several columns, some already in the target.** Those in the target stay put; the others land at the bottom in their previous order. Test in Task 1.
3. **Moving many into Done and back.** Every card completes, every pin clears, and every reopen queues `completed: false`; nothing is double-queued. Test in Task 1.
4. **Changing the list filter while cards are selected.** Selected cards now hidden are dropped from the selection, so the bar count is what will move. Checked by hand in Task 2.
5. **Phone width.** The bar sits above the bottom nav and doesn't cover the last card. Checked by hand in Task 2.

---

### Task 1: Store — move many cards in one save

**Files:**
- Modify: `src/store/edits.ts`
- Test: `src/store/edits.test.ts`

**Interfaces:**
- Produces: `moveCardsToBottom(store: Store, taskIds: readonly string[], column: Column, now: string): Promise<void>`.
- Rules, inside one `store.commit` function:
  - Resolve each ID with `resolveId`; skip IDs with no task or no board entry.
  - Skip cards already in `column`.
  - Order the rest by current column (`COLUMNS` order), then rank; move them one after another to the bottom of `column`, each placed after the previous one, using the same per-card change as `moveChange` (Done: complete; out of Done: reopen then place).
  - Each card's change must see the state left by the previous card. Build a working copy of the snapshot that you update after each card, and merge the per-card changes into one `Change` (entries, `putTasks`, `enqueue` concatenated in order). Keep this merge local to edits.ts and reuse it for nothing else.
  - Return `{}` when nothing moves.

- [ ] **Step 1: Write the failing tests**

```ts
test('cards from two columns land at the bottom of Next in their previous order, in one commit', ...);
// Backlog: a(r1) b(r2); Doing: c(r1); Next: n(r1). Move [c, a, b] to Next → Next order n, a, b, c; one commit (count subscribe calls or use a spy on commit).
test('a card already in the target column stays where it is', ...);
test('moving many into Done completes each, clears each pin and queues one patch per card', ...);
test('moving many out of Done reopens each and queues completed:false once per card', ...);
test('an unknown or deleted id in the selection is skipped and the rest still move', ...);
test('a temporary id renamed by a replay is resolved', ...);
test('nothing to move queues nothing and saves nothing', ...);
```

- [ ] **Step 2: Run** `npx vitest run src/store/edits.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** `npm run check` — expect PASS.
- [ ] **Step 5: Commit** `feat(store): move many cards to a column in one save`

---

### Task 2: Board — selection mode and the Move bar

**Files:**
- Modify: `src/ui/Board.tsx`, `src/ui/Column.tsx`, `src/ui/Card.tsx`, `src/ui/app.css`
- Create: `src/ui/SelectionBar.tsx`

**Interfaces:**
- Consumes: `moveCardsToBottom` (Task 1).
- Produces: `SelectionBar` props `{ count: number; onMove(column: Column): void; onCancel(): void }`.

- [ ] **Step 1: Build it.**
  - Selection state (`Set<string>`) lives in `Board`; cleared on Cancel, after a successful move, and when `Board` unmounts. When the visible cards change (filter, sync), drop selected IDs that are no longer visible.
  - Header: a `Select` button toggles selection mode; while on it reads `Cancel`.
  - In selection mode: a card click toggles its selection (aria-pressed on the card button, a visible tick); Sortable is disabled (`option('disabled', true)`); each column heading shows `Select all`, which selects that column's visible cards (when all are already selected it clears them instead).
  - `SelectionBar` shows when at least one card is selected: `<n> selected`, a `Move to` select listing the five columns, and `Cancel`. Choosing a column calls `act(() => moveCardsToBottom(...))`; on success clear selection and leave selection mode.
  - Phone (`useIsPhone`): the bar sits above the bottom nav (use the existing `--bar-h` variable) and the board gets enough bottom padding that the last card isn't covered. The phone column switcher still works in selection mode, so a selection can span columns.
- [ ] **Step 2: Manual check** with `npm run dev` at `/todo/?fake`: Select → Select all in Backlog → Move to Next → all land at the bottom of Next in order; select across two columns → Done → they complete, pins clear; filter to one list mid-selection → count drops to visible cards; Cancel clears; dragging is off while selecting and back on after; at 375 px the bar sits above the bottom nav and the last card stays reachable; no console errors.
- [ ] **Step 3: Run** `npm run check && npm run build` — expect PASS.
- [ ] **Step 4: Commit** `feat(ui): select several cards and move them to a column`
