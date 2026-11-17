# Phone Stack View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Stack" choice to the phone column switcher that shows Doing, Next and Backlog stacked on one scrolling page, with drag between them.

**Architecture:** The phone's switcher choice widens from a column name to `Column | 'Stack'`. Stack renders the existing `Column` components for Doing, Next and Backlog in that order, so drag between them already works through Sortable's shared `board` group. The rest is CSS for the stacked layout and an empty drop strip.

**Tech Stack:** existing: Preact, SortableJS, plain CSS.

**Spec:** `docs/superpowers/specs/2026-11-17-phone-stack-design.md`. Read `CLAUDE.md` first.

## Global Constraints

- Switcher order: `Stack`, `Backlog`, `Next`, `Doing`, `Done`. The button text is exactly `Stack`, with no count.
- Stack order: `Doing`, `Next`, `Backlog`. No Done.
- The choice persists in `todo.column` (value `Stack`); any unknown stored value falls back to Backlog as today.
- Desktop is unchanged. No new dependencies. No new copy beyond `Stack`.
- `npm run check` and `npm run build` pass.

## Review Focus

1. **Drag from a long Backlog up to Doing.** The page auto-scrolls while you hold a card near the top edge, and the drop lands in Doing at the spot it was released. Checked by hand.
2. **Empty Doing or Next in Stack.** It still accepts a drop (a visible strip). Checked by hand.
3. **Select mode in Stack.** Select-all on each section header ticks only that section, and Move to works. Checked by hand.
4. **No horizontal scroll at 375 px** with five switcher buttons. Checked by hand.
5. **Switching from Stack to a single column and back** keeps the counts right and leaves no drag stuck. Checked by hand.

---

### Task 1: Stack choice on the phone

**Files:**
- Modify: `src/ui/Board.tsx`, `src/ui/app.css`

**Interfaces:**
- In Board.tsx: `type PhoneView = ColumnName | 'Stack'` and `const STACK: ColumnName[] = ['Doing', 'Next', 'Backlog']`. `loadColumn()` returns a `PhoneView`.

- [ ] **Step 1: Build it.**
  - Add the `Stack` button first in `.switcher`. It uses `aria-pressed`, and its `--col` is a neutral token (`var(--accent)`).
  - `visible` on a phone is `STACK` when the view is Stack, otherwise the single chosen column.
  - Add `class="board phone stack"` in Stack, and style it so the columns stack full width with a gap. In the stacked layout, a column's card list has a `min-height` (about 3rem) so an empty section still takes a drop.
  - No unit test, because there is no rule here beyond a fixed order. Ledger this as a ruling.
- [ ] **Step 2: Check by hand** at `/todo/?fake`, 375 px, light and dark:
  - Stack shows Doing, Next and Backlog in that order.
  - Drag a card Backlog→Doing using a gradual JS pointer drag (the tool's instant drag can't satisfy Sortable's delay), and confirm the column moved.
  - An empty Doing accepts a drop.
  - Select-all per section works.
  - Stack is remembered across a reload.
  - No horizontal scroll.
  - The desktop board is unchanged.
- [ ] **Step 3: Run** `npm run check && npm run build`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(ui): Stack view on the phone`
