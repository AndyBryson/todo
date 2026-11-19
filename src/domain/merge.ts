import type { Notice, Snapshot } from '../store/db';
import type { SyncStatus } from '../sync/engine';
import type { BoardEntries, Task, TaskList } from './types';

export interface AccountView {
  id: string;
  label: string;
  snapshot: Snapshot;
}

export interface Merged {
  lists: TaskList[];
  tasks: Task[];
  entries: BoardEntries;
  listAccount: Record<string, string>;
  taskAccount: Record<string, string>;
  listName: Record<string, string>;
  notices: (Notice & { accountId: string })[];
  queueLength: number;
  // Temporary IDs are unique across accounts, so one map serves every open screen.
  renamed: Record<string, string>;
}

// Google IDs are unique across accounts, so views concatenate without renaming.
export function mergeViews(views: AccountView[]): Merged {
  const merged: Merged = {
    lists: [],
    tasks: [],
    entries: {},
    listAccount: {},
    taskAccount: {},
    listName: {},
    notices: [],
    queueLength: 0,
    renamed: {},
  };

  const titleAccounts = new Map<string, Set<string>>();
  for (const v of views) {
    for (const l of v.snapshot.lists) {
      const set = titleAccounts.get(l.title) ?? new Set<string>();
      set.add(v.id);
      titleAccounts.set(l.title, set);
    }
  }

  for (const v of views) {
    const s = v.snapshot;
    // A task being moved to another account stays in this mirror until the target
    // has it, so it must not show twice; its steps and entry go with it.
    const gone = new Set(Object.keys(s.hidden));
    for (const l of s.lists) {
      merged.lists.push(l);
      merged.listAccount[l.id] = v.id;
      const clash = (titleAccounts.get(l.title)?.size ?? 0) > 1;
      merged.listName[l.id] = clash ? `${l.title} · ${v.label}` : l.title;
    }
    for (const t of s.tasks) {
      if (gone.has(t.id) || (t.parent !== null && gone.has(t.parent))) continue;
      merged.tasks.push(t);
      merged.taskAccount[t.id] = v.id;
    }
    for (const [id, e] of Object.entries(s.entries)) {
      if (!gone.has(id)) merged.entries[id] = e;
    }
    for (const n of s.notices) merged.notices.push({ ...n, accountId: v.id });
    merged.queueLength += s.queueLength;
    Object.assign(merged.renamed, s.renamed);
  }
  return merged;
}

export function combineStatus(views: { label: string; status: SyncStatus }[]): {
  status: SyncStatus;
  signIn: string[];
} {
  const signIn = views.filter((v) => v.status.kind === 'signin').map((v) => v.label);
  const rest = views.map((v) => v.status).filter((s) => s.kind !== 'signin');

  const error = rest.find((s) => s.kind === 'error');
  if (error) return { status: error, signIn };
  for (const kind of ['offline', 'syncing'] as const) {
    if (rest.some((s) => s.kind === kind)) return { status: { kind }, signIn };
  }
  if (rest.some((s) => s.kind === 'idle')) return { status: { kind: 'idle' }, signIn };

  const times = rest.flatMap((s) => (s.kind === 'synced' ? [s.at] : []));
  if (times.length === 0) return { status: { kind: 'idle' }, signIn };
  // ISO strings from one source sort chronologically; compare as dates in case formats differ.
  const oldest = times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
  return { status: { kind: 'synced', at: oldest }, signIn };
}
