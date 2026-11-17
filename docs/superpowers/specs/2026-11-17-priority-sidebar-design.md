# Priorities, filters, sidebar and right-click: design

Status: approved. Date: 2026-11-17. Builds on `2026-11-17-todo-pwa-design.md` and `2026-11-17-multi-select-design.md`.

## Intent

Andy wants to tag tasks with a Jira-style priority so he can **hide** cards he doesn't care about right now, and hide tasks planned far in the future. Card order in a column stays the priority for working order; the new priority is a label used for filtering, not sorting. He also wants a left-hand sidebar for lists, the filter and Select, and a right-click menu on cards.

## Goals

- **Priority on each task**, five levels: Highest, High, Medium, Low, Lowest. A task with none set is Medium.
- **Marker on cards:** Highest ▲▲, High ▲ (red); Low ▼, Lowest ▼▼ (blue); Medium shows nothing. Each marker has an accessible name ("Priority: High").
- **Set priority** from the card detail panel (a select) and from the right-click menu.
- **Priorities sync** between devices (stored server side, in the board file in Drive).
- **Sidebar** on the left of the board:
  - **Lists:** one tick box per list, with its colour; replaces the list chips. None ticked means all lists, as today.
  - **Filter ▾** button, showing a count of active filters, opening a dropdown with:
    - **Priorities to show:** a tick box per level. All ticked by default.
    - **Planned date:** "Hide after today + [n] days", a tick box and a number. Off by default; n defaults to 14.
  - **Select** button (moved from above the board).
- **Filter settings are per device** (stored in the browser), like the list filter today.
- **Right-click a card** (long-press on a phone) for a menu: Open; Priority ▸ (the five levels, current one marked); Move to ▸ (the five columns); Pin to Today / Unpin; Delete… (asks for confirmation, as the detail panel does).
- **Phone:** the sidebar becomes a drawer opened by a ☰ button in the board header; the column switcher stays.

## Non-goals

