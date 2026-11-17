import { useState } from 'preact/hooks';
import { COLUMNS, type Column } from '../domain/types';

interface Props {
  count: number;
  busy: boolean;
  onMove(column: Column): void;
  onCancel(): void;
}

// Choosing a column only picks it; the Move button commits. A select fires `change`
// on arrow keys in some browsers, which must not move cards by itself.
export function SelectionBar({ count, busy, onMove, onCancel }: Props) {
  const [target, setTarget] = useState<Column | ''>('');
  return (
    <section class="selection-bar" aria-label="Selected cards">
      <span class="selection-count" aria-live="polite">
        {count} selected
      </span>
      <label class="selection-move">
        Move to{' '}
        <select
          value={target}
          onChange={(e) => setTarget(COLUMNS.find((c) => c === e.currentTarget.value) ?? '')}
        >
          <option value="" disabled>
            Column…
          </option>
          {COLUMNS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={busy || count === 0 || target === ''}
        onClick={() => target && onMove(target)}
      >
        Move
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}
