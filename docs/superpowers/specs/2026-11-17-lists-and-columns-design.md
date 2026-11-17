# Manage lists, drop Waiting, Google Home tasks to Next: design

Status: draft for approval. Date: 2026-11-17.

## Intent

Andy wants to run his lists from the app instead of going to Google Tasks: create, rename and delete them. Waiting is a column he doesn't use. Tasks he adds by voice ("Hey Google, remind me at 18:00 to …") land in Google's default list, My Tasks, and he wants those to start in Next, ready to act on, not buried in Backlog.

## Goals

1. **Lists:** create, rename and delete Google Tasks lists from the sidebar. They are real Google lists, so Google Tasks and Google Home see the same lists.
2. **Four columns:** Backlog, Next, Doing, Done. Waiting goes from the board, the phone switcher, the card menu, Move to, and every other place that lists columns.
3. **Google Home tasks to Next:** a top-level task the app sees for the first time in the default list gets a board entry in Next instead of Backlog. Tasks first seen in any other list still go to Backlog.

## Non-goals

- Working on lists offline (see Approaches).
- Reordering lists or choosing their colour.
- Changing where Quick add or other in-app creation puts a task; they keep their current column.

## Anti-goals

- A delete that removes tasks without Andy seeing how many first.
- Board entries being rebuilt from known fields only, or `board.json` holding list names.
- A "Waiting" value left in old board data making a card lose its priority or pin.

## Approaches

- **Online only (chosen, A).** Create, rename and delete call Google directly and wait for the answer. Offline, the controls are disabled with "You're offline". Lists change rarely, and keeping them out of the queue avoids tasks pointing at a list Google hasn't created yet.
- Through the offline queue (rejected, B): needs temporary list IDs and an ID-rename step in the most fragile part of the app, for a rare action.
- **Controls in the sidebar (chosen, 1):** each list row has a ⋯ button (right-click on the row opens the same menu) with Rename and Delete; a "+ New list" row ends the Lists section. Rename edits the name in place.
- A separate Manage lists dialog (rejected, 2): an extra click every time.

## Decisions

- **Which list is My Tasks:** the app asks Google for the default list (the `@default` list alias), not by name, because the name can be renamed or translated. Until the app has learnt the default list's ID (for example, first start offline after the update), new tasks go to Backlog as before. *(Builder's call.)*
- **Only genuinely new tasks go to Next (builder's call):** the Next rule applies only when the board already has entries. A first import, a fresh Drive or a damaged `board.json` that reads as empty puts everything in Backlog as today, rather than flooding Next with every open My Tasks task.
- **Delete** asks first: "Delete “Packing” and its 12 tasks? This can't be undone." The count is the list's open top-level tasks in the app (steps and old completed tasks aren't counted; Google removes them too, which the "can't be undone" covers). Google doesn't allow deleting the default list, so its menu has no Delete item (hidden, not greyed out). *(Builder's call on the count.)*
- **After a successful delete (builder's call),** one local change removes the list, its tasks, their board entries and any queued writes for them at once, so its cards vanish straight away even while other changes are still waiting to sync. `board.json` is then written by the next sync as usual.
- **After a create or rename,** the list is updated in the mirror from Google's reply, so the change shows at once without waiting for a pull.
- **New list:** ticked in the list filter (shown), even when some lists are unticked. Deleted lists leave the filter set and stop being Quick add's remembered list. Lists created elsewhere keep today's behaviour.
- **Names:** a blank name is refused; names are trimmed.
- **Errors:** a failed create, rename or delete (offline included) shows a plain message and leaves things as they were; an in-place rename goes back to the old name. The controls are disabled while the browser reports it's offline.
- **Old "Waiting" data (Andy: there are no Waiting cards, no migration needed; builder's call on the fallback):** an entry whose `column` or `openColumn` reads "Waiting" is read as Next, keeping its rank, priority, pin and `extra`, so nothing is lost. It is a read-time fallback only: the file is rewritten whenever the entry next changes.
- **Reopened old tasks:** a task completed more than 7 days ago and then reopened is "seen for the first time"; in My Tasks it now lands in Next (CLAUDE.md's runtime rule is updated to say so).

## Testing

- Reconcile: a new task in the default list gets Next; a new task elsewhere gets Backlog; a new completed task in the default list still goes to Done; with no entries at all (first import), default-list tasks go to Backlog.
- Deleting a list locally removes its tasks, entries and queued writes, and leaves other lists' queued writes alone.
- Board parsing: a stored "Waiting" reads as Next with priority, pin and `extra` kept; output stays byte-stable.
- The fake Google gains list create, rename and delete, and a default list, so the app runs with `?fake`.
- Checked by hand: create, rename, delete (with the count, and cancel), My Tasks has no Delete, offline disables the controls, four columns on desktop and phone.

## Left to the builder

- Exact markup of the ⋯ menu and the in-place rename, within the current sidebar style.
- How and where the default list ID is stored, and how the controls learn they're offline.
