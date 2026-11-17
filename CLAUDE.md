# Todo PWA

My own front end over Google Tasks, built because the Google Tasks UI is not good enough. Tasks stay in Google, so Google Home and other Google clients keep working. The app adds a merged kanban board across lists (Backlog, Next, Doing, Waiting, Done), priority by card order, and a Today view. Extra data (column, rank, pinned) lives in the Drive `appDataFolder`. It is a Preact + TypeScript PWA that works offline and is hosted on GitHub Pages.

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
- Tasks completed more than 7 days ago drop out of the pull, so their board entries go too. If one is reopened later, it lands at the bottom of Backlog.

## Testing policy

Tests exist where there are rules that can be wrong. A test must be able to fail because of a real bug.

- Today filter and due dates as calendar dates, including across the UTC boundary.
- Rank insertion and rebalancing.
- Reconcile: new tasks, missing tasks, Done and reopen, Home-created tasks.
- Queue replay and merge on conflict, using a fake `google/` implementation.

Not tested: snapshots, render-only component tests, and any test that only asserts a mock was called. UI behaviour such as drag and drop is checked by hand unless an automated check is cheap and stable.

## Comments

Explain why, never what. No comments that narrate the code.

## Dependencies

Runtime dependencies are `preact`, `idb` and `sortablejs` only. Any new one needs a stated reason in the commit message.

## Definition of done

`npm run check` passes. UI changes also get a manual check in the browser.

## House style

UK English and plain wording in UI copy, docs and comments. Due dates are calendar dates (`YYYY-MM-DD`), never converted through local time. `board.json` holds task IDs and board metadata only, never titles or notes.
