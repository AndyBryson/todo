import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { COLUMNS, type Column } from '../domain/types';
import type { Snapshot, Store } from '../store/db';
import {
  deleteTask,
  editTask,
  moveCardToBottom,
  moveToList,
  setCompleted,
  setPinned,
} from '../store/edits';
import { Checklist } from './Checklist';
import { useIsPhone } from './hooks';

export type DetailView = 'board' | 'today';

// Only history the app made can be walked back; a shared or reloaded link has nothing behind it.
let navigatedHere = false;

export function openDetail(view: DetailView, id: string) {
  navigatedHere = true;
  location.hash = `#/${view}/task/${id}`;
}

export function closeDetail(view: DetailView) {
  if (navigatedHere) {
    navigatedHere = false;
    history.back();
  } else {
    location.hash = `#/${view}`;
  }
}

interface Props {
  taskId: string;
  view: DetailView;
  store: Store;
  error: string | null;
  snapshot: Snapshot;
  act(fn: () => Promise<unknown>): Promise<boolean>;
  onClose(): void;
}

interface FieldProps {
  label?: string;
  // Names the field when it sits inline without a visible label.
  ariaLabel?: string;
  saved: string;
  multiline?: boolean;
  onSave(value: string): void;
}

// The draft exists only while focused, so a background sync cannot overwrite typing.
export function DraftField({ label, ariaLabel, saved, multiline, onSave }: FieldProps) {
  const id = useId();
  const [draft, setDraftState] = useState<string | null>(null);
  // Refs let the unmount cleanup see the latest values; blur and cleanup share one flush.
  const draftRef = useRef<string | null>(null);
  const latest = useRef({ saved, onSave });
  latest.current = { saved, onSave };
  const setDraft = (value: string | null) => {
    draftRef.current = value;
    setDraftState(value);
  };
  const flush = () => {
    const pending = draftRef.current;
    draftRef.current = null;
    if (pending !== null && pending !== latest.current.saved) latest.current.onSave(pending);
  };
  // Back can unmount the panel without a blur, so save what is still being typed.
  useEffect(() => flush, []);

  const shared = {
    id,
    'aria-label': ariaLabel,
    value: draft ?? saved,
    onFocus: () => setDraft(saved),
    onInput: (e: Event) => setDraft((e.target as HTMLInputElement | HTMLTextAreaElement).value),
    onBlur: () => {
      flush();
      setDraftState(null);
    },
  };
  return (
    <div class="field">
      {label && <label for={id}>{label}</label>}
      {multiline ? <textarea rows={6} {...shared} /> : <input type="text" {...shared} />}
    </div>
  );
}

export function CardDetail({ taskId, view, store, error, snapshot, act, onClose }: Props) {
  const phone = useIsPhone();
  const dialog = useRef<HTMLDialogElement>(null);
  const latestId = useRef(taskId);
  latestId.current = taskId;
  const [deleted, setDeleted] = useState(false);

  const task = deleted ? undefined : snapshot.tasks.find((t) => t.id === taskId);
  const renamedTo = Object.hasOwn(snapshot.renamed, taskId) ? snapshot.renamed[taskId] : undefined;

  useEffect(() => {
    if (renamedTo && !task) {
      const hash = location.hash;
      location.replace(`${hash.slice(0, hash.lastIndexOf('/') + 1)}${renamedTo}`);
    }
  }, [renamedTo, task]);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  });

  useEffect(() => {
    return () => {
      const card = document.querySelector<HTMLElement>(`[data-id="${latestId.current}"] button`);
      card?.focus();
    };
  }, []);

  // Escape or Back with a field focused must still save what was typed.
  const close = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && dialog.current?.contains(active)) active.blur();
    onClose();
  };

  // One dialog element for every state, so it stays open across a rename or a deletion.
  const shell = (children: ComponentChildren) => (
    <dialog
      ref={dialog}
      class={phone ? 'detail phone' : 'detail'}
      aria-label="Task details"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div class="detail-body">
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        {children}
      </div>
    </dialog>
  );

  if (!task) {
    if (renamedTo || deleted) return shell(null);
    return shell(
      <>
        <p>This task no longer exists.</p>
        <a
          href={`#/${view}`}
          onClick={(e) => {
            e.preventDefault();
            close();
          }}
        >
          Back
        </a>
      </>,
    );
  }

  const entry = snapshot.entries[task.id];

  const changeColumn = (column: Column) =>
    void act(() => moveCardToBottom(store, task.id, column, new Date().toISOString()));

  const remove = async () => {
    if (!confirm(`Delete “${task.title}” from Google Tasks?`)) return;
    if (await act(() => deleteTask(store, task.id))) {
      setDeleted(true);
      onClose();
    }
  };

  return shell(
    <>
      <button type="button" class="detail-close" onClick={close}>
        Close
      </button>

      <DraftField
        label="Title"
        saved={task.title}
        onSave={(title) => {
          // A blank title is rejected, so it reverts to the saved one.
          if (title.trim()) void act(() => editTask(store, task.id, { title }));
        }}
      />
      <DraftField
        label="Notes"
        saved={task.notes}
        multiline
        onSave={(notes) => void act(() => editTask(store, task.id, { notes }))}
      />

      <div class="field">
        <label for="detail-due">Planned date</label>
        <div class="row">
          <input
            id="detail-due"
            type="date"
            value={task.due ?? ''}
            onChange={(e) => {
              const due = e.currentTarget.value || null;
              void act(() => editTask(store, task.id, { due }));
            }}
          />
          <button
            type="button"
            disabled={task.due === null}
            onClick={() => void act(() => editTask(store, task.id, { due: null }))}
          >
            Clear
          </button>
        </div>
      </div>

      {task.parent === null && (
        <label class="field">
          <span>List</span>
          <select
            value={task.listId}
            onChange={(e) => {
              const listId = e.currentTarget.value;
              void act(() => moveToList(store, task.id, listId));
            }}
          >
            {snapshot.lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </label>
      )}

      {entry && (
        <label class="field">
          <span>Column</span>
          <select
            value={entry.column}
            onChange={(e) => changeColumn(e.currentTarget.value as Column)}
          >
            {COLUMNS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}

      {entry && (
        <label class="check">
          <input
            type="checkbox"
            checked={entry.pinned}
            onChange={(e) => {
              const pinned = e.currentTarget.checked;
              void act(() => setPinned(store, task.id, pinned, new Date().toISOString()));
            }}
          />
          Pinned to Today
        </label>
      )}

      <label class="check">
        <input
          type="checkbox"
          checked={task.completed}
          onChange={(e) => {
            const completed = e.currentTarget.checked;
            void act(() => setCompleted(store, task.id, completed, new Date().toISOString()));
          }}
        />
        Completed
      </label>

      {task.parent === null && (
        <Checklist parent={task} snapshot={snapshot} store={store} act={act} />
      )}

      <button type="button" class="danger" onClick={() => void remove()}>
        Delete
      </button>
    </>,
  );
}
