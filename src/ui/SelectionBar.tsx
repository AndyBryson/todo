import { useState } from 'preact/hooks';
import { COLUMNS, type Column } from '../domain/types';
import { WAITING } from './CardMenu';

export interface MoveTarget {
  id: string;
  label: string;
  lists: { id: string; name: string; waiting: boolean }[];
}

interface Props {
  count: number;
  busy: boolean;
  // Lists grouped under their account, for moving the selection to another list.
  targets: MoveTarget[];
  onMove(column: Column): void;
  onMoveToList(listId: string): void;
  onCancel(): void;
}

// Choosing a target only picks it; the Move button commits. A select fires `change`
// on arrow keys in some browsers, which must not move cards by itself.
export function SelectionBar({ count, busy, targets, onMove, onMoveToList, onCancel }: Props) {
  const [target, setTarget] = useState('');
  const column = COLUMNS.find((c) => `column:${c}` === target);
  const listId = target.startsWith('list:') ? target.slice('list:'.length) : null;
  // The selection can change after a pick, making that list wait for changes to send.
  const blocked = targets.some((g) => g.lists.some((l) => l.id === listId && l.waiting));
  return (
    <section class="selection-bar" aria-label="Selected cards">
      <span class="selection-count" aria-live="polite">
        {count} selected
      </span>
      <label class="selection-move">
        Move to{' '}
        <select value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
          <option value="" disabled>
            Column or list…
          </option>
          <optgroup label="Column">
            {COLUMNS.map((c) => (
              <option key={c} value={`column:${c}`}>
                {c}
              </option>
            ))}
          </optgroup>
          {targets.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.lists.map((l) => (
                <option key={l.id} value={`list:${l.id}`} disabled={l.waiting}>
                  {l.waiting ? `${l.name}: ${WAITING}` : l.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={busy || count === 0 || (!column && !listId) || blocked}
        onClick={() => {
          if (column) onMove(column);
          else if (listId) onMoveToList(listId);
        }}
      >
        Move
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}
