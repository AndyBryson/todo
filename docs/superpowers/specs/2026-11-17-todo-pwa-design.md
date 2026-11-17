# Todo PWA: design

Status: draft for approval. Date: 2026-11-17.

## Intent

Andy dislikes the Google Tasks UI. He wants his own front end over Google Tasks. Tasks stay in Google so Google Home and other Google clients keep working. The new UI adds a merged kanban board across lists, priority by card order, and a Today view. Extra data lives in his personal Google Drive.

## Goals

- Google Tasks remains the source of truth for task content: title, notes, due date, completed state, list, subtasks.
- One board across all lists. Fixed columns: Backlog, Next, Doing, Waiting, Done.
- Drag a card between columns, and up or down within a column. Card order in a column is the priority. There is no separate priority field.
- The Google list name shows on each card as a coloured chip. The board can be filtered by list.
- Today view: overdue, due today, and pinned tasks.
- PWA for desktop and phone. Opens instantly and works offline.
- Extra data (column, rank, pinned) is stored in the Drive `appDataFolder`.
- Hosted on GitHub Pages from Andy's personal account.

## Non-goals (v1)

- Creating, renaming or deleting lists. Do that in Google.
- Subtasks as separate cards. They show inside the parent's detail view and can be ticked there.
- Recurring tasks. The Tasks API does not expose them properly.
- Due times. The API stores a date only.
- Custom columns or settings UI. Columns are defined in code.
- Reminders or notifications.
- Multiple users.

## Anti-goals

- Anything that can lose or corrupt tasks in Google.
- Silent data loss when a conflict happens.
- AI slop: speculative abstractions, wrapper layers with one caller, comments that narrate the code, dependencies added for convenience, and tests that restate the implementation.

## Constraints

- Tasks API fields: title, notes, due (date only), status, parent, position, links. No custom fields.
- Browser sign-in through Google Identity Services gives access tokens of about one hour and no refresh token. The app re-authorises silently. On an iOS PWA this may need a popup.
- The OAuth consent screen must be set to "in production" (unverified, personal use). In "testing" mode, consent expires after 7 days. Production shows a warning screen at sign-in.
- Scopes: Tasks, and Drive `appdata` only.
- GitHub Pages on a free plan needs a public repo. The OAuth client ID is public. No secrets go in the repo.
- Task titles never go in the Drive file. It holds task IDs and board metadata only.

## Approaches considered

1. Static app, online only. Smallest. No offline, and every token expiry interrupts the user.
2. Static app with a local copy (IndexedDB) and a queue of pending writes. More code and a sync layer to get right. Chosen by Andy.
3. Static app plus a Cloudflare Worker holding the refresh token. Seamless sign-in on a phone, but adds a server and a secret. Revisit only if re-sign-in proves annoying.

With option 2, token expiry affects syncing only. Reading and editing keep working.

## Decisions

### Stack (my call)

TypeScript (strict), Preact, Vite, Biome for lint and format, Vitest. A service worker for offline. Few runtime dependencies. New ones need a reason.

### Modules

- `google/`: the only code that talks to Google (Tasks and Drive). Exposed as a small interface so tests can use an in-memory fake.
- `store/`: IndexedDB mirror and the pending-write queue.
- `sync/`: pull, reconcile, push.
- `domain/`: pure functions. Board construction, Today filter, ranking, date handling.
- `ui/`: components. No Google calls here.

### Data

Drive file `board.json` in `appDataFolder`. One entry per task ID:

- `column`: Backlog, Next, Doing, Waiting or Done
- `rank`: ordering within the column
- `pinned`: boolean
- `openColumn`: the last non-Done column, so reopening a task restores its place
- `updatedAt`: for merging

Rules:

- A live task with no entry (created in Home, Google Tasks, or by an assistant) goes to the bottom of Backlog.
- An entry whose task no longer exists is pruned, but only after a pull that completed in full.
- Google's completed state wins. A completed task shows in Done. Dragging a card to Done completes the task in Google. Dragging out of Done reopens it and restores `openColumn`. A task reopened in Google moves back out of Done the same way.
- Done shows tasks completed in the last 7 days.
- The Drive file is updated by read, merge per entry (newest `updatedAt` wins), then write. If the write loses a race with another device, re-read and retry.
- First run: every open task goes to Backlog in Google's own order.

### Sync

- Pull on app open, on focus, and on a timer while visible. Push after each local edit.
- Local edits apply immediately and are queued. The queue replays in order when online.
- If a queued edit targets a task deleted elsewhere, drop it and show a notice.
- The header shows synced time, offline, or sign-in needed.

### Board

- Filter chips: all lists, plus one per list. Multi-select.
- Card: title, list chip, due date, pin icon. The chip colour comes from a hash of the list ID, so it matches across devices.
- Card detail: title, notes, due date, list, column, pin, delete, subtasks as a checklist.
- Moving a task between lists uses `tasks.move` with `destinationTasklist`. The builder must confirm this works as expected before relying on it.
- Quick add on the board and in Today. The list defaults to the last used. Added from the board, it lands at the bottom of Backlog. Added from Today, it is also pinned.

### Today

- Sections: Overdue, Due today, Pinned.
- A due date is a calendar date, not an instant. Google returns it as midnight UTC. "Today" is the device's local date.
- Ticking a task completes it, which moves it to Done. Completing a task clears its pin.
- A pin stays until the user removes it or the task is completed.

### Phone

- One column at a time, with a column switcher at the top.
- Bottom bar: Board, Today, Add.
- Move a card by long-press drag, or from a "move to" menu in the card detail.

### Testing

Tests exist where there are rules that can be wrong. A test must be able to fail because of a real bug.

- Today filter and due dates as calendar dates, including across the UTC boundary.
- Rank insertion and rebalancing.
- Reconcile: new tasks, missing tasks, Done and reopen, Home-created tasks.
- Queue replay and merge on conflict, using a fake `google/` implementation.

Not tested: snapshots, render-only component tests, and any test that only asserts a mock was called. UI behaviour such as drag and drop is checked by hand unless an automated check is cheap and stable.

### CLAUDE.md

Written as part of the first implementation plan. It covers: what the project is, commands, module boundaries, testing policy above, comment and dependency policy, definition of done (typecheck, lint, tests pass), and house style (UK English, plain wording).

### CI and deploy

GitHub Actions on each push: typecheck, lint, test, build. Deploys to Pages from the main branch.

## Prerequisites for Andy

- Google Cloud project with the Tasks API and Drive API enabled.
- OAuth web client. Authorised JavaScript origin is `https://<github-username>.github.io`. Consent screen set to production.
- GitHub repo (public) with Pages enabled.

The builder gives step-by-step instructions for these.

## Left to the builder

- Rank scheme.
- Drag-and-drop library (must support touch).
- Service worker approach.
- Chip colour palette.
- Sync intervals.
- Biome configuration.
- Exact folder layout inside the modules above.

## My calls (not yet confirmed by Andy)

- Stack: Preact, Vite, Biome, Vitest.
- Multi-select list filters.
- Done shows the last 7 days.
- Pin clears on completion.
- Added from Today means pinned.
- Reopened tasks restore their previous column.
- Public repo named `todo`.
- First-run import puts every open task in Backlog.
