# Show One List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a list's name in the sidebar shows only that list. Clicking it again, or using a new Show all button, brings every list back.

**Architecture:** A pure `showOnlyList` function next to `toggleListFilter` works out the next list filter. `Sidebar.tsx` splits each row's `<label>` into a tickbox (which toggles, as now) and a name button (which shows only that list), and adds Show all beside the "Lists" heading.

**Tech Stack:** Preact, TypeScript, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-19-show-one-list-design.md`

## Global Constraints

- UI copy is UK English and plain: "Show all", and the accessible name "Show only <list name>".
- No new dependencies.
- Comments explain why, never what.
- Definition of done: `npm run check` passes, plus a manual check in the browser (`npm run dev`, then `?fake`).
- The list filter stays per device in `todo.filter`. `null` means every list is shown.

## Review Focus

1. **Stale IDs in a stored filter.** A filter saved before a list was deleted can hold IDs that aren't in `allIds`. Clicking the name of the only *existing* list that is shown should still go back to all lists. This is pinned by a test in Task 1.
2. **Only one list in total.** Showing only that list is the same as showing all, so the result must be `null`, not `{id}`. Otherwise Show all would appear for no reason. This is pinned by a test in Task 1.
3. **The phone drawer.** Tapping the name must not also toggle the tickbox. With the `<label>` gone, the tickbox needs a tap target of about 2rem. This is a manual check in Task 2.
4. **Offline.** The name button and Show all must work while offline. Unlike the right-click menu, they must not depend on `online`. This is a manual check in Task 2.
5. **Today.** The filter is shared, so Today should show only that list's tasks too. This is a manual check in Task 2.

---

### Task 1: `showOnlyList`

**Files:**
- Modify: `src/domain/filters.ts` (after `toggleListFilter`)
- Test: `src/domain/filters.test.ts` (new `describe` after `toggleListFilter`'s)

**Interfaces:**
- Produces: `showOnlyList(current: ReadonlySet<string> | null, id: string, allIds: readonly string[]): ReadonlySet<string> | null`

- [ ] **Step 1: Write the failing tests**

```ts
describe('showOnlyList', () => {
  const all = ['a', 'b', 'c'];

  test('from all lists, shows only the clicked one', () => {
    expect(showOnlyList(null, 'b', all)).toEqual(new Set(['b']));
  });

  test('from a partial selection, shows only the clicked one', () => {
    expect(showOnlyList(new Set(['a', 'c']), 'b', all)).toEqual(new Set(['b']));
  });

  test('clicking the list already shown alone returns to all', () => {
    expect(showOnlyList(new Set(['b']), 'b', all)).toBeNull();
  });

  test('a stale ID in the filter does not stop the return to all', () => {
    expect(showOnlyList(new Set(['b', 'gone']), 'b', all)).toBeNull();
  });

  test('with only one list there is nothing to narrow to', () => {
    expect(showOnlyList(null, 'a', ['a'])).toBeNull();
  });
});
```

Add `showOnlyList` to the import list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/filters.test.ts`
Expected: FAIL, because `showOnlyList` is not exported.

- [ ] **Step 3: Implement `showOnlyList` in `src/domain/filters.ts`**

"Already alone" means that, of the IDs in `allIds`, only `id` is in `current`. This is what lets stale IDs be ignored. Return `null` when the filter is already alone or when `allIds.length <= 1`. Otherwise return `new Set([id])`. Add a one-line why-comment that clicking again is the way back to all lists.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/filters.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts
git commit -m "feat(domain): work out the filter that shows only one list"
```

### Task 2: Sidebar name button and Show all

**Files:**
- Modify: `src/ui/Sidebar.tsx` (heading near line 139, list row near lines 175-184)
- Modify: `src/ui/app.css` (sidebar rules near lines 795 and 1033-1063)

**Interfaces:**
- Consumes: `showOnlyList` from Task 1, `toggleListFilter`, and the existing `filters` / `onFilters` / `allListIds` props.

- [ ] **Step 1: Split the row**

Replace the `<label class="check">` with:
- an `<input type="checkbox">` with `aria-label={list.title}`, keeping the current `checked` and `onChange`
- `<span class="dot" />`
- `<button type="button" class="list-name">` showing `list.title`, with:
  - `aria-label={`Show only ${list.title}`}`
  - `aria-pressed` set to true when that list is the only one shown
  - `onClick={() => onFilters({ ...filters, lists: showOnlyList(filters.lists, list.id, allListIds) })}`

Wrap them in an element that keeps the row's tinted background (for example `<div class="check">`), so the row looks the same as now. `.list-name` is already used by `NameInput` (line 1059). Reuse it or give the button its own class, as long as the padding of the renaming input stays the same.

- [ ] **Step 2: Add Show all**

Put `<h2>Lists</h2>` in a flex row with a `<button type="button" class="show-all">Show all</button>`. Render the button only when `filters.lists !== null`. Its click sets `lists: null`.

- [ ] **Step 3: Style it**

- The name button takes the row's remaining width, with left-aligned text, no border and no background. It inherits the font and colour.
- The tickbox gets a tap target of at least 2rem, for example by padding the input or wrapping it.
- Show all is a small text button in the accent colour, aligned to the end of the heading row.
- The pressed name (`aria-pressed="true"`) is shown in bold.

- [ ] **Step 4: Run checks**

Run: `npm run check`
Expected: typecheck, lint and tests all pass.

- [ ] **Step 5: Manual check in the browser**

Run `npm run dev`, open `/?fake` and check each of the following:
- Clicking the tickbox toggles that list only. Clicking a name shows only that list, across both accounts.
- Clicking the same name again shows every list, and Show all disappears.
- Show all appears whenever any list is unticked, and clicking it restores every list.
- The priority and planned filters are unchanged after both actions.
- Today shows only the chosen list's tasks.
- Offline (DevTools Network set to Offline), the name button and Show all still work.
- In the phone drawer at mobile width, tapping a name doesn't tick the box, and the tickbox is easy to tap.
- Right-clicking a row still opens the Rename/Delete menu, and renaming still works.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Sidebar.tsx src/ui/app.css
git commit -m "feat(ui): click a list's name to show only that list"
```
