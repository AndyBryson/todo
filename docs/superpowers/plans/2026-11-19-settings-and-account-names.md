# Settings Page and Account Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any account be renamed, with the name saved in that account's own `account.json` in Google, and move account management from the sidebar to a new settings page at `#/settings`.

**Architecture:**
- Drive gains a general read and write for a named file in the app data folder. `board.json` uses it, and so does the new `account.json`.
- Each store keeps the account's saved name in meta, so a rename shows at once and works offline.
- The engine syncs the name after each pull, newest first. The board's sync code is the model for it.
- The UI adds a settings route, and every account label comes from one helper.

**Tech Stack:** Preact, TypeScript, `idb`, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-19-settings-and-account-names-design.md`

## Global Constraints

- `board.json` is not changed in any way. The test that pins its bytes still passes untouched.
- Runtime dependencies stay `preact`, `idb` and `sortablejs`.
- `src/google/` stays the only code that talks to Google. `src/ui/` holds no logic worth testing.
- UK English and plain wording. Comments explain why, never what.
- Tests must be able to fail because of a real bug. No snapshot tests, render-only tests, or "mock was called" tests.
- Done means `npm run check` passes, and UI changes are checked by hand in `?fake` mode.

## Review Focus

- **A rename made offline** shows straight away. Once the account is back online, it reaches Google on the next sync (Task 2 test).
- **Clearing a name** (saving an empty name) brings back the Google name on every device, including devices that had the old name (Task 2 test).
- **A damaged or foreign `account.json`** reads as "no name set". It never stops sync (Task 2 test).
- **Two devices renaming close together.** The later rename wins on both devices, and neither keeps rewriting the file (Task 2 test).
- **A signed-out account still shows its saved name** in settings (Task 3 test).

---

### Task 1: Read and write any named app data file

**Files:**
- Modify: `src/google/api.ts`, `src/google/http.ts`, `src/google/fake.ts`
- Test: `src/google/http.test.ts`, `src/google/fake.test.ts`

**Interfaces:**
- Produces:
  - `GoogleApi.readAppFile(name: string): Promise<{ raw: string | null; version: string | null }>`
  - `GoogleApi.writeAppFile(name: string, raw: string, expectedVersion: string | null): Promise<'ok' | 'conflict'>`
  - `readBoard()` and `writeBoard()` stay in the interface and become wrappers for `'board.json'`.
  - The fake keeps a map from file name to `{ raw, version }`. The existing `board` seed and `readBoard`/`writeBoard` behave as they do today. A new seed option is `files?: Record<string, string>`.

- [ ] **Step 1: Write the failing tests**
  - `readAppFile finds the named file`: the stubbed Drive query asks for `name='account.json'`, then returns its version and content.
  - `writeAppFile creates the named file`: when no file exists and the expected version is `null`, it does a multipart POST with metadata `{"name":"account.json","parents":["appDataFolder"]}`.
  - `writeAppFile reports a conflict on a version mismatch`.
  - In the fake: `files are kept apart by name`. Writing `account.json` leaves `readBoard()` unchanged.
- [ ] **Step 2: Run `npx vitest run src/google`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Generalise `findBoard`, `readBoard` and `writeBoard` in `http.ts` to take a file name. Keep the "oldest file wins" ordering and the version check.
- [ ] **Step 4: Run `npm run check`.** Expected: PASS, and the existing board tests are unchanged.
- [ ] **Step 5: Commit** with the message `feat(google): read and write any named app data file`.

### Task 2: The account name and its sync

**Files:**
- Create: `src/domain/account-name.ts`, `src/domain/account-name.test.ts`, `src/sync/account-name.ts`, `src/sync/account-name.test.ts`
- Modify: `src/store/db.ts` (meta), `src/store/edits.ts`, `src/sync/engine.ts`

**Interfaces:**
- Consumes: `readAppFile` and `writeAppFile` (Task 1).
- Produces:
  - `interface AccountName { name: string; updatedAt: string }`. An empty `name` means "use the Google name".
  - `ACCOUNT_FILE = 'account.json'`
  - `parseAccountFile(raw: string | null): AccountName | null`. It accepts only `{ version: 1, name: string, updatedAt: string }` and returns `null` for anything else.
  - `serialiseAccountFile(n: AccountName): string`, which gives `{"version":1,"name":…,"updatedAt":…}` in that key order.
  - `newerName(local: AccountName | null, remote: AccountName | null): AccountName | null`. The later `updatedAt` wins. On a tie the remote one wins. If either is `null`, it returns the other.
  - `Snapshot.accountName: AccountName | null`, stored as JSON in meta under `accountName`, the same way `hidden` is. `Meta` includes it. A value that doesn't parse reads as `null`.
  - `renameAccount(store: Store, name: string, now: string): Promise<void>` in `edits.ts`. It trims the name and commits `meta: { accountName: { name, updatedAt: now } }`.
  - `syncAccountName(google: GoogleApi, store: Store): Promise<void>`. It reads the file and works out the newer of the local and remote names.
    - If the merged name differs from the local one, it commits the merged name.
    - If the merged name is the local one and the remote file differs from it, it writes the file with the read version. On a conflict it rereads and retries up to 3 times, the same pattern as `syncBoard`.
  - The engine calls `syncAccountName` after a pull that succeeds, inside the same `cycle` try block, so auth and offline errors are handled as they are today.

- [ ] **Step 1: Write the failing tests:**
  - `account-name.test.ts`:
    - `a damaged file reads as no name`: inputs are `'{'`, `'[]'`, `{"version":2,…}` and a name that isn't a string.
    - `round trip keeps the name`
    - `newer wins and a tie goes to the remote copy`
  - `sync/account-name.test.ts`, using the fake Google and a real store:
    - `a rename made offline is written on the next sync`: rename, then sync. The fake's `account.json` should have the new name.
    - `a rename from another device arrives`: the fake file is newer, so after a sync the store's `accountName` equals it.
    - `clearing the name syncs as an empty name`
    - `two devices settle on the later rename`: two stores share one fake and rename at `t1` and `t2`. After syncing each twice, both have the `t2` name. The second round writes nothing, which you can check with the fake's `calls`.
    - `a damaged remote file is replaced by the local name`
- [ ] **Step 2: Run `npx vitest run src/domain/account-name.test.ts src/sync/account-name.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): keep each account's name in its own account.json`.

