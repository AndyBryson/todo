import { useEffect, useRef, useState } from 'preact/hooks';
import { activeFilterCount, type BoardFilters } from '../domain/filters';
import { PRIORITIES, type Priority } from '../domain/types';
import { MARKERS } from './Card';

const NAMES: Record<Priority, string> = {
  highest: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  lowest: 'Lowest',
};

const validDays = (text: string): number | null => {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 365 ? n : null;
};

interface Props {
  filters: BoardFilters;
  onFilters(next: BoardFilters): void;
}

export function FilterMenu({ filters, onFilters }: Props) {
  const [open, setOpen] = useState(false);
  // Typing passes through invalid text (empty, "0"), so the filter only sees valid days.
  const [draft, setDraft] = useState(String(filters.planned.days));
  const wrap = useRef<HTMLDivElement>(null);
  const count = activeFilterCount(filters);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Stops the drawer's dialog treating the same key as its own close.
      e.preventDefault();
      setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrap.current?.contains(e.target)) setOpen(false);
    };
    addEventListener('keydown', onKey);
    addEventListener('pointerdown', onPointer);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  function toggleOpen() {
    if (!open) setDraft(String(filters.planned.days));
    setOpen(!open);
  }

  function togglePriority(p: Priority) {
    const next = new Set(filters.priorities);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    onFilters({ ...filters, priorities: next });
  }

  function typeDays(text: string) {
    setDraft(text);
    const days = validDays(text);
    if (days !== null) onFilters({ ...filters, planned: { ...filters.planned, days } });
  }

  return (
    <div class="filter-wrap" ref={wrap}>
      <button type="button" aria-expanded={open} onClick={toggleOpen}>
        {count > 0 ? `Filter (${count})` : 'Filter'} ▾
      </button>
      {open && (
        <div class="filter-menu">
          <fieldset>
            <legend>Priorities to show</legend>
            {PRIORITIES.map((p) => (
              <label key={p} class="check">
                <input
                  type="checkbox"
                  checked={filters.priorities.has(p)}
                  onChange={() => togglePriority(p)}
                />
                {NAMES[p]}
                {p !== 'medium' && (
                  <span class={`priority priority-${MARKERS[p].tone}`} aria-hidden="true">
                    {MARKERS[p].glyph}
                  </span>
                )}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Planned date</legend>
            <div class="planned-row">
              <label class="check">
                <input
                  type="checkbox"
                  checked={filters.planned.on}
                  onChange={() =>
                    onFilters({
                      ...filters,
                      planned: { ...filters.planned, on: !filters.planned.on },
                    })
                  }
                />
                Hide after today +
              </label>
              <input
                class="days"
                type="text"
                inputMode="numeric"
                aria-label="Days"
                value={draft}
                onInput={(e) => typeDays(e.currentTarget.value)}
                onBlur={() => setDraft(String(filters.planned.days))}
              />
              <span>days</span>
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
