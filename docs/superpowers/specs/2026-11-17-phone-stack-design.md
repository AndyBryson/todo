# Phone "Stack" view: design

Status: approved. Date: 2026-11-17.

## Intent

On a phone the board shows one column at a time. Andy wants an optional overview with Doing, Next and Backlog stacked on one scrolling page, so he can see what's in progress and what's next together and drag cards between them.

## Decisions (approved)

- The phone switcher gets a **Stack** button, first in the row, before Backlog, Next, Doing and Done.
- Stack shows **Doing, then Next, then Backlog**, stacked vertically at full length, each with its coloured header and count. Done is left out.
- The whole page scrolls; nothing collapses.
- Cards drag between the three sections as they do between columns on the desktop. An empty section keeps a small strip to drop into.
- The choice is remembered per device like the column buttons (`todo.column`).
- Add (bottom bar), Select (including select-all per section header) and the card menu work unchanged.
- Desktop is unchanged.

## Approaches

- **Render the existing columns stacked (chosen).** The columns already share one drag group, so stacking three of them gives cross-section drag for free.
- A new merged list with section dividers: rejected; it would need its own drag and ranking code.

## Left to the builder

- The empty-strip height, the spacing between sections, and the Stack button's colour (a neutral one, since it isn't a column).
