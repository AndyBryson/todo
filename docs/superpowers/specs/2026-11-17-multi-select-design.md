# Multi-select to move cards between columns: design

Status: draft for approval. Date: 2026-11-17. Builds on `2026-11-17-todo-pwa-design.md`.

## Intent

Andy wants to move many cards to another board column at once. Example: a packing list whose items all sit in Backlog, moved together into Next.

## Goals

- A **Select** button on the board turns on selection. In selection, tapping or clicking a card ticks it instead of opening it. Works the same on desktop and phone.
- **Select all** on each column heading selects that column's visible cards (the list filter applies).
- A bar at the bottom: "`<n>` selected · Move to [column ▾] · Cancel". Choosing a column moves every selected card and ends selection.
- Moved cards go to the bottom of the target column, keeping their relative order.
- Into Done completes them all in Google; out of Done reopens them, as a single drag does today.

## Non-goals

- Multi-select in Today.
- Bulk delete, bulk change of list, bulk pin.
- Dragging a group of cards.

## Anti-goals

- Half a selection moved when something fails. The move is all or nothing.
- Hidden cards (other lists, filtered out) being moved or reordered.

## Approaches

- **One batch edit (chosen):** a new store function moves all selected cards in one atomic save, reusing the single-card rules for Done.
- Calling the single-card move once per card: rejected, as it means many saves (a failure partway leaves half moved) and re-ranks the column per card.
- Group dragging: rejected by Andy; the bar is enough.

## Decisions

- Store: `moveCardsToBottom(store, taskIds, column, now)` in `src/store/edits.ts`, one commit. Cards keep their current relative order (current column order, then rank). Cards already in the target column are left where they are. Into Done: each card gets the same change as a single move into Done (completed in Google, pin cleared). Out of Done: each is reopened and placed at the bottom.
- Unknown or already-deleted IDs in the selection are skipped, not an error, since the board can change under an open selection.
- UI: selection lives in the board component's state, cleared on Cancel, after a move, and on leaving the board. Drag and drop is off while selecting. Cards show a tick box in selection; the bar is fixed to the bottom and respects the phone's bottom bar.

## Testing

- Moving three cards from two columns into Next: they land at the bottom of Next in their previous order, one commit.
- Into Done completes each and clears pins; out of Done reopens each.
- A card already in the target column stays put.
- A deleted ID in the selection is skipped.
- Selection and the bar are checked by hand, on desktop and at phone width.

## Left to the builder

- Exact styling of the tick, the bar and Select all.
- Whether Select all toggles to "Select none" when everything in the column is selected.
