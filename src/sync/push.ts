import { subtasksOf } from '../domain/subtasks';
import type { Task } from '../domain/types';
import {
  AuthError,
  type GoogleApi,
  HttpError,
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

export interface ReplayHooks {
  // Runs once every create queued before the op has reached Google.
  handoff(op: Extract<Op, { kind: 'handoff' }>): Promise<void>;
}

// Steps completed long ago still belong to the original, so they count in its fingerprint.
const EPOCH = '1970-01-01T00:00:00.000Z';

const idOf = (op: Op) => (op.kind === 'create' ? op.tempId : op.taskId);

// Users keep editing while replay runs, so every local write below is built
// inside a commit callback from the latest state, never from a read made before
// the Google call.

export async function replay(
  google: GoogleApi,
  store: Store,
  hooks?: ReplayHooks,
): Promise<ReplayResult> {
  try {
    await store.commit(dropUnsentCreates);
    for (;;) {
      const head = store.snapshot().queued[0];
      if (!head) return 'done';
      await run(google, store, head, hooks);
    }
  } catch (error) {
    if (error instanceof AuthError) return 'auth';
    if (error instanceof OfflineError) return 'offline';
    return 'error';
  }
}

// A task created and deleted before anything was sent never needs to exist in Google,
// and nor does a step created under a task that is being deleted. A create already
// attempted may have reached Google, so it replays and the delete follows.
function dropUnsentCreates(s: Snapshot): Change {
  const deleted = new Set(s.queued.flatMap((q) => (q.op.kind === 'delete' ? [q.op.taskId] : [])));
  const doomed = new Set(
    s.queued.flatMap((q) =>
      q.op.kind === 'create' &&
      !q.op.attemptedAt &&
      (deleted.has(q.op.tempId) ||
        (q.op.task.parent !== undefined && deleted.has(q.op.task.parent)))
        ? [q.op.tempId]
        : [],
    ),
  );
  return dropOps(s, doomed);
}

// Dequeues every op of a task that will never exist in Google, or that names one as
// its parent, and points ops naming one as `previous` somewhere that will exist.
function dropOps(s: Snapshot, gone: Set<string>): Pick<Change, 'dequeue' | 'requeue'> {
  const dropped = s.queued.filter(
    (q) =>
      gone.has(idOf(q.op)) ||
      (q.op.kind === 'create' && q.op.task.parent !== undefined && gone.has(q.op.task.parent)) ||
      (q.op.kind === 'reorder' && gone.has(q.op.parent)),
  );
  const droppedSeqs = new Set([...dropped.map((q) => q.seq), ...handoffsOf(s, dropped)]);
  const requeue = s.queued.flatMap((q): QueuedOp[] => {
    if (droppedSeqs.has(q.seq)) return [];
    const { op } = q;
    if (op.kind === 'create' && op.task.parent && op.task.previous && gone.has(op.task.previous)) {
      const previous = fallbackPrevious(s, q, op.task.parent, op.task.previous, gone);
      return [{ seq: q.seq, op: { ...op, task: { ...op.task, previous: previous ?? undefined } } }];
    }
    if (op.kind === 'reorder' && op.previous !== null && gone.has(op.previous)) {
      return [
        {
          seq: q.seq,
          op: { ...op, previous: fallbackPrevious(s, q, op.parent, op.previous, gone) },
        },
      ];
    }
    return [];
  });
  return { dequeue: [...droppedSeqs], requeue };
}

// The handoff is all that lets the other account delete the original, so a copy that
// lost any op for itself or one of its steps must never reach it.
function handoffsOf(s: Snapshot, dropped: QueuedOp[]): number[] {
  const touched = new Set(
    dropped.flatMap(({ op }) => {
      const id = idOf(op);
      const parent =
        op.kind === 'create'
          ? op.task.parent
          : op.kind === 'reorder'
            ? op.parent
            : s.tasks.find((t) => t.id === id)?.parent;
      return parent ? [id, parent] : [id];
    }),
  );
  return s.queued.flatMap((q) =>
    q.op.kind === 'handoff' && touched.has(q.op.taskId) ? [q.seq] : [],
  );
}

// The nearest sibling before goneId in the local order that is still expected to exist
// in Google by the time q runs.
function fallbackPrevious(
  s: Snapshot,
  q: QueuedOp,
  parent: string,
  goneId: string,
  gone: Set<string>,
): string | null {
  const self = idOf(q.op);
  const createdLater = new Set(
    s.queued.flatMap((o) => (o.seq >= q.seq && o.op.kind === 'create' ? [o.op.tempId] : [])),
  );
  return (
    siblingsBefore(s, parent, goneId, self).find((id) => !gone.has(id) && !createdLater.has(id)) ??
    null
  );
}

// Siblings before `missing` in the local order, nearest first. When `missing` has
// already left the mirror, the op's own task marks the place instead.
function siblingsBefore(
  s: Snapshot,
  parent: string,
  missing: string | null,
  self: string,
): string[] {
  const order = subtasksOf(s.tasks, parent).map((t) => t.id);
  const at =
    missing !== null && order.includes(missing) ? order.indexOf(missing) : order.indexOf(self);
  return order
    .slice(0, Math.max(at, 0))
    .reverse()
    .filter((id) => id !== self);
}

async function run(
  google: GoogleApi,
  store: Store,
  head: QueuedOp,
  hooks?: ReplayHooks,
): Promise<void> {
  const { op, seq } = head;
  try {
    switch (op.kind) {
      case 'create': {
        const real = await createInGoogle(google, store, head, op);
        if (real) await store.commit((s) => settle(s, seq, op.tempId, real));
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
        try {
          const moved = await google.moveTask(op.listId, op.taskId, op.toListId);
          await store.commit((s) => settle(s, seq, op.taskId, moved));
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          await resolveMissingMove(google, store, head, op);
        }
        return;
      }
      case 'reorder':
        return await runReorder(google, store, head, op);
      case 'handoff':
        // Without hooks (tests and fake mode) there is no other account to tell.
        await hooks?.handoff(op);
        await store.commit({ dequeue: [seq] });
        return;
      case 'transferDelete':
        return await runTransferDelete(google, store, head, op);
      default:
        return assertNever(op);
    }
  } catch (error) {
    // The hook's failure says nothing about the copy, so it must not be dropped as deleted.
    if (op.kind === 'handoff') throw error;
    if (error instanceof NotFoundError) {
      // Inserting can only miss on the list, so the list is what went.
      const notice =
        op.kind === 'create'
          ? `“${op.task.title}” couldn't be added because its list no longer exists.`
          : undefined;
      await store.commit((s) => dropDeleted(s, idOf(op), notice));
      return;
    }
    if (isPermanentRefusal(error)) {
      const status = error.status;
      await store.commit((s) => dropRefused(s, head, status));
      return;
    }
    throw error;
  }
}

// A new op kind without a case here would leave the head queued and spin replay forever.
function assertNever(op: never): never {
  throw new Error(`Unknown op ${JSON.stringify(op)}`);
}

// A reorder misses when the step or the sibling it follows was deleted elsewhere.
// A missing parent takes the step with it, so that case is covered by the first.
async function runReorder(
  google: GoogleApi,
  store: Store,
  head: QueuedOp,
  op: Extract<Op, { kind: 'reorder' }>,
): Promise<void> {
  let result: Task;
  try {
    result = await google.reorderTask(op.listId, op.taskId, op.parent, op.previous);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    if (!(await findTask(google, op.listId, op.taskId))) {
      await store.commit((s) => dropDeleted(s, op.taskId));
      return;
    }
    const previous = await survivingPrevious(
      google,
      store,
      op.listId,
      op.parent,
      op.previous,
      op.taskId,
    );
    try {
      result = await google.reorderTask(op.listId, op.taskId, op.parent, previous);
    } catch (retryError) {
      if (!(retryError instanceof NotFoundError)) throw retryError;
      await store.commit((s) => dropDeleted(s, op.taskId));
      return;
    }
  }
  await store.commit((s) => settle(s, head.seq, op.taskId, result));
}

async function findTask(google: GoogleApi, listId: string, taskId: string): Promise<Task | null> {
  try {
    return await google.getTask(listId, taskId);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

// The nearest sibling before `missing` in the local order that Google still has under
// parent, or null for first. Steps still waiting to be created are not in Google yet.
async function survivingPrevious(
  google: GoogleApi,
  store: Store,
  listId: string,
  parent: string,
  missing: string | null,
  self: string,
): Promise<string | null> {
  const s = store.snapshot();
  const unsent = new Set(s.queued.flatMap((q) => (q.op.kind === 'create' ? [q.op.tempId] : [])));
  for (const id of siblingsBefore(s, parent, missing, self)) {
    if (unsent.has(id)) continue;
    if ((await findTask(google, listId, id))?.parent === parent) return id;
  }
  return null;
}

// A 4xx other than auth, not-found, timeout or rate limit will never succeed on
// retry, so leaving it at the head would block every later edit and pull. Google
// reports rate limits as 403 as well as 429.
function isPermanentRefusal(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 404, 408, 429].includes(error.status)
  );
}

function dropRefused(s: Snapshot, head: QueuedOp, status: number): Change {
  const id = idOf(head.op);
  const title =
    s.tasks.find((t) => t.id === id)?.title ||
    (head.op.kind === 'create' ? head.op.task.title : '') ||
    'A task';
  // A refused create never exists in Google, so its steps' ops go with it.
  const dropped =
    head.op.kind === 'create'
      ? dropOps(s, new Set([id]))
      : s.queued.some((q) => q.seq === head.seq)
        ? { dequeue: [head.seq, ...handoffsOf(s, [head])] }
        : { dequeue: [] };
  return {
    ...dropped,
    ...(head.op.kind === 'transferDelete' && { meta: { hidden: unhide(s, head.op.taskId) } }),
    notices: [`Google refused a change to “${title}” (error ${status}), so it was dropped.`],
  };
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
    if (theirs === op.set[key]) continue;
    if (theirs === op.base[key]) (send as Record<string, unknown>)[key] = op.set[key];
    else conflicts.push(key);
  }
  const result =
    Object.keys(send).length > 0 ? await google.patchTask(op.listId, op.taskId, send) : remote;

  await store.commit((s) => {
    const notices = conflicts.map(
      (key) =>
        `“${remote.title || 'A task'}”: your change to ${key} wasn't applied because it was changed elsewhere. Your version: ${op.set[key] ?? 'none'}`,
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
  // Local edits renumber every step, and Google's widely spaced position for this one
  // would sort it away from its siblings until the next pull.
  const local = s.tasks.find((t) => t.id === localId);
  if (!stillQueued) {
    putTasks.push(
      result.parent !== null && local ? { ...result, position: local.position } : result,
    );
  }
  return { ...renamed, putTasks: putTasks.length ? putTasks : undefined, dequeue: [seq] };
}

function dropDeleted(s: Snapshot, taskId: string, notice?: string): Change {
  const family = s.tasks.filter((t) => t.id === taskId || t.parent === taskId).map((t) => t.id);
  const title = s.tasks.find((t) => t.id === taskId)?.title || 'A task';
  return {
    ...dropOps(s, new Set([taskId, ...family])),
    removeTasks: family,
    removeEntries: [...new Set([taskId, ...family])],
    notices: [notice ?? `“${title}” was deleted elsewhere, so your change was dropped.`],
  };
}

// A lost response or crash after Google accepted the insert would otherwise create a
// duplicate on the next replay, so look for our own task before inserting again.
// Returns null when the step was dropped because its parent is gone.
async function createInGoogle(
  google: GoogleApi,
  store: Store,
  head: QueuedOp,
  op: Extract<Op, { kind: 'create' }>,
): Promise<Task | null> {
  if (op.attemptedAt) {
    const since = new Date(Date.parse(op.attemptedAt) - 60_000).toISOString();
    const known = new Set(store.snapshot().tasks.map((t) => t.id));
    const found = (await google.listTasks(op.listId, op.attemptedAt))
      .filter(
        (t) =>
          t.title === op.task.title &&
          t.parent === (op.task.parent ?? null) &&
          t.updated >= since &&
          !known.has(t.id),
      )
      .sort((a, b) => a.updated.localeCompare(b.updated))[0];
    if (found) return found;
  } else {
    const attemptedAt = new Date().toISOString();
    await store.commit((s) =>
      s.queued.some((q) => q.seq === head.seq)
        ? { requeue: [{ seq: head.seq, op: { ...op, attemptedAt } }] }
        : {},
    );
  }
  try {
    return await google.insertTask(op.listId, op.task);
  } catch (error) {
    if (!(error instanceof NotFoundError) || !op.task.parent) throw error;
    // A step's insert also misses on its parent or on the sibling it follows, and only
    // a missing list should be reported as one.
    const { parent } = op.task;
    if (!(await findTask(google, op.listId, parent))) {
      if (!(await google.listTaskLists()).some((l) => l.id === op.listId)) throw error;
      await store.commit((s) => dropDeleted(s, parent));
      return null;
    }
    const previous = await survivingPrevious(
      google,
      store,
      op.listId,
      parent,
      op.task.previous ?? null,
      op.tempId,
    );
    try {
      return await google.insertTask(op.listId, { ...op.task, previous: previous ?? undefined });
    } catch (retryError) {
      if (!(retryError instanceof NotFoundError)) throw retryError;
      await store.commit((s) => dropDeleted(s, op.tempId));
      return null;
    }
  }
}

// NotFound from a move means the task left the old list (the move already happened
// and only the response was lost), the destination list is gone, or the task is gone.
async function resolveMissingMove(
  google: GoogleApi,
  store: Store,
  head: QueuedOp,
  op: Extract<Op, { kind: 'move' }>,
): Promise<void> {
  const find = (listId: string) => findTask(google, listId, op.taskId);
  const moved = await find(op.toListId);
  if (moved) {
    await store.commit((s) => settle(s, head.seq, op.taskId, moved));
    return;
  }
  const stayed = await find(op.listId);
  if (!stayed) {
    await store.commit((s) => dropDeleted(s, op.taskId));
    return;
  }
  await store.commit((s) => {
    const family = s.tasks.filter((t) => t.id === op.taskId || t.parent === op.taskId);
    const ids = new Set(family.map((t) => t.id));
    return {
      dequeue: [head.seq],
      putTasks: family.map((t) => ({ ...t, listId: op.listId })),
      // Later edits to the task or its subtasks, and steps added to it, were queued against
      // the list it appeared to be in.
      requeue: s.queued
        .filter(
          (q) =>
            q.seq !== head.seq &&
            (q.op.kind === 'create'
              ? q.op.task.parent !== undefined && ids.has(q.op.task.parent)
              : ids.has(q.op.taskId)),
        )
        .map((q) => ({ seq: q.seq, op: { ...q.op, listId: op.listId } as Op })),
      notices: [
        `“${family.find((t) => t.id === op.taskId)?.title || stayed.title || 'A task'}” couldn't be moved because the list no longer exists.`,
      ],
    };
  });
}

function unhide(s: Snapshot, taskId: string): Record<string, string> {
  const { [taskId]: _, ...rest } = s.hidden;
  return rest;
}

// The copy already exists in the other account, so the original goes only if nobody
// has touched it since it was copied. A duplicate is better than losing an edit.
async function runTransferDelete(
  google: GoogleApi,
  store: Store,
  head: QueuedOp,
  op: Extract<Op, { kind: 'transferDelete' }>,
): Promise<void> {
  const clearUp = (extra: Change = {}) =>
    store.commit((s) => ({
      ...extra,
      dequeue: [head.seq],
      meta: { hidden: unhide(s, op.taskId) },
    }));
  let unchanged: boolean;
  try {
    const original = await google.getTask(op.listId, op.taskId);
    const steps = (await google.listTasks(op.listId, EPOCH)).filter((t) => t.parent === op.taskId);
    const expected = op.fingerprint.steps;
    unchanged =
      original.updated === op.fingerprint.updated &&
      steps.length === Object.keys(expected).length &&
      steps.every((t) => expected[t.id] === t.updated);
    if (unchanged) await google.deleteTask(op.listId, op.taskId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // Gone already, or its list is: there is nothing left to delete.
    await clearUp();
    return;
  }
  if (!unchanged) {
    await clearUp({
      notices: [`“${op.title}” changed while it was being moved, so both copies are kept.`],
    });
    return;
  }
  await store.commit((s) => {
    const family = s.tasks
      .filter((t) => t.id === op.taskId || t.parent === op.taskId)
      .map((t) => t.id);
    return {
      dequeue: [head.seq],
      removeTasks: family,
      removeEntries: [...new Set([op.taskId, ...family])],
      meta: { hidden: unhide(s, op.taskId) },
    };
  });
}
