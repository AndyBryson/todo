# Sidebar and filters on Today: design

Status: draft for approval. Date: 2026-11-17. Changes a decision in `2026-11-17-priority-sidebar-design.md` (filters were board-only).

## Intent

Andy wants the left-hand menu to work on Today as well as the board, with the same filters.

## Decisions

- **Shared filters (Andy's choice):** one per-device filter set drives both the board and Today.
- **What applies on Today:** the list and priority filters hide tasks from Today's three sections (Planned earlier, Planned for today, Pinned). The planned-date filter has no effect on Today (everything there is planned for today or earlier, or pinned).
- **Sidebar on Today:** the same sidebar (desktop, toggled by the top-bar ☰) and drawer (phone) appear on Today, with Lists and Filter. **Select is hidden on Today**, as multi-select is board-only.
- **Filter cue:** the ☰ and its dot show on Today too.
- **Empty state:** if filters hide everything on Today, the existing "Nothing planned and nothing pinned." line shows; when every priority is unticked, Today shows "Every priority is hidden by the filter", like the board.
- **Quick add on Today** is unchanged.

## Approach

Apply `cardVisible` with the shared filters to Today's tasks before sections are built. A task with no board entry counts as Medium priority. The sidebar and ☰ stop being board-only. Select takes a flag so Today can hide it.

## Testing

- Today sections respect the list and priority filters; the planned-date filter doesn't hide anything on Today.
- Checked by hand: sidebar and drawer on Today, ☰ dot, Select hidden, empty states.

## Non-goals

- Separate filters per page.
- Multi-select on Today.