- Sorting by priority.
- Priority in Google Tasks (it won't show there or on Google Home).
- A configurable Done window. Done stays at 7 days.
- Filters on the Today view. Today shows what's planned for today and pinned, regardless of filters.
- Right-click on Today rows or steps.

## Anti-goals

- Priorities set on one device wiped by another device's sync.
- A hidden card being moved, reordered or bulk-selected because of an action on visible cards.
- The sidebar or drawer making the board harder to use on a phone.

## Constraints

- **Rollout:** the current app rebuilds each board entry from known fields only (`parseEntry`, `serialiseBoard` in `src/domain/board.ts`), so a device still running the old version would drop `priority` when it next writes the board file. From this change on, parsing and serialising must keep fields they don't recognise, so a future field never hits this again. The old version is replaced on each device's next launch (service worker auto-update). Andy's decision: accept this window with no extra guard (single user, app used on one device so far); after release, open the app once on every device before setting priorities.
- **Priority edits** follow the board's existing rule: newest `updatedAt` wins per entry. Setting a priority stamps `updatedAt`.
- No new dependencies.

## Approaches

- **A. Priority in the board file in Drive (chosen).** An optional `priority` on each board entry; merges and syncs like column, order and pin. Reuses tested sync code; no change in Google Tasks.
- B. A tag in each task's notes in Google. Rejected: clutters notes, clashes with edits made in Google, and stray text edits change the priority silently.
- C. A separate priorities file in Drive. Rejected: a second file to read, merge and keep consistent for no gain beyond avoiding the one-off rollout window.

## Decisions

- **Filters apply to the board only** and combine with the list filter: a card shows when its list is shown AND its priority is ticked AND (the planned-date filter is off, OR it has no planned date, OR its planned date is on or before today + n). Done cards ignore the planned-date filter.
- Cards hidden by any filter are excluded from **Select all** and dropped from a selection, as list-hidden cards already are.
- **Column counts** in headings and the phone switcher count visible cards only.
- The **Filter button's count** is the number of filter groups not at their default (priorities with any unticked level; planned-date filter on).
- **Right-click** uses the browser's `contextmenu` event; on touch, a long-press opens the same menu and must not start a drag (drag already waits 300 ms on touch; the menu opens on contextmenu, which touch browsers fire on long-press). The menu closes on Escape, a click elsewhere, scrolling, or choosing an item, and is keyboard-operable (arrow keys, Enter). Opening it from the keyboard: the context-menu key or Shift+F10 on a focused card.
- **Delete from the menu** uses the same confirmation and edit as the detail panel.
- **Sidebar on desktop** is always visible at a fixed narrow width; the board takes the rest.

## Builder's calls (from the design review)

- **Stored value:** `priority` is a lowercase string, `"highest" | "high" | "medium" | "low" | "lowest"`. Medium is stored as an absent field, so existing entries and the file stay unchanged until a priority is set. Any other value reads as Medium.
- **Unknown fields:** kept per entry only (not top-level file fields). `BoardEntry` gains an `extra?: Record<string, unknown>` bag holding unrecognised fields; parse fills it, serialise writes it back after the known fields, and the IndexedDB mirror stores entries whole, so it survives the round trip. Entry-building code that spreads `...entry` carries it along.
- **Merge:** stays per entry, newest `updatedAt` wins. A move on one device and a priority change on another at nearly the same time can lose one of them; accepted, as for moves today. Priority survives Done and reopen.
- **Planned-date filter:** "today" is the device's local calendar date (`localDate`); compare `YYYY-MM-DD` strings; a card planned exactly on today + n is shown; overdue cards are shown. No midnight timer; the next render picks up the new day.
- **Priority tick boxes:** any combination is allowed, including none (Andy's call). With none ticked, the board shows a short line, "Every priority is hidden by the filter", so an empty board explains itself. The Filter count shows 1 for the priority group when any level is unticked, and 1 for the date filter when it's on.
- **Storage:** new keys `todo.priorities` and `todo.planned` beside the existing `todo.filter` (list filter, unchanged). The number field accepts whole days 1–365; anything else snaps back to the last valid value.
- **Where the logic lives:** a pure `cardVisible(card, filters, today)` in `src/domain/` used by `buildBoard`; `buildBoard` takes the combined filters (its signature changes; existing tests updated).
- **Drag on a filtered board:** as today, the card lands right after the visible card it's dropped under; hidden cards keep their order. Bulk moves only touch visible selected cards.
- **Right-click menu:** acts on the clicked card only, and is off in Select mode (a click there selects). On Done cards it shows Open, Priority, Move to (moving out reopens, as dragging does) and Delete; Pin is hidden there. Move to lists all five columns with the current one marked and disabled. Long-press opens the menu and does not start a drag; the card stays draggable afterwards.
- **Today:** no sidebar and no filters. Opening a card from Today shows the priority select in its detail panel; Today rows don't show markers.
- **Phone:** the sidebar is a drawer from the left, opened by a ☰ button at the start of the board's top row (left of the column switcher), only on the board. Lists, Filter and Select are inside it. The drawer closes when Select is turned on, so the cards are tappable; it stays open while ticking lists. The selection bar shows whenever Select mode is on, as now.
- **Markers:** text glyphs (▲▲ ▲ ▼ ▼▼) with `role="img"` and an `aria-label` of "Priority: High" and so on.

## Testing

- Board file: an entry with `priority` round-trips; an entry with an unknown field keeps it through parse → merge → serialise; an invalid priority value is dropped back to Medium rather than rejecting the entry.
- Merge: a newer priority change on one device wins over an older one from another.
- Filter: the visibility rule above, including no planned date, the boundary day (today + n is shown), Done ignoring the date filter, and the combination with the list filter.
- Bulk select excludes cards hidden by priority or date.
- Setting priority from the menu and the detail panel queues nothing for Google (board metadata only).
- Sidebar, drawer, dropdown, right-click and long-press are checked by hand on desktop and at phone width.

## Left to the builder

- Exact colours, spacing and icons beyond the markers above.
- Whether the dropdown applies changes immediately or with an Apply button (immediately is fine).
- The drawer's open/close animation.
