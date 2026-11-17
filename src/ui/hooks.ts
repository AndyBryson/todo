import { useEffect, useState, useSyncExternalStore } from 'preact/compat';
import type { Snapshot, Store } from '../store/db';
import type { SyncEngine, SyncStatus } from '../sync/engine';

export function useSnapshot(store: Store): Snapshot {
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

export function useSyncStatus(engine: SyncEngine): SyncStatus {
  return useSyncExternalStore(engine.subscribe, engine.status);
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
