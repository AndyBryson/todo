# Two accounts on one board: design

Status: approved. Date: 2026-11-19.

## Intent

Andy and Elle share a household Google account. Each of them wants to run the app with their own personal account and the shared account signed in at the same time, and to manage tasks from both on one board. When one of them moves a shared task to Doing, the other should see it there.

Elle uses the app the same way Andy does. Neither account is special: the app shows every account that is signed in on that device.

## Goals

- Sign in to more than one Google account at once on one device. In practice that means two: personal and shared.
- One board and one Today view across all of them, with the columns, priority, pinning, filters, steps and multi-select that exist today.
- A shared task's column, position, priority and pin are shared: they live in the shared account's `board.json`, so both people see the same status.
- Moving a task from one account to another (usually personal to shared) from the card menu and the selection bar.
- Existing devices keep working with no lost data. The account already signed in becomes the first account.

## Non-goals

- An always-on server. A small sign-in server that hands out access tokens may come later as separate work (decided 2026-11-19). This design keeps each account's sign-in behind `Auth.getToken()` so one can be swapped in without touching anything else.
- Sharing lists through Google itself (Workspace Spaces). Google Home and personal accounts don't use them.
- Showing who moved or changed a card.
- Renaming accounts in the app, or more than one window at a time.

## Anti-goals

- A change reaching the wrong account. That would be worse than any missing feature.
- Losing a task during a move between accounts. A duplicate is acceptable; a loss is not.
- Breaking Google Home or Google's own Tasks clients for either account.

## Approaches

1. **One store per account (chosen).** Each account gets its own IndexedDB database, sync engine, queue and `Auth`, unchanged from today. The board merges the account snapshots before building columns. Sync, queue and reconcile code, and their tests, stay as they are apart from one new op for moves between accounts, and one account's queue can never be replayed against another account.
2. **One store with everything tagged by account.** This makes a move between accounts a single queued op, but it touches every module and test, needs a migration, and one missing tag sends a change to the wrong account. Rejected for that risk.
3. **Shared Google lists (Workspace Spaces).** Rejected: not available to personal accounts and not used by Google Home.

Shared card status had three options: shared place (chosen by Andy), per-person place, or shared column with per-person order.

## Design

### Accounts

