import { COLUMNS, type Column } from '../domain/types';

interface Props {
  count: number;
  onMove(column: Column): void;
  onCancel(): void;
}

export function SelectionBar({ count, onMove, onCancel }: Props) {
  return (
    <section class="selection-bar" aria-label="Selected cards">
      <span class="selection-count" aria-live="polite">
        {count} selected
      </span>
      <label class="selection-move">
        Move to{' '}
        <select
          value=""
          disabled={count === 0}
          onChange={(e) => {
            const column = COLUMNS.find((c) => c === e.currentTarget.value);
            e.currentTarget.value = '';
            if (column) onMove(column);
          }}
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
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}
