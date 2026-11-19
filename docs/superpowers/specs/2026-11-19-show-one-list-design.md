# Show one list

A small change to the sidebar's list filter.

## Why

To work through one list for a while without unticking every other list by hand, across both accounts, and then get back to every list in one step.

## Behaviour

- **Tickbox** works as it does now: it adds the list to the filter or takes it out.
- **List name** becomes a button. Clicking it shows only that list.
- Clicking the name of the list that is already the only one shown goes back to all lists.
- When the board shows only some of the lists, a **Show all** button appears beside the "Lists" heading.
- The priority and planned-date filters are left alone. Today follows the list filter as it does now.
- This works offline, in the phone drawer and on desktop. It is stored per device in `todo.filter`, as now.

## Approaches considered

- **Click the name to show only that list, and the tickbox to toggle it (chosen, Andy's suggestion).** It adds nothing to the row and is easy to find. It works on touch and offline.
- **A separate "Only" button on each row.** It is easy to find, but it adds clutter that the name button makes unnecessary.
- **"Show only this list" in the right-click menu.** That menu is turned off offline (Rename and Delete need Google), and iPhone Safari never opens it, so the option would be out of reach on the phone.

## Calls made (open to correction)

- Clicking the already-shown list again restores all lists, so the same control works both ways.
- Show all appears whenever the list filter is narrowed, not only when it is down to one list.
- If there is only one list in total, showing only it is the same as showing all, so the filter stays at "all" (`null`).
- The name button gets an accessible label such as "Show only Work". The right-click menu stays on the row. The tickbox needs a tap target big enough to use on a phone, now that tapping the name no longer ticks it.

## For the builder

- Add a pure `showOnlyList(current, id, allIds)` beside `toggleListFilter` in `src/domain/filters.ts`. It returns `new Set([id])`, or `null` when that list is already the only one shown or is the only list there is. Give it a test for each of those cases.
- The UI change goes in `src/ui/Sidebar.tsx`, where the row's `<label>` is split into a tickbox and a name button. Check by hand in the browser, including the phone drawer.
