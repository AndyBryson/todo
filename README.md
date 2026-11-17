# Todo

A kanban board and Today view on top of Google Tasks. It works offline and installs on desktop and phone.

**Live:** <https://andybryson.github.io/todo/>

Your tasks stay in Google Tasks, so Google Home, the Google Tasks app and anything else that uses them keep working. Todo adds a better way to see and arrange them.

## What it does

- **One board across all your lists.** Columns: Backlog, Next, Doing, Waiting, Done. Drag cards between columns and up and down. Order within a column is the priority.
- **List chips and filters.** Each card shows its list as a coloured chip. Filter the board to one or more lists.
- **Today.** Tasks planned for today, tasks planned earlier and not yet done, and anything you've pinned.
- **Steps.** A task's subtasks appear as a checklist in its detail panel. Add, rename, tick, delete and reorder them (drag, or Alt+Up / Alt+Down).
- **Move many at once.** Press Select, tick cards (or Select all in a column), choose a column and press Move.
- **Quick add** on the board and in Today. Added from Today, a task is also pinned.
- **Works offline.** Edits apply at once and sync when you're back online. If someone changes the same field elsewhere, their change is kept and you get a notice with your version, so nothing is lost silently.
- **Phone layout.** One column at a time, with a bottom bar for Board, Today and Add.

## How it works

- **Google Tasks** holds the tasks themselves: title, notes, planned date, completed state, list and subtasks.
- **Your Google Drive's hidden app folder** holds one small file, `board.json`, with each task's column, order and pin. It holds task IDs only, never titles or notes. The app can't see any of your other Drive files.
- **Your browser** keeps a copy of both so the app opens instantly and works offline.

Nothing goes to any other server. There's no tracking. See the [privacy page](https://andybryson.github.io/todo/privacy.html).

## Things to know

- **"Planned", not "due".** Google Tasks' date is a planned date. Google doesn't share a task's deadline with other apps, so Todo can't show or set one.
- **Sign in roughly hourly on iPhone.** Google's browser sign-in lasts about an hour, and browsers often block the quiet renewal. When the header says "Sign in needed", tap Sign in. Editing keeps working meanwhile.
- **One window at a time.** A second window shows a message instead of the app, so two copies can't fight over unsynced changes.
- **Done shows the last 7 days.** Tasks completed longer ago drop off the board. Completed steps are kept at any age, so step counts stay right.
- **Lists are created and renamed in Google Tasks**, not in the app.

## Install

- **Desktop Chrome or Edge:** open the live link, then use the install icon in the address bar.
- **iPhone:** open the live link in Safari, then Share → Add to Home Screen.

## Run your own copy

You need a Google Cloud project with the Tasks and Drive APIs enabled, an OAuth web client, and GitHub Pages. [docs/setup.md](docs/setup.md) walks through it step by step. Put your client ID in `src/config.ts` and change the Pages origin and the `base` in `vite.config.ts` to match your account and repo name.

## Development

Needs Node 24 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173/todo/?fake> to run against a fake, in-memory Google with sample tasks. It needs no sign-in and uses its own browser storage, so it never touches real data. Without `?fake` the dev server uses your real Google account; `http://localhost:5173` must be an authorised origin on your OAuth client.

| Command          | What it does                                         |
| ---------------- | ---------------------------------------------------- |
| `npm run dev`    | Dev server                                           |
| `npm run check`  | Typecheck, lint and tests (the bar for every change) |
| `npm test`       | Tests only                                           |
| `npm run build`  | Typecheck and production build into `dist/`          |
| `npm run format` | Format with Biome                                    |

Every push runs the checks in GitHub Actions; a push to `main` also deploys to GitHub Pages.

### Code layout

| Folder        | Holds                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| `src/google/` | The only code that talks to Google (Tasks and Drive), plus an in-memory fake for tests |
| `src/store/`  | The browser copy (IndexedDB), the queue of changes waiting to sync, and every edit     |
| `src/sync/`   | Sending queued changes, pulling from Google, merging `board.json`, and when to sync    |
| `src/domain/` | Pure rules: board building, ordering, Today, dates                                     |
| `src/ui/`     | Preact components                                                                      |
| `src/dev/`    | The `?fake` sample data; left out of production builds                                 |

`CLAUDE.md` has the project rules (testing policy, comments, dependencies, definition of done). The designs behind the app and each feature are in `docs/superpowers/specs/`.

Built with TypeScript, Preact, Vite, SortableJS, idb, Vitest and Biome.

## Licence

MIT. See [LICENSE](LICENSE).