### Task 3: Labels from one place, and renaming through the workspace

**Files:**
- Modify: `src/accounts/workspace.ts`, `src/accounts/set.ts` (only if a label is computed there)
- Create or modify: `accountLabel` in `src/domain/account-name.ts`
- Test: `src/domain/account-name.test.ts`, `src/accounts/workspace.test.ts`

**Interfaces:**
- Consumes: `AccountName`, `renameAccount` and `Snapshot.accountName` (Task 2), and `AccountRecord` (`src/accounts/registry.ts`).
- Produces:
  - `accountLabel(record: Pick<AccountRecord, 'label' | 'email'>, saved: AccountName | null): string`. It returns, in order: the saved non-empty name, then `record.label`, then `record.email`, then `'Account'`.
  - `Workspace.accountLabel(accountId: string): string`. It works for every account, including signed-out ones.
  - `Workspace.renameAccount(accountId: string, name: string, now: string): Promise<void>`. It calls `renameAccount` on that account's store, then calls `requestSync()`.
  - `merged()` uses `accountLabel` for each view's label, so list-name clashes and the "Move to" groups pick up renames.

- [ ] **Step 1: Write the failing tests:**
  - `label order: saved name, then Google name, then email, then Account`. An empty saved name falls through.
  - `renaming changes the merged label and the clash suffix`: two accounts both have "My Tasks". After renaming Shared to "Home", `listName` reads "My Tasks · Home".
  - `a signed-out account keeps its saved name`
- [ ] **Step 2: Run `npx vitest run src/domain/account-name.test.ts src/accounts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(accounts): rename an account, and take every label from one rule`.

### Task 4: Settings page

**Files:**
- Create: `src/ui/Settings.tsx`
- Modify: `src/ui/App.tsx`, `src/ui/Header.tsx`, `src/ui/PhoneNav.tsx` (only if the gear lives there), `src/ui/Sidebar.tsx`, `src/ui/app.css`

**Interfaces:**
- Consumes: `Workspace.accountLabel` and `Workspace.renameAccount` (Task 3), and the existing `AccountSet` (`signIn`, `signOut`, `remove`, `add`).

- [ ] **Step 1: Add the route.** Add `#/settings` to the route parsing in `App.tsx`. Selection mode is turned off there, as it is on Today.
- [ ] **Step 2: Add the gear button.** In the header, put a gear link to `#/settings` beside Board and Today, with `aria-label="Settings"` and `aria-current` when active. On the phone it sits at the top right of the header. The bottom bar is unchanged.
- [ ] **Step 3: Build `Settings.tsx`.** It has a heading "Settings" and a section "Accounts", with one row for each account in `set.all()`. Each row shows:
  - the label
  - the email
  - the sync state, using the header's wording for that account's status
  - a Rename button, which turns the label into a text field. Enter or blur saves through `workspace.renameAccount`, and Escape cancels.
  - Sign in when the account needs it, Sign out when it is signed in, and Remove

  Below the rows is "Add account".
- [ ] **Step 4: Move the account controls out of the sidebar.** Move these from `Sidebar.tsx` and `App.tsx`, unchanged in behaviour and wording:
  - the Remove confirmation for unsent changes
  - the duplicate message "That account is already signed in."
  - the hint "Sign in with a different Google account, or remove this one."

  The sidebar keeps the account headings and lists, "New list", Filter and Select. Header sign-in buttons use `workspace.accountLabel`.
- [ ] **Step 5: Run `npm run check` and `npm run build`.** Expected: PASS.
- [ ] **Step 6: Check by hand** with `npm run dev`, `?fake`, at desktop and phone width, in light and dark:
  - the gear opens Settings
  - rename "Shared" to "Home", and the sidebar heading, chips and "Move to" group follow it
  - clearing the name brings back "Shared"
  - sign out, sign in, Remove and Add account all work from Settings
  - the sidebar has no account buttons
- [ ] **Step 7: Update `CLAUDE.md`.** Add one runtime rule: "An account's name lives in its own `account.json` (newest rename wins), not in `board.json`." Then commit with the message `feat(ui): settings page for accounts, with renaming`.
