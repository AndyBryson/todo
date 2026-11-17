import type { Task } from '../domain/types';
import {
  AuthError,
  type GoogleApi,
  NotFoundError,
  OfflineError,
  type TaskPatch,
} from '../google/api';
import {
  type Change,
  type Op,
  type QueuedOp,
  renameChange,
  type Snapshot,
  type Store,
} from '../store/db';

export type ReplayResult = 'done' | 'offline' | 'auth' | 'error';

const idOf = (op: Op) => (op.kind === 'create' ? op.tempId : op.taskId);

// Users keep editing while replay runs, so every local write below is built
// inside a commit callback from the latest state, never from a read made before
// the Google call.

export async function replay(google: GoogleApi, store: Store): Promise<ReplayResult> {
  try {
    await store.commit(dropUnsentCreates);
    for (;;) {
      const head = (await store.queue())[0];
      if (!head) return 'done';
      await run(google, store, head);
    }
  } catch (error) {
    if (error instanceof AuthError) return 'auth';
    if (error instanceof OfflineError) return 'offline';
    return 'error';
  }
}

// A task created and deleted before anything was sent never needs to exist in Google.
function dropUnsentCreates(s: Snapshot): Change {
  const doomed = new Set(
    s.queued
      .filter((q) => q.op.kind === 'delete')
      .map((q) => idOf(q.op))
      .filter((id) => s.queued.some((q) => q.op.kind === 'create' && q.op.tempId === id)),
  );
  return { dequeue: s.queued.filter((q) => doomed.has(idOf(q.op))).map((q) => q.seq) };
}

async function run(google: GoogleApi, store: Store, head: QueuedOp): Promise<void> {
  const { op, seq } = head;
  try {
    switch (op.kind) {
      case 'create': {
        const real = await google.insertTask(op.listId, op.task);
        await store.commit((s) => settle(s, seq, op.tempId, real));
        return;
      }
      case 'patch':
        return await runPatch(google, store, head, op);
      case 'delete':
        try {
          await google.deleteTask(op.listId, op.taskId);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
        await store.commit({ dequeue: [seq] });
        return;
      case 'move': {
        const moved = await google.moveTask(op.listId, op.taskId, op.toListId);
        await store.commit((s) => settle(s, seq, op.taskId, moved));
        return;
      }
    }
  } catch (error) {
    if (error instanceof NotFoundError) {
      const title = op.kind === 'create' ? op.task.title : '';
      await store.commit((s) => dropDeleted(s, idOf(op), title));
      return;
    }
    throw error;
  }
}

async function runPatch(
  google: GoogleApi,
  store: Store,
  head: QueuedOp,
  op: Extract<Op, { kind: 'patch' }>,
): Promise<void> {
  const remote = await google.getTask(op.listId, op.taskId);
  const send: TaskPatch = {};
  const conflicts: (keyof TaskPatch)[] = [];
  for (const key of Object.keys(op.set) as (keyof TaskPatch)[]) {
    const theirs = remote[key];
    if (theirs !== op.base[key] && theirs !== op.set[key]) conflicts.push(key);
    else (send as Record<string, unknown>)[key] = op.set[key];
  }
  const result =
    Object.keys(send).length > 0 ? await google.patchTask(op.listId, op.taskId, send) : remote;

  await store.commit((s) => {
    const notices = conflicts.map(
      (key) =>
        `“${remote.title}”: your change to ${key} wasn't applied because it was changed elsewhere. Your version: ${op.set[key] ?? 'none'}`,
    );
    const change = settle(s, head.seq, op.taskId, result);
    if (change.putTasks) return { ...change, notices };
    // Later local edits are still queued, so keep the local copy; but show Google's
    // value for fields where ours lost, unless a later edit has already replaced ours.
    const local = s.tasks.find((t) => t.id === op.taskId);
    if (!local || conflicts.length === 0) return { ...change, notices };
    const adopted: Record<string, unknown> = {};
    for (const key of conflicts) if (local[key] === op.set[key]) adopted[key] = result[key];
    return { ...change, putTasks: [{ ...local, ...adopted } as Task], notices };
  });
}

// Dequeues the finished op and renames the task if Google gave it a new ID. Google's
// copy replaces the mirror only when no other queued op targets the task, because
// otherwise the local copy already holds newer edits.
function settle(s: Snapshot, seq: number, localId: string, result: Task): Change {
  const renamed: Change = result.id === localId ? {} : renameChange(s, localId, result.id);
  const stillQueued = s.queued.some((q) => q.seq !== seq && idOf(q.op) === localId);
  const putTasks = [...(renamed.putTasks ?? [])];
  if (!stillQueued) putTasks.push(result);
  return { ...renamed, putTasks: putTasks.length ? putTasks : undefined, dequeue: [seq] };
}

function dropDeleted(s: Snapshot, taskId: string, fallbackTitle: string): Change {
  const family = s.tasks.filter((t) => t.id === taskId || t.parent === taskId).map((t) => t.id);
  const title = s.tasks.find((t) => t.id === taskId)?.title ?? fallbackTitle;
  return {
    dequeue: s.queued.filter((q) => idOf(q.op) === taskId).map((q) => q.seq),
    removeTasks: family,
    removeEntries: [taskId, ...family],
    notices: [`“${title}” was deleted elsewhere, so your change was dropped.`],
  };
}
