# Two Accounts on One Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run several Google accounts (in practice personal plus a shared household account) at once, on one board and one Today view, with a shared card's place stored in its own account's `board.json`, and with a safe "move to another account".

**Architecture:** Each account keeps today's machinery unchanged: its own IndexedDB store, `Auth`, `GoogleApi` and sync engine. A new `src/accounts/` layer holds the set of accounts, merges their snapshots into one view for the UI, and routes every edit to the store that owns the task or list. A move between accounts is a copy in the target queue, ending in a `handoff` op that enqueues a fingerprint-checked `transferDelete` in the source queue.

**Tech Stack:** Preact, TypeScript, `idb`, Vitest, Biome. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-two-accounts-design.md`

## Global Constraints

- Runtime dependencies stay `preact`, `idb` and `sortablejs`.
- `src/google/` stays the only code that talks to Google. `src/ui/` makes no Google calls and holds no logic worth testing.
- `board.json` holds task IDs and board metadata only, never titles or notes, and stays byte-stable for unchanged data.
- Due dates are calendar dates (`YYYY-MM-DD`). The UI says "Planned", never "Due" or "Overdue".
- UK English and plain wording in UI copy, docs and comments. Comments explain why, never what.
- Tests must be able to fail because of a real bug. No snapshot tests, render-only tests, or "mock was called" tests.
- One window at a time: a single app-wide Web Lock (`todo-app`, `todo-app-fake`).
- Signing out forgets the token on this device only. It never revokes Google's grant.
- Done: `npm run check` passes, and UI changes are checked by hand in the browser (`npm run dev`, `?fake`).

## Review Focus

- **Upgrading an existing single-account device.** The old `todo` database, its unsent queue and the saved token must carry over to the first account with nothing lost (Task 1 test, Task 7 test).
- **A quiet renewal that returns the other Google account.** The token must be thrown away and the account show "sign-in needed". It must never sync one account's queue with the other's token (Task 7 test).
- **Moving a task that has completed steps, notes and a Planned date, or that is itself in Done.** The copy keeps every field, the step order and the Done state (Task 5 test).
- **Multi-select across both accounts, moved to the bottom of a column.** Every card ends below the column's previous bottom card, in board order, whichever account owns it (Task 7 test).
- **The last-used list belongs to an account that was removed or signed out.** Quick add falls back to the first visible list instead of failing (Task 7 test).

---

## File Structure

- `src/accounts/registry.ts` (new): the account records in `localStorage`, plus migration from single-account keys.
- `src/accounts/set.ts` (new): the open accounts (store, auth, google, engine), add, sign-in, sign-out and remove, the identity check, the handoff hook, and the transfer sweep.
- `src/accounts/workspace.ts` (new): the merged view and edit routing the UI uses in place of `Store`.
- `src/domain/merge.ts` (new): pure merge of account snapshots, display names, and the combined sync status.
- `src/google/auth.ts`, `api.ts`, `http.ts`, `fake.ts`: per-account keys, login hint, account chooser, `forget()`, `getAccount()`.
- `src/store/db.ts`: `hidden` meta and two new op kinds.
- `src/store/edits.ts`: `others` entries for ranking across accounts, `copyToAccount`, `hasUnsent`.
- `src/sync/push.ts`, `engine.ts`: replay `handoff` and `transferDelete`.
- `src/main.tsx`, `src/dev/fake-backend.ts`: wiring, and two fake accounts.
- `src/ui/*`: switch from `store` to `Workspace`, add the sidebar account section, the header status, and "Move to" grouping.

---

### Task 1: Account registry and migration

**Files:**
- Create: `src/accounts/registry.ts`
- Test: `src/accounts/registry.test.ts`

**Interfaces:**
- Produces:
  - `interface AccountRecord { id: string; email: string | null; label: string | null; db: string; signedOut: boolean }`
  - `type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>`
  - `loadRegistry(storage: KeyValue): AccountRecord[]`: reads `todo.accounts`. If it's missing, migrates (below) and returns the result. Malformed records are dropped.
  - `saveRegistry(storage: KeyValue, records: AccountRecord[]): void`
  - `newAccountId(): string`: a short random ID (`crypto.randomUUID().slice(0, 8)`).
  - `tokenKey(id: string): string` returns `todo.token.<id>`. `consentKey(id: string): string` returns `todo.consented.<id>`.

- [ ] **Step 1: Write the failing tests**
  - `migrates a single-account device`: storage holds `todo.token` = `{"token":"t","expiresAt":9}` and `todo.consented` = `1`, and no `todo.accounts`. After `loadRegistry`, the result is one record `{ db: 'todo', email: null, label: null, signedOut: false }`, `todo.token.<id>` holds the old token string, `todo.consented.<id>` = `1`, the old keys are removed, and `todo.accounts` is saved.
  - `a fresh device also gets a first record on db todo`: empty storage gives one record with `db: 'todo'` and no token key.
  - `migration runs once`: a second `loadRegistry` returns the same ID and doesn't change the keys.
  - `drops malformed records`: `todo.accounts` = `[{"id":"a"},{"id":"b","db":"todo-b","email":null,"label":null,"signedOut":false}]` returns only `b`.
- [ ] **Step 2: Run `npx vitest run src/accounts/registry.test.ts`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement `registry.ts`** as specified. Wrap storage access in try/catch, as `auth.ts` does.
- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(accounts): account registry with migration from one account`.

### Task 2: Auth per account

**Files:**
- Modify: `src/google/auth.ts`, `src/google/gis.d.ts`
- Test: `src/google/auth.test.ts`

**Interfaces:**
- Consumes: `tokenKey`, `consentKey` (Task 1).
- Produces:
  - `createAuth(clientId: string, opts: { id: string; loginHint: () => string | null }): Auth`
  - `Auth` gains `signIn(opts?: { chooseAccount?: boolean }): Promise<void>` and `forget(): void`.
  - `forget()` clears the token and consent keys for this ID, clears the in-memory token and notifies subscribers. It doesn't call Google's revoke.

- [ ] **Step 1: Write the failing tests** (extend the existing GIS stub so `requestAccessToken` records its overrides):
  - `keeps each account's token apart`: two auths with IDs `a` and `b`. Signing in to `a` writes `todo.token.a` only, and `b.signedIn()` stays false.
  - `asks Google for the account's email`: with `loginHint: () => 'x@example.com'`, the recorded override has `login_hint: 'x@example.com'` and `prompt: ''`.
  - `the account chooser is shown when adding an account`: `signIn({ chooseAccount: true })` records `prompt: 'select_account'`.
  - `forget signs out and stops quiet renewal`: after `forget()`, `signedIn()` is false, both keys are gone, and `getToken()` rejects with `AuthError` without calling `requestAccessToken`.
- [ ] **Step 2: Run `npx vitest run src/google/auth.test.ts`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Replace `TOKEN_KEY` and `CONSENT_KEY` with the per-ID keys. Pass `login_hint` (when not null) and the prompt to `requestAccessToken`. Widen the override type in `gis.d.ts` to `{ prompt?: string; login_hint?: string }`. Check Google's GIS reference for the override name before relying on it.
- [ ] **Step 4: Run the tests.** Expected: all of `auth.test.ts` PASSES.
- [ ] **Step 5: Commit** with message `feat(auth): one sign-in per account, pinned by email`.

### Task 3: Learn the account's identity

**Files:**
- Modify: `src/google/api.ts`, `src/google/http.ts`, `src/google/fake.ts`
- Test: `src/google/http.test.ts`, `src/google/fake.test.ts`

**Interfaces:**
- Produces:
  - `GoogleApi.getAccount(): Promise<{ email: string; name: string }>`
  - `createFakeGoogle(seed?: { …existing; account?: { email: string; name: string } })`. The default account is `{ email: 'me@example.com', name: 'Me' }`.

- [ ] **Step 1: Write the failing test** `getAccount reads Drive's user`. A fetch stub answers `GET https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)` with `{"user":{"emailAddress":"a@b.c","displayName":"A"}}`. Expect `{ email: 'a@b.c', name: 'A' }`, and a 401 to throw `AuthError`, the same way other calls are tested in `http.test.ts`.
- [ ] **Step 2: Run `npx vitest run src/google/http.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement** using the existing request helper. Before committing, confirm by hand with a real token (`npm run dev`, sign in, call from the console) that `drive.appdata` allows `about.get`. If Google refuses it, add `https://www.googleapis.com/auth/userinfo.email` to `SCOPES` in `auth.ts` and read `https://www.googleapis.com/oauth2/v3/userinfo` (`email`, `name`) instead. Record which one in the commit message.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(google): read the signed-in account's email and name`.

### Task 4: Op kinds for moves between accounts, and their replay

**Files:**
- Modify: `src/store/db.ts`, `src/sync/push.ts`, `src/sync/engine.ts`
- Test: `src/sync/push.test.ts`, `src/store/edits.test.ts` (renaming)

**Interfaces:**
- Produces, in `db.ts`:
  - `interface Fingerprint { updated: string; steps: Record<string, string> }`: step ID → step `updated`.
  - Op union gains:
    - `{ kind: 'handoff'; listId: string; taskId: string; source: { accountId: string; listId: string; taskId: string; title: string }; fingerprint: Fingerprint }`. Here `taskId` is the copy's (temporary) ID, so renaming and `idOf` treat it like other ops.
    - `{ kind: 'transferDelete'; listId: string; taskId: string; title: string; fingerprint: Fingerprint }`
  - `Snapshot.hidden: Record<string, string>`: source task ID → target account ID. It's stored in the meta store as one JSON string under `hidden`, and `Meta` includes it. A missing or unparsable value reads as `{}`.
- Produces, in `push.ts`:
  - `interface ReplayHooks { handoff(op: Extract<Op, { kind: 'handoff' }>): Promise<void> }`
  - `replay(google: GoogleApi, store: Store, hooks?: ReplayHooks): Promise<ReplayResult>`. With no hooks, a `handoff` op is dequeued (tests and fake mode only).
  - `handoff`: awaits `hooks.handoff(op)`, then dequeues. A throw leaves it at the head, as with any other error.
  - `transferDelete`: `getTask(listId, taskId)` plus `listTasks(listId, <epoch>)` filtered to `parent === taskId`, compared with the fingerprint. If they match: `deleteTask`, then in one commit dequeue, `removeTasks` the task and its steps, `removeEntries`, and remove `hidden[taskId]`. If they differ: in one commit dequeue, remove `hidden[taskId]`, and add the notice `“<title>” changed while it was being moved, so both copies are kept.` On `NotFoundError` from `getTask`: in one commit dequeue and remove `hidden[taskId]`.
- Produces, in `engine.ts`: `createSyncEngine(google, store, clock?, hooks?: ReplayHooks)`, which passes the hooks to `replay`.

- [ ] **Step 1: Write the failing tests** in `push.test.ts`, using the fake Google:
  - `transferDelete deletes the original when nothing changed`: the fingerprint matches the fake's task and its two steps. After replay, the fake no longer has the task, the queue is empty, and `hidden` is `{}`.
  - `transferDelete keeps the original when a step changed elsewhere`: patch one step in the fake after taking the fingerprint. The task still exists, the notice text is exactly as above, and `hidden` is cleared.
  - `transferDelete keeps the original when the parent changed elsewhere`: same, with the parent patched.
  - `transferDelete on an already deleted task just clears up`: no notice, the queue is empty, and `hidden` is cleared.
  - `handoff calls the hook after earlier creates are sent`: queue a create then a handoff naming the create's temp ID. The hook receives the op with `taskId` renamed to the real ID, and the queue is empty afterwards.
  - `a failing handoff stays queued`: the hook throws `OfflineError`, so the result is `'offline'` and the op is still at the head.
  - In `edits.test.ts` or `db` tests: `hidden survives reopening the store` (commit `meta: { hidden: { t1: 'b' } }`, reopen, read it back).
- [ ] **Step 2: Run `npx vitest run src/sync/push.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the op kinds to `renameInOp` (`taskId` for `handoff`), `idOf`, `run` and `dropOps`, so dropping a deleted copy also drops its `handoff`. Read and write `hidden` through the existing meta path.
- [ ] **Step 4: Run `npm test`.** Expected: PASS, with no change to existing test outcomes.
- [ ] **Step 5: Commit** with message `feat(sync): handoff and checked delete for moves between accounts`.

### Task 5: Edits that span accounts

**Files:**
- Modify: `src/store/edits.ts`
- Test: `src/store/edits.test.ts`

**Interfaces:**
- Consumes: `Fingerprint`, the new op kinds and `Snapshot.hidden` (Task 4).
- Produces:
  - A trailing `others: BoardEntries = {}` parameter on `addTask`, `setCompleted`, `moveCard`, `moveCardToBottom` and `moveCardsToBottom`. Ranks and "bottom of column" are computed over `{ ...others, ...s.entries }`. Only this store's IDs are written.
  - `moveCard`, `moveCardToBottom` and `moveCardsToBottom` now return `Promise<BoardEntries>`: the stamped changes to IDs in `others`, from a rebalance, for the caller to write to their own stores. Everything else stays `Promise<void>`.
  - `putEntries(store: Store, entries: BoardEntries): Promise<void>`: writes only IDs this store already has entries for.
  - `hasUnsent(s: Snapshot, taskId: string): boolean`: true if any queued op's task is `taskId` or one of its steps, or if a create or reorder names it as `parent`.
  - `copyToAccount(source: Store, target: Store, sourceAccountId: string, targetAccountId: string, taskId: string, toListId: string, now: string): Promise<void>`. In the target, one commit does all of this:
    - Put the copy and its steps under `local-` IDs.
    - Enqueue a create for the parent (title, notes, due).
    - Enqueue creates for the steps, in `position` order, each naming the previous copied step.
    - Enqueue a `patch {completed: true}` after each completed item's create.
    - Write an entry for the parent with the original's column, rank, pinned, priority and `extra`, stamped `now`.
    - Enqueue a final `handoff` whose fingerprint comes from the source mirror.

    Then one commit in the source sets `hidden[taskId] = targetAccountId`. It throws if `hasUnsent(source.snapshot(), taskId)` or if the task is a step.

- [ ] **Step 1: Write the failing tests:**
  - `a drop between another account's cards takes a rank between them`: `others` holds `x` at rank 1024 and `y` at rank 2048 in Next. Moving local `a` after `x` gives a rank strictly between them and returns `{}`.
  - `a rebalance returns the other account's new ranks`: `others` ranks are 1 and 1+1e-7. The returned map holds new ranks for both, stamped `now`, and the local store has no entries for them.
  - `moving several cards to the bottom lands below the other account's bottom card`: covers the board-order rule.
  - `copyToAccount copies steps in order with their done state`: the source has a completed parent in Done, with notes, due `2026-12-01`, steps `s1` (completed) and `s2`. The target queue reads, in order: create parent, patch parent completed, create s1, patch s1 completed, create s2 with `previous` = s1's temp ID, then handoff. The target entry has column `Done` and the same priority. The handoff fingerprint holds the parent's and both steps' `updated`. The source `hidden` has the task.
  - `copyToAccount refuses while the task has unsent changes`: queue a patch for `s2`, and expect it to throw, with neither store changed.
- [ ] **Step 2: Run `npx vitest run src/store/edits.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Thread `others` into `placeInColumn`, `ranksIn` and `bottomOf`, then split the result by ownership.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(edits): rank across accounts and copy a task to another account`.

### Task 6: Merge snapshots and combine status

**Files:**
- Create: `src/domain/merge.ts`
- Test: `src/domain/merge.test.ts`

**Interfaces:**
- Consumes: `Snapshot` (`db.ts`), `SyncStatus` (`engine.ts`).
- Produces:
  - `interface AccountView { id: string; label: string; snapshot: Snapshot }`
  - `interface Merged { lists: TaskList[]; tasks: Task[]; entries: BoardEntries; listAccount: Record<string, string>; taskAccount: Record<string, string>; listName: Record<string, string>; notices: (Notice & { accountId: string })[]; queueLength: number }`
  - `mergeViews(views: AccountView[]): Merged`: concatenates in view order. It leaves out tasks in that account's `hidden`, along with their steps and entries. `listName` is the list title, or `<title> · <label>` when another view has a list with the same title.
  - `combineStatus(views: { label: string; status: SyncStatus }[]): { status: SyncStatus; signIn: string[] }`: `signIn` lists the labels whose status is `signin`. Otherwise it takes the worst status in this order: error, offline, syncing, idle, synced (oldest `at`).

- [ ] **Step 1: Write the failing tests:**
  - `merges two accounts and records ownership`
  - `a hidden task leaves with its steps and entry`
  - `clashing list names get the account label` (both have "My Tasks"; a unique "Work" keeps its plain name)
  - `status names every account needing sign-in`
  - `synced reports the oldest time`
- [ ] **Step 2: Run `npx vitest run src/domain/merge.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(domain): merge account snapshots into one view`.

### Task 7: Account set and workspace

**Files:**
- Create: `src/accounts/set.ts`, `src/accounts/workspace.ts`
- Test: `src/accounts/set.test.ts`, `src/accounts/workspace.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 6.
- Produces, in `set.ts`:
  - `interface Account { record: AccountRecord; store: Store; auth: Auth; google: GoogleApi; engine: SyncEngine }`
  - `interface AccountDeps { storage: KeyValue; openStore(db: string): Promise<Store>; connect(id: string, loginHint: () => string | null): { auth: Auth; google: GoogleApi }; clock?: () => Date }`
  - `createAccountSet(deps: AccountDeps): Promise<AccountSet>`. It opens a store for every record and starts engines for records that aren't `signedOut`.
  - `interface AccountSet { all(): Account[]; active(): Account[]; get(id: string): Account | undefined; add(): Promise<'added' | 'duplicate'>; signIn(id: string): Promise<void>; signOut(id: string): Promise<void>; remove(id: string): Promise<void>; subscribe(fn: () => void): () => void }`
  - The identity check runs after each successful sign-in and on start, once online. It calls `google.getAccount()`. If `record.email` is null, it saves the email, and the name as `label`. If the email differs, it calls `auth.forget()`, adds the notice `Signed in as <got>, not <expected>. Sign in again.` to that store, and the engine reports `signin`.
  - `add()` makes a new ID, calls `connect`, then `auth.signIn({ chooseAccount: true })`, then `getAccount`. A duplicate email calls `forget()` and returns `'duplicate'` without saving.
  - Each engine gets `ReplayHooks.handoff`. It commits `{ enqueue: [transferDelete …] }` to the source account's store. If the source account is gone, it does nothing.
  - `sweepTransfers()` runs after every engine reaches `synced`, after `remove` and on start. It clears `hidden[taskId]` in a source store when the target account is gone, or when neither the target queue holds a `handoff` for that source task nor the source queue holds a `transferDelete` for it.
  - `signOut` stops the engine, calls `auth.forget()` and sets `signedOut: true`. `remove` stops the engine, forgets, deletes the IndexedDB database, drops the record and sweeps. The confirm with the unsent count belongs to the UI.
- Produces, in `workspace.ts`:
  - `createWorkspace(set: AccountSet, storage: KeyValue): Workspace`
  - `interface Workspace { merged(): Merged; subscribe(fn: () => void): () => void; lastListId(): string | null; addTask(input: { listId: string; title: string; pinned: boolean }, now: string): Promise<string>; editTask(id, input): Promise<void>; setCompleted(id, completed, now): Promise<void>; moveCard(id, column, after, now): Promise<void>; moveCardToBottom(id, column, now): Promise<void>; moveCardsToBottom(ids, column, now): Promise<void>; setPinned(id, pinned, now): Promise<void>; setPriority(id, p, now): Promise<void>; deleteTask(id): Promise<void>; addSubtask(...): Promise<string>; reorderSubtask(...): Promise<void>; canMoveTo(id: string, toListId: string): 'yes' | 'unsent' | 'step'; moveToList(id: string, toListId: string, now: string): Promise<void>; createList(accountId: string, title: string): Promise<void>; renameList(listId: string, title: string): Promise<void>; deleteList(listId: string): Promise<void>; dismissNotice(accountId: string, id: string): Promise<void>; requestSync(): void }`
  - The parameter types of routed edits match the `edits.ts` functions they wrap.
  - Each edit finds the owning account through `merged().taskAccount` or `listAccount`, after following `renamed`. It passes the other active accounts' entries as `others`, and writes any returned foreign entries with `putEntries` to their owners.
  - `moveCardsToBottom` across accounts: it builds the whole order from the merged board, then calls each account's `moveCardsToBottom` in turn, passing in `others` the entries the previous calls produced.
  - `moveToList` within one account calls `edits.moveToList`. Across accounts it calls `copyToAccount`.
  - `lastListId()` reads `todo.lastList`, falling back to the first merged list when the saved list isn't visible. `addTask` writes it.

- [ ] **Step 1: Write the failing tests.** Use fake Google, in-memory stores (`openStore` with a unique name per test, under `fake-indexeddb` as the existing store tests set it up), and a fake `Auth` that hands out tokens and records `forget`. Cover these:
  - `the first start keeps the old database and its queue`: covers Review Focus.
  - `a renewal that returns another account is refused` (Review Focus): the fake's `getAccount` returns `other@example.com` for a record that holds `me@example.com`. `forget` is called, the notice is added, and nothing is replayed to the fake.
  - `adding an account already signed in is refused`
  - `a move between accounts deletes the original after the copy lands`: end to end, with two fake Googles. Running both engines gives: the copy exists in the target fake with its steps, the original is gone from the source fake, and `hidden` is empty.
  - `removing the target mid-move brings the original back`
  - `a copy dropped because its list was deleted brings the original back` (sweep)
  - `multi-select across accounts keeps board order at the bottom` (Review Focus)
  - `quick add falls back when the last list's account is gone` (Review Focus)
- [ ] **Step 2: Run `npx vitest run src/accounts`.** Expected: FAIL.
- [ ] **Step 3: Implement `set.ts` and `workspace.ts`.**
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(accounts): account set and workspace that routes edits`.

### Task 8: Wire up `main.tsx` and fake mode

**Files:**
- Modify: `src/main.tsx`, `src/dev/fake-backend.ts`

**Interfaces:**
- Consumes: `createAccountSet`, `createWorkspace`.
- Produces:
  - `App` props become `{ accounts: AccountSet; workspace: Workspace }`.
  - `createFakeBackend(which: 'me' | 'shared'): { google: FakeGoogle; auth: Auth }` seeds distinct lists, both with a "My Tasks", and accounts `me@example.com` / "Me" and `shared@example.com` / "Shared".

- [ ] **Step 1: In fake mode**, build the set with an in-memory `KeyValue` that holds two records (`todo-fake-me`, `todo-fake-shared`), `openStore` on those names, and `connect` returning `createFakeBackend(id)`.
- [ ] **Step 2: In real mode**, use `localStorage`, `openStore(db, closed)`, and `connect` = `createAuth(GOOGLE_CLIENT_ID, { id, loginHint })` plus `createHttpGoogle(() => auth.getToken())`. The lock stays as it is.
- [ ] **Step 3: Run `npm run typecheck`.** Expected: errors only in `src/ui/` (Task 9 fixes them).
- [ ] **Step 4: Commit** together with Task 9. The app doesn't build in between.

### Task 9: UI on the workspace

**Files:**
- Modify: `src/ui/App.tsx`, `Board.tsx`, `Column.tsx`, `Card.tsx`, `CardDetail.tsx`, `Checklist.tsx`, `CardMenu.tsx`, `SelectionBar.tsx`, `Sidebar.tsx`, `Header.tsx`, `QuickAdd.tsx`, `Today.tsx`, `hooks.ts`, `app.css`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `Workspace`, `AccountSet`, `Merged`, `combineStatus`.
- Produces: `useMerged(ws: Workspace): Merged` and `useStatus(set: AccountSet): ReturnType<typeof combineStatus>` in `hooks.ts`.

- [ ] **Step 1: Replace store and edits.** Every `store` prop and every direct `edits.ts` or `sync/lists.ts` call becomes `workspace`. `buildBoard` and `todaySections` take `merged.tasks`, `merged.lists` and `merged.entries`. List chips, card chips and pickers show `merged.listName[id]`.
- [ ] **Step 2: Add the sidebar accounts section.** Show each account's label, with "Sign in" when it needs it and "Sign out", plus a "Remove" that asks first when `queueLength > 0` ("This account has N changes not yet sent to Google. Remove it anyway?"). Add an "Add account" button, with the message "That account is already signed in." for a duplicate. Group the lists under their account's label.
- [ ] **Step 3: Update the header.** When `signIn` is not empty, show "Sign in to <label>" as a button per account. Otherwise show the combined status, as today.
- [ ] **Step 4: Update "Move to"** in the card menu and selection bar. Other accounts' lists sit under their label. Choosing one first asks: "This makes a copy in <label> and deletes the original. Links Google keeps for the original, such as a Google Home reminder, won't carry over." When `canMoveTo` returns `'unsent'`, the item is disabled and reads "Waiting for changes to send". A multi-select move across accounts confirms once for the whole selection.
- [ ] **Step 5: Update `CLAUDE.md`.** Change the columns to Backlog, Next, Doing, Done, and add `src/accounts/` to the module boundaries. Add these runtime rules:
  - Each account has its own store, sign-in and engine.
  - A shared card's place lives in its own account's `board.json`.
  - A move between accounts is a copy plus a checked delete.
  - Sign-out never revokes.
- [ ] **Step 6: Run `npm run check`.** Expected: PASS.
- [ ] **Step 7: Check by hand** with `npm run dev`, `?fake`, on desktop and at phone width:
  - Both accounts' cards show in one board and in Today, and "My Tasks · Shared" appears.
  - Dragging a Shared card between two Me cards keeps it there after a reload.
  - Move to a Shared list: confirm, the card stays in place, and after a sync the fake source no longer has it.
  - Sign out of Shared hides its cards. Sign in brings them back.
  - Remove with unsent changes asks first.
- [ ] **Step 8: Commit** Tasks 8 and 9 together with message `feat(ui): one board across signed-in accounts`.
