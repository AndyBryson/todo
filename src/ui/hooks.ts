import { useEffect, useRef, useState, useSyncExternalStore } from 'preact/compat';
import type { Account, AccountSet } from '../accounts/set';
import type { Workspace } from '../accounts/workspace';
import { combineStatus, type Merged } from '../domain/merge';
import type { TaskList } from '../domain/types';
import type { SyncStatus } from '../sync/engine';

export function useMerged(ws: Workspace): Merged {
  return useSyncExternalStore(ws.subscribe, ws.merged);
}

export function useAccounts(set: AccountSet): Account[] {
  return useSyncExternalStore(set.subscribe, set.all);
}

// useSyncExternalStore needs the same object back while nothing changed.
export function useStatus(
  set: AccountSet,
  label: (accountId: string) => string,
): ReturnType<typeof combineStatus> {
  const cache = useRef<{
    views: { label: string; status: SyncStatus }[];
    result: ReturnType<typeof combineStatus>;
  } | null>(null);
  const read = () => {
    const views = set.active().map((a) => ({
      label: label(a.record.id),
      status: a.engine.status(),
    }));
    const was = cache.current;
    const same =
      was?.views.length === views.length &&
      views.every((v, i) => was.views[i]?.label === v.label && was.views[i]?.status === v.status);
    if (!was || !same) cache.current = { views, result: combineStatus(views) };
    return (cache.current as { result: ReturnType<typeof combineStatus> }).result;
  };
  return useSyncExternalStore(set.subscribe, read);
}

const PHONE_QUERY = '(max-width: 700px)';

export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return phone;
}

// One account's lists, for pickers that group lists under their account.
export interface AccountGroup {
  id: string;
  label: string;
  lists: TaskList[];
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    return () => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    };
  }, []);
  return online;
}
