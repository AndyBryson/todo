# Settings page and account names: design

Status: approved. Date: 2026-11-19. A small change on top of the two-accounts design (`2026-11-19-two-accounts-design.md`).

## Intent

With two accounts signed in, Andy wants to choose what each account is called, so a name like "Andy Bryson" can read "Me" and the household account can read "Home". He also wants account management out of the left-hand sidebar. A settings page holds it instead.

## Goals

- Rename any account. The name is saved with the account in Google, so every device signed in to that account shows it. Elle sees the same name for the shared account.
- An empty name goes back to the Google account name.
- A settings page at `#/settings` with one section, Accounts. Each account gets a row with its name, its email, its sync state, Rename, Sign in or Sign out, and Remove. Below the rows is "Add account".
- The sidebar keeps only the lists, grouped by account name, plus Filter and Select.

## Non-goals

- Moving filters or other per-device settings to the settings page. Filters stay in the sidebar, because they are changed while looking at the board (Claude's call).
- Showing who renamed an account.

## Anti-goals

- Changing `board.json` in any way.
- Needing the settings page just to sign back in. The header's "Sign in to …" buttons stay.

## Approaches

- **A. A separate `account.json` in each account's app data folder. Chosen by Andy.** It leaves `board.json` untouched, and a device that hasn't updated yet ignores the file.
- B. A `name` field at the top of `board.json`. Rejected: a device that hasn't updated would rewrite `board.json` without the field, and the name would quietly disappear. It would also put typed text into a file that holds only IDs and board metadata.

## Design

- **The file.** `account.json` in `appDataFolder` holds `{ "version": 1, "name": string, "updatedAt": ISO string }`.
  - Damaged or unknown content reads as "no name set".
  - The Drive code gains a general read and write for a named app-data file, with the same version check and retry that `board.json` uses. `readBoard` and `writeBoard` become thin wrappers over it.
- **Local copy.** Each store keeps the name and its `updatedAt` in meta, so a rename shows at once and works offline.
- **Sync.** On each pull, read `account.json` and keep whichever copy is newer, the local one or the remote one (newest `updatedAt` wins). Write the file only when the local copy is newer. This is the same pattern `board.json` uses. When two people rename at about the same time, the later rename wins.
- **Label.** The account's label is its saved name if one is set, then the Google display name, then the email. Everything that shows a label uses this order: the sidebar groups, list-name clashes, the header, the "Move to" groups and the copy prompt.
- **Renaming.** The settings page shows the name as text with a Rename button. Rename turns it into a field.
  - Enter or leaving the field saves. Escape cancels.
  - The name is trimmed. An empty name clears the saved name, and that is synced too, as an empty `name`.
- **Settings route.** The settings page lives at `#/settings`. A gear button in the header, beside Board and Today, opens it. On the phone the gear sits at the top right, and the bottom bar is unchanged.
- **Moving the controls.** These move from the sidebar to the settings page:
  - Sign in, Sign out and Remove, including the confirmation when changes haven't been sent
  - "Add account" and its duplicate message
  - the switch-account hint

## Left to the builder

- The settings page layout and styling, kept to the app's existing look. It must work at phone width and in dark mode.
- Whether the sync state on each row reuses the header's wording.
- How the account state is passed to the page.

## Testing

As the testing policy requires, test the rules that can be wrong:
- parsing `account.json`, including damaged content
- the newest-wins merge, including clearing a name
- the label order
- a rename made offline syncs after the next pull
- a rename on another device arrives on the next pull

Check the UI by hand in `?fake` mode.
