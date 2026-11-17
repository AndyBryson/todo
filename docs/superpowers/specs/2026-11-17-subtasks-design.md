# Subtasks as a checklist: design

Status: draft for approval. Date: 2026-11-17. Builds on `2026-11-17-todo-pwa-design.md`.

## Intent

Andy wants to add and manage a task's subtasks in the app instead of going back to Google Tasks. A subtask is a step in a checklist inside its parent task. It is not a task in its own right.

## Goals

- In the card detail, a checklist of the task's subtasks where you can:
  - add a step (Enter adds it and keeps focus, so several can be typed in a row);
  - tick and untick a step (exists today);
  - rename a step in place, saved like the title and notes;
  - delete a step with one click, no confirmation;
  - reorder steps by dragging.
- Steps are real Google subtasks, so the order and content match Google Tasks and other Google clients.
- Everything works offline and syncs later, like other edits.
- A card with steps shows a count of done steps, e.g. `2/5`.

## Non-goals

- Planned dates on steps.
- Steps on the board as their own cards, or in Today.
- Moving a step to another parent, or turning a step into a task (or back).
- Subtasks of subtasks. Google allows only one level.

## Anti-goals

- A step's order in the app differing from Google's.
- An edit to a step being lost, or a step being created twice in Google, when it was added offline.

## Approaches

- **A. Real Google subtasks, order kept in Google (chosen).** Adding uses Google's insert with a `parent`. Reordering uses Google's move with `parent` and `previous`. Both are queued like other edits. Chosen because it's the only option where the order is the same everywhere.
- B. Real Google subtasks, order kept in `board.json`. Rejected: Google Tasks and the phone would show a different order, and steps added elsewhere would land in an arbitrary place.
- C. A checklist stored as lines in the task's notes. Rejected: not real subtasks, so existing subtasks wouldn't appear, and ticking wouldn't sync as completion.

## Decisions

### Data and sync

- **Adding a step** creates a local task with a temporary ID and `parent` set, placed after the last sibling, and queues a create op that carries the parent.
- **Reordering** queues a new op, `reorder`, with the list, the task, its parent and the sibling it now follows (`previous`, or none for first). Replay calls Google's `tasks.move` with `parent` and `previous`.
- **Local order while changes are waiting:** the app gives siblings temporary position values that keep the order the user set. A pull replaces them with Google's real positions. A pull only runs when nothing is waiting to sync.
- **Temporary IDs:** when a create is confirmed and its temporary ID is replaced, queued ops that refer to that ID as a `parent` or as `previous` are updated too. This replaces the v1 ruling that the parent of a queued create need not be updated, made because nothing could create subtasks then.
- **Safe retry of a create** (the adoption rule from v1) matches on the same parent, not only on top-level tasks.
- **Deleting a parent** whose new steps haven't reached Google yet drops their queued creates too, without calling Google.
- **Renaming, ticking and deleting a step** use the existing edit functions. They already work for any task.
- **A reorder whose `previous` sibling was deleted elsewhere** places the step after the nearest earlier sibling that still exists, or first. **A reorder whose step was deleted elsewhere** is dropped with the usual "deleted elsewhere" notice.

### UI

- The checklist sits where it is now in the card detail. Each row has a drag handle, a tick box, the step text (edited in place) and a delete button.
- Dragging uses SortableJS, as the board does. Steps can also be moved with the keyboard: Alt+Up and Alt+Down on a focused step.
- The "Add a step" field sits at the bottom of the list and is always shown, even when there are no steps yet.
- A blank step name is refused, like a blank task title.
- The board card shows `done/total` next to the list chip when the task has steps.

## Testing

Tests where a rule can be wrong:

- Adding a step offline under a parent that is also new: after replay, the step is under the parent's real ID in Google.
- A create whose response was lost is adopted under the right parent, not duplicated.
- Reorder replay sends the right `parent` and `previous`, including after an earlier temporary ID was replaced.
- The local order holds while a reorder is waiting, and Google's order wins after a pull.
- `previous` deleted elsewhere, and step deleted elsewhere.
- Deleting a parent drops its steps' unsent creates without calling Google.

Drag and drop is checked by hand, as on the board.

## Left to the builder

- The exact temporary position scheme.
- Whether the adapter's `moveTask` grows `parent`/`previous` options or a separate method is added.
- How the fake Google models `parent` and `previous` on move, matching real Google.
- Styling of the checklist rows and the card count.
