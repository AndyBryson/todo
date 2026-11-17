# Todo PWA

My own front end over Google Tasks, built because the Google Tasks UI is not good enough. Tasks stay in Google, so Google Home and other Google clients keep working. The app adds a merged kanban board across lists (Backlog, Next, Doing, Waiting, Done), priority by card order, and a Today view. Extra data (column, rank, pinned, priority) lives in the Drive `appDataFolder`. It is a Preact + TypeScript PWA that works offline and is hosted on GitHub Pages.

Design: `docs/superpowers/specs/2026-11-17-todo-pwa-design.md`. Implementation plan: `docs/superpowers/plans/`.

## Commands

- `npm run dev`: dev server
- `npm run build`: typecheck, then production build
- `npm run typecheck`: `tsc --noEmit`
- `npm run lint`: `biome check .`
- `npm run format`: `biome format --write .`
- `npm test`: `vitest run`
- `npm run check`: typecheck, lint and test

## Module boundaries

- `src/google/`: the only code that talks to Google (Tasks and Drive), behind a small interface so tests can use an in-memory fake.
- `src/store/`: IndexedDB mirror and the pending-write queue.
- `src/sync/`: pull, reconcile, push.
- `src/domain/`: pure functions. Board construction, Today filter, ranking, dates.
- `src/ui/`: components. No Google calls, and no logic worth testing.
- `src/dev/`: dev-only helpers. `npm run dev` then `?fake` in the URL runs the app against an in-memory fake Google with seeded tasks and its own IndexedDB (`todo-fake`). It is imported only behind `import.meta.env.DEV`, so the production build leaves it out.

## Runtime rules

- One window at a time. Each window has its own copy of the queue and mirror, so a Web Lock keeps a second window out and it shows a message instead.
- Tasks completed more than 7 days ago drop out of the pull, so their board entries go too. If one is reopened later, it lands at the bottom of Backlog, or of Next if it is in the default list (My Tasks).
- Tasks first seen in My Tasks (Google's `@default` list, never matched by name) start in Next, so Google Home tasks are ready to act on. A first import, or a board that reads as empty, still puts everything in Backlog.
- Completed steps (subtasks) are fetched at any age so a card's step count stays right; the Done column still shows only top-level tasks completed in the last 7 days.
- Steps are ordered by Google's `position`. While changes wait, the app renumbers positions locally and the next pull replaces them. Google's insert without `previous` puts a task first, so a step create names its previous sibling.
- Priority lives on board entries in `board.json`. Medium is stored as no field, and any other stored value reads as Medium.
- Board entries keep unrecognised fields in `extra`. Never rebuild an entry from the known fields only. `board.json` output must stay byte-stable for unchanged data; a test pins it.
- Filters (`todo.filter`, `todo.priorities`, `todo.planned`, `todo.sidebar`) are per device and shared by the board and Today. On Today only the list and priority filters apply; the planned-date filter is board-only.

## Testing policy

Tests exist where there are rules that can be wrong. A test must be able to fail because of a real bug.

- Today filter and due dates as calendar dates, including across the UTC boundary.
- Rank insertion and rebalancing.
- Reconcile: new tasks, missing tasks, Done and reopen, Home-created tasks.
- Queue replay and merge on conflict, using a fake `google/` implementation.
- Step create and reorder, and replay when a step or its parent was deleted elsewhere.

Not tested: snapshots, render-only component tests, and any test that only asserts a mock was called. UI behaviour such as drag and drop is checked by hand unless an automated check is cheap and stable.

## Comments

Explain why, never what. No comments that narrate the code.

## Dependencies

Runtime dependencies are `preact`, `idb` and `sortablejs` only. Any new one needs a stated reason in the commit message.

## Definition of done

`npm run check` passes. UI changes also get a manual check in the browser.

## House style

UK English and plain wording in UI copy, docs and comments. Due dates are calendar dates (`YYYY-MM-DD`), never converted through local time. Google's `due` field is the planned date, not a deadline (the Tasks API has no deadline field), so the UI calls it "Planned" and never "Due" or "Overdue"; code keeps the name `due`. `board.json` holds task IDs and board metadata only, never titles or notes.