- A device-level account registry in `localStorage` (`todo.accounts`), with one record per account: a stable local ID, the Google email, a display label, and the IndexedDB name.
- On first start after the upgrade, the existing `todo` database and saved token become the first account record, keeping database name `todo`. Its email is learnt on the next successful sync. Accounts added later get a new database name (`todo-<local id>`).
- The email and label come from the Google account: Drive `about.get?fields=user` if `drive.appdata` permits it, otherwise add the `email` scope and use the userinfo endpoint (left to the builder to confirm). The label is the Google display name, falling back to the part of the email before the @.
- Adding an account is a button in the sidebar's account section. It opens Google's account chooser (`prompt: 'select_account'`). If the chosen email is already registered, the app says so and adds nothing.
- Shared status works because Andy's and Elle's devices run the same deployed app (GitHub Pages, one OAuth client ID in `config.ts`), so both read and write the same `board.json` in the shared account's `appDataFolder`. That folder belongs to the OAuth client, so a fork with another client ID would see a separate board.
- Signing out forgets the token on this device only. It never revokes Google's grant, because that would also sign out the other person's devices on the shared account. (Claude's call.) Signing out of an account also removes its cards and lists from the board and stops its engine. Its database, including unsent changes, is kept, and signing back in resumes it. Removing an account deletes its database. If it has unsent changes, the app asks first and states how many will be lost.

### Sign-in

- Each account has its own `Auth` instance, token key (`todo.token.<local id>`) and consent flag. The existing `todo.token` and `todo.consented` values migrate to the first account.
- Each `Auth` passes the account's email as `login_hint`, so a quiet renewal never comes back with a different account. If Google returns a token for a different email anyway (the check is part of learning the email), the token is discarded and that account shows "sign-in needed".
- Header status: "sign-in needed" names the account and carries its own sign-in button, because iOS only allows the sign-in popup on a tap. Otherwise the header shows the worst state across accounts (offline, error, syncing, synced at the oldest time).

### Startup and the lock

- The Web Lock stays a single app-wide lock: one window holds all accounts.
- `main.tsx` opens one store and one engine per signed-in account and passes the set to `App`. Engines run independently, and one account being offline or signed out doesn't hold back the others.
- `?fake` mode seeds two fake accounts ("Me" and "Shared") with their own fake Google and `todo-fake-*` databases.

### Merged board and Today

- `domain/` gets a pure merge: account snapshots → one view of lists, tasks and entries, where every list and task carries its account ID. Board construction, the Today filter and ranking work on the merged view.
- A card's entry is read from, and written to, its own account's `board.json`. A shared card's place is therefore shared, as decided.
- Ranks are plain numbers, so cards from both accounts sort together in one column. Dropping a card computes its rank from the merged column, as today. If `placeCard` has to rebalance, each rebalanced card's new rank is written to its own account's store. Rebalancing shared cards changes their order for the other person too; that is accepted.
- Order across the two people's boards is only approximate, because each person sees shared cards mixed in with their own personal ones. That is accepted.
- List chips and sidebar entries show the account label when two lists from different accounts share a name (for example "My Tasks · Shared"). The sidebar groups lists by account.
- The "My Tasks starts in Next" rule applies to each account's own default list, as reconcile already does per store.
- Filters stay per device and keyed by list ID. A list from a signed-out account simply isn't shown. The last-used list for quick add moves from per-store meta to a device key (`todo.lastList`, holding account and list), so the list picker spans accounts.
- Notices from all accounts are shown together. Dismissing one goes to its own store.
- Edits (add, patch, complete, reorder steps, delete, move within one account, list create, rename and delete) go to the store of the account that owns the task or list. A multi-select action that spans accounts is split per account.

### Moving a task to another account

Google can't move a task between accounts, so the app copies it and then deletes the original.

- The card menu's and selection bar's "Move to" shows other accounts' lists in their own group. Choosing one asks once: "This makes a copy in <account> and deletes the original. Links Google keeps for the original, such as a Google Home reminder, won't carry over."
- The move is offered only once the source account has no unsent changes for that task or its steps. Until then the menu item says "Waiting for changes to send". (Claude's call: otherwise this device's own edits would look like edits from elsewhere and leave two copies.)
- Locally and straight away: the task and its steps (open and completed, in order) are added to the target store as queued creates with temporary IDs. Each create carries a transfer marker naming the source account, list and task ID, plus a fingerprint of the original: the parent's `updated` time and each step's ID and `updated` time. A board entry is added in the target account with the same column, rank, priority and pin. In the source store the task is hidden from the board, but nothing is queued there yet.
- When the target account's push has created the parent and all its steps in Google, it enqueues a conditional delete of the original in the source account's store and removes the hidden mark. This is a new op kind in `push.ts`. (Claude's call: the anti-goal outweighs keeping push unchanged.) At replay time it fetches the original and its steps from Google and compares them with the fingerprint. If they match, it deletes the original. If they differ, someone edited it in the meantime, possibly long after the move, if the source account was offline: the original is kept and unhidden, and a notice says both copies exist. Comparing the steps catches a step added or edited elsewhere, which doesn't change the parent's `updated`.
- If the target account is signed out or offline, the copy waits in its queue and the original stays hidden. If the app is closed between "copy confirmed" and "delete queued", the next start finds the transfer marker on a confirmed task and queues the delete then. At worst the result is a duplicate, never a loss.
- If the target account is removed while a copy is waiting, the original is unhidden.
- If the original was deleted elsewhere before the copy finished, the copy stands and nothing is deleted.

### Testing

As the testing policy requires, these are the rules that can be wrong:

- Merge: tasks, lists and entries from two snapshots; a list name clash; one account signed out.
- Ranking across accounts: a drop that writes to the dragged card's account; a rebalance that writes each card to its own account.
- Transfer, with two fake Google instances: the copy includes completed steps in order; the delete is queued only after every create is confirmed; the source or one of its steps is edited elsewhere, either before the delete is queued or after it is queued but before it replays (both kept, notice shown); the move is blocked while the source has unsent changes for the task; the target account is removed mid-move (original unhidden); the target is signed out (waits, original hidden); a restart between confirmation and delete; the source is deleted elsewhere first.
- Auth: a token for the wrong email is discarded; migrating the old single-account keys.
- Registry migration from the single `todo` database.

## Left to the builder

- How the account registry and multiple engines are wired in `main.tsx`, and how `App` receives them.
- Exactly how the email is learnt (see Accounts), and the account IDs' format.
- Whether the hidden mark in the source store is local only or an entry flag that other devices also see through `board.json`.
- The sidebar's account section layout. Sign-in, sign-out and add-account controls belong there.
- Header wording, kept in UK English and plain wording.
