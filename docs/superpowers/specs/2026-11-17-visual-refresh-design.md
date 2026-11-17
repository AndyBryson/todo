# Visual refresh ("colourful lanes"): design

Status: draft for approval. Date: 2026-11-17.

## Intent

On a PC the app looks dated: small text on a flat grey page, thin cards, columns with no shape, plain header, browser-default inputs. Andy picked mockup C, "colourful lanes", without its gradient. The phone already looks fine and should follow the same style rather than drift apart.

## Goals

- **Top bar:** solid indigo `#3b5bdb`, white text; Board / Today as pills (active pill on a translucent white background); sync status on the right.
- **Page:** soft blue-grey background `#f2f4f8`.
- **Columns:** white panels with rounded corners (12 px) and a light shadow; a coloured header bar with the column name and count in white:
  - Backlog `#868e96`, Next `#4c6ef5`, Doing `#f08c00`, Waiting `#ae3ec9`, Done `#2f9e44`.
- **Cards:** white, rounded (8 px), thin border, a 4 px left edge in the **list's colour** (replacing the chip dot on the board); meta line below the title with list name, planned date, step count, priority marker and pin.
- **Sidebar:** white panel; lists as soft-tinted rows in their own colour; Filter and Select as pale-indigo buttons (`#edf0ff` on `#3b5bdb`).
- **Consistency:** card detail panel, Filter menu, right-click menu, selection bar, quick add, Today rows, notices and the phone drawer use the same radius, colours, shadows and button style. Native selects, text inputs, date inputs and tick boxes are styled to match.
- **Phone:** same palette and cards; the column switcher's pills take each column's colour (selected pill filled, others outlined).
- **Dark mode:** kept, following the system setting. Dark panels and page, the same column and list colours slightly muted so white header text still reads, and the light theme is the primary design.

## Non-goals

- Changing layout, behaviour, copy or features.
- A theme switcher in the app.
- A new font download (system font stack stays; size and weight change).

## Anti-goals

- Text or markers that fail contrast (column header text on its colour, muted text, priority markers) in either theme.
- Anything that breaks drag and drop, the right-click menu, selection or the drawer.
- The phone looking worse than today.

## Approaches

- **Restyle the existing stylesheet (chosen):** expand the colour variables in `src/ui/app.css` into a full set (surfaces, borders, five column colours, accent, shadows, radius) for light and dark, rework component styles, and make small markup changes (column header colour, card edge, top-bar pills).
- A CSS framework or component library: rejected; rewrites every component's markup and breaks the few-dependencies rule.
- Desktop-only restyle: rejected; the phone and PC would drift apart.

## Decisions

- **List colour edge:** the card's left edge uses the existing `listColour(list.id)`, set as a CSS custom property on the card; the list name stays as text in the meta line.
- **Column colour:** set per column as a CSS custom property from a small map in the UI, keyed by column name.
- **Contrast:** every text-on-colour pair (white on each column header in both themes) must reach 4.5:1 for the header's normal-size text, or the builder darkens that header colour slightly and records the value.
- **Text size:** card titles 14 px, meta 12 px, column headers 12–13 px bold; base 14 px on desktop.

## Testing

- No automated tests (styling only; the project doesn't test rendering). `npm run check` and `npm run build` must pass.
- Checked by eye in the browser with `?fake`: desktop at 1440 px (sidebar open and closed), 375 px phone (board, switcher, drawer, Add sheet), the card detail panel, Filter and right-click menus, selection bar, Today, empty-board line; each in light and dark.
- Drag between columns, right-click menu and selection still work after the restyle.

## Left to the builder

- Exact shadows, spacing and the muted dark-mode shades, within the contrast rule.
- Hover and focus styles (visible focus rings required).
