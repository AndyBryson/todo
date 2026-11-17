# Manage Lists, Four Columns, Home Tasks to Next: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create, rename and delete Google Tasks lists from the sidebar; drop the Waiting column; put tasks first seen in the default list (My Tasks) into Next.

**Architecture:** Waiting leaves `COLUMNS`. `reconcile` takes the default list ID and places genuinely new default-list tasks in Next. List changes are online-only calls in a new `src/sync/lists.ts` that go straight to Google and then apply one store change (new `putLists` / `removeLists` on `Change`); they never enter the queue. The sidebar gets a ⋯ menu per list and a "+ New list" row.

**Tech Stack:** existing: TypeScript, Preact, idb, Vitest with fake-indexeddb and the fake Google.

**Spec:** `docs/superpowers/specs/2026-11-17-lists-and-columns-design.md`. Read `CLAUDE.md` first.

## Global Constraints

- Columns are exactly `['Backlog', 'Next', 'Doing', 'Done']`. No code handles old "Waiting" data (Andy: there is nothing in Waiting).
- The default list is identified by Google's `@default` alias, never by name.
- Next applies only to a new top-level task in the default list, and only when the reconciled entries passed in are non-empty. Completed new tasks still go to Done. Until the default list ID is known (`null`), everything new goes to Backlog.
- List create, rename and delete are online-only: no queue ops, controls disabled while `navigator.onLine` is false.
- Copy, exactly: delete confirm `Delete “<title>” and its <n> tasks? This can't be undone.` (`1 task` when n is 1); offline hint `You're offline`; menu items `Rename`, `Delete`; new-list row `+ New list`. UK English.
- The default list has no Delete item (hidden). A blank name (after trimming) is refused without calling Google.
- `board.json` stays IDs and metadata only; board entries are never rebuilt from known fields.
- Runtime deps stay `preact`, `idb`, `sortablejs`. `npm run check` passes with zero lint warnings.

## Review Focus

1. **Delete while changes are waiting.** Queued writes for the deleted list (including a `move` whose `toListId` is that list) are dropped; writes for other lists stay. Test in Task 3.
2. **First import / empty board.** With no entries yet, default-list tasks go to Backlog, not Next. Test in Task 2.
3. **Failed list call** (offline part-way, HTTP error, deleting the default list). The store is unchanged and the rename field goes back to the old name. Store test in Task 3; UI checked by hand in Task 4.
4. **List filter after create and delete.** A new list shows even when some lists are unticked; a deleted list leaves the filter set and is no longer Quick add's remembered list. The remembered list is tested in Task 3; the filter is checked by hand in Task 4.
5. **Reopened old task in My Tasks.** It lands in Next (it has no entry), and CLAUDE.md says so. Test in Task 2.

---

### Task 1: Four columns

**Files:**
- Modify: `src/domain/types.ts`, `src/domain/board.ts` (the `buildBoard` column map), `src/ui/app.css` (remove `--col-waiting` and its contrast note), any UI listing columns
- Test: update `src/domain/board.test.ts`, `src/sync/pull.test.ts`, `src/store/edits.test.ts` where they use `'Waiting'` (use `'Doing'` instead; same assertions otherwise)

**Interfaces:**
- Produces: `COLUMNS = ['Backlog', 'Next', 'Doing', 'Done'] as const`.

- [ ] **Step 1:** Change `COLUMNS`; run `npm run typecheck`. Expected: errors pointing at every place that still names Waiting.
- [ ] **Step 2:** Fix each one, and switch the tests named above from `'Waiting'` to `'Doing'`.
- [ ] **Step 3: Run** `npm run check && npm run build`. Expected: PASS. `grep -rn "Waiting" src` finds only `src/google/auth.ts` (an unrelated interface name).
- [ ] **Step 4: Check by eye** at `/todo/?fake`: four columns on desktop, four switcher pills at 375 px, and no Waiting in the card menu or Move to.
- [ ] **Step 5: Commit** `feat: drop the Waiting column`

---

### Task 2: Tasks first seen in My Tasks start in Next

**Files:**
- Modify: `src/google/api.ts`, `src/google/http.ts`, `src/google/fake.ts`, `src/domain/board.ts` (`reconcile`), `src/sync/pull.ts`, `src/store/db.ts` (Meta), `CLAUDE.md`
- Test: `src/domain/board.test.ts`, `src/sync/pull.test.ts`, `src/google/fake.test.ts`

**Interfaces:**
- Produces:
  - `GoogleApi.getDefaultListId(): Promise<string>`. HTTP: `GET ${TASKS}/users/@me/lists/@default`, returning `id`. Fake: `seed.defaultListId`, or else the first seeded list's ID.
  - `reconcile(tasks, lists, entries, now, defaultListId: string | null): BoardEntries`
  - `syncBoard(google, local, tasks, lists, now, defaultListId: string | null)`
  - `Meta` and `Snapshot` gain `defaultListId: string | null`. It is stored in the `meta` store and set by `pull`'s commit.
- `pull` calls `getDefaultListId()` once per pull, alongside `listTaskLists()`, before touching the store.

- [ ] **Step 1: Write the failing tests** (board.test.ts, in the reconcile block):

```ts
test('a new task in the default list starts in Next', ...);
// entries has one existing entry (another task); new open task in 'L1', defaultListId 'L1'
// → column 'Next', openColumn 'Next', rank appended after existing Next ranks
test('a new task in another list starts in Backlog', ...);   // listId 'L2', default 'L1' → 'Backlog'
test('a new completed task in the default list goes to Done with openColumn Next', ...);
test('with no entries at all, default-list tasks start in Backlog', ...); // entries {} → 'Backlog'
test('with no default list known, new tasks start in Backlog', ...);     // defaultListId null
test('a reopened task with no entry in the default list lands in Next', ...); // open task, no entry, others exist
```

  In pull.test.ts: `pull stores the default list ID and places a new My Tasks task in Next`. Use the fake seeded with an existing entry, then add a task to the default list on the fake side, pull, and expect `snapshot().defaultListId === <first list id>` and the new entry's column `'Next'`.
- [ ] **Step 2: Run** `npx vitest run src/domain src/sync`. Expected: FAIL (signature / column).
- [ ] **Step 3: Implement** per Interfaces. In `reconcile`, `fresh`'s column and openColumn are `'Next'` when `t.listId === defaultListId && Object.keys(entries).length > 0`, otherwise `'Backlog'`. The rank is appended within that column. Update every caller. Update CLAUDE.md's runtime rule "If one is reopened later, it lands at the bottom of Backlog" to: "…it lands at the bottom of Backlog, or of Next if it is in the default list (My Tasks). Tasks first seen in My Tasks start in Next, so Google Home tasks are ready to act on; a first import still puts everything in Backlog."
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: tasks first seen in My Tasks start in Next`

---

### Task 3: List create, rename and delete (Google, store, sync)

**Files:**
- Modify: `src/google/api.ts`, `src/google/http.ts`, `src/google/fake.ts`, `src/store/db.ts` (`Change`)
- Create: `src/sync/lists.ts`, `src/sync/lists.test.ts`

**Interfaces:**
- Consumes: `defaultListId` from Task 2's Snapshot.
- Produces:
  - `GoogleApi.insertTaskList(title: string): Promise<TaskList>`. HTTP: `POST ${TASKS}/users/@me/lists` with `{title}`.
  - `GoogleApi.patchTaskList(listId: string, title: string): Promise<TaskList>`. HTTP: `PATCH …/users/@me/lists/{id}`.
  - `GoogleApi.deleteTaskList(listId: string): Promise<void>`. HTTP: `DELETE …/users/@me/lists/{id}`.
  - In the fake, delete removes the list's tasks. Deleting the default list throws `HttpError(400, …)`, and an unknown list throws `NotFoundError`.
  - `Change` gains `putLists?: TaskList[]` (upsert by ID) and `removeLists?: string[]`, both applied after `replaceRemote`.
  - In `src/sync/lists.ts`:
    - `createList(google, store, title): Promise<TaskList>`
    - `renameList(google, store, listId, title): Promise<TaskList>`
    - `deleteList(google, store, listId): Promise<void>`

    Each throws `BlankNameError` (exported) for a blank trimmed title, without calling Google. Google errors propagate, and the store is untouched on any error.
  - On success, `deleteList` makes one commit that does all of the following:
    - removes the list
    - removes every task whose `listId` is the list, steps included
    - removes their entries
    - dequeues every queued op whose `listId` or `toListId` is the list
    - sets `lastListId` to null if it was the list
- `openTaskCount(tasks: Task[], listId: string): number` (open top-level tasks) in `src/domain/board.ts`, for the confirm copy.

- [ ] **Step 1: Write the failing tests** (`src/sync/lists.test.ts`, with the fake Google and a fake-indexeddb store, following `src/sync/push.test.ts` setup):

```ts
test('createList adds the list in Google and the mirror', ...);
test('renameList renames in Google and the mirror', ...);
test('a blank name is refused without calling Google', ...);   // '   ' → BlankNameError; fake call log empty
test('deleteList removes the list, its tasks and steps, their entries and queued writes', ...);
test('deleteList keeps queued writes for other lists', ...);   // patch op in L2 survives; move op L2→deleted list is dropped
test('deleteList forgets the remembered Quick add list', ...);  // lastListId === deleted → null; other → unchanged
test('a failed delete leaves the store as it was', ...);        // default list → HttpError; snapshot unchanged
test('openTaskCount counts open top-level tasks only', ...);    // in board.test.ts: steps and completed excluded
```

- [ ] **Step 2: Run** `npx vitest run src/sync/lists.test.ts src/domain`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** per Interfaces. In http.ts, reuse `request` and `encodeURIComponent` the list ID as the task calls do.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sync): create, rename and delete lists online`

---

### Task 4: Sidebar list controls

**Files:**
- Modify: `src/ui/Sidebar.tsx`, `src/ui/App.tsx`, `src/ui/app.css`
- Create: `src/ui/ListMenu.tsx` if the menu outgrows Sidebar

**Interfaces:**
- Consumes: `createList`, `renameList`, `deleteList`, `BlankNameError`, `openTaskCount` (Task 3), and `snapshot.defaultListId` (Task 2).
- `Sidebar` gains these props:
  - `defaultListId: string | null`
  - `tasks: Task[]`
  - `onCreateList(title): Promise<boolean>`
  - `onRenameList(id, title): Promise<boolean>`
  - `onDeleteList(id): Promise<boolean>`

  App implements the three callbacks with its google and store. Each returns false on failure and shows the error the same way App shows other action failures.
- App, on create: if `filters.lists` is a set, add the new ID so it shows. On delete: remove the ID from the set.

- [ ] **Step 1: Build it.**
  - Each list row gets a ⋯ button (`aria-label="Actions for <title>"`). Right-click on the row opens the same menu.
  - The menu has `Rename` and, except for the default list, `Delete`.
  - Rename turns the label into a text input: Enter saves, Escape cancels, blur saves. A failure or blank name puts the old name back.
  - Delete confirms with the Global Constraints copy, using `confirm()` as CardMenu does.
  - `+ New list` sits after the list rows and opens an input the same way. Enter creates the list; Escape or blank cancels.
  - All controls are disabled with `title="You're offline"` while `navigator.onLine` is false, updated on `online`/`offline` events.
  - The drawer shares the props, so it works on the phone too.
- [ ] **Step 2: Check by hand** at `/todo/?fake`, desktop and 375 px drawer:
  - create a list, and it shows ticked even with another list unticked
  - rename it (Enter, Escape, and blank all behave as specified)
  - delete it: the count is shown, Cancel keeps it, OK removes its cards
  - My Tasks has no Delete
  - DevTools offline disables the controls
  - keyboard: Tab to ⋯, Enter opens the menu, Escape closes it
- [ ] **Step 3: Run** `npm run check && npm run build`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(ui): create, rename and delete lists from the sidebar`
