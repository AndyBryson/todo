export interface AccountRecord {
  id: string;
  email: string | null;
  label: string | null;
  db: string;
  signedOut: boolean;
}

export type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const REGISTRY_KEY = 'todo.accounts';
// The first account keeps the original IndexedDB name so its mirror and queue
// survive the move to a registry.
const FIRST_DB = 'todo';

export const tokenKey = (id: string) => `todo.token.${id}`;
export const consentKey = (id: string) => `todo.consented.${id}`;

export const newAccountId = () => crypto.randomUUID().slice(0, 8);

function isRecord(r: unknown): r is AccountRecord {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.db === 'string' &&
    typeof o.signedOut === 'boolean' &&
    (o.email === null || typeof o.email === 'string') &&
    (o.label === null || typeof o.label === 'string')
  );
}

export function saveRegistry(storage: KeyValue, records: AccountRecord[]): void {
  try {
    storage.setItem(REGISTRY_KEY, JSON.stringify(records));
  } catch {
    // Without storage the list lasts only as long as this window.
  }
}

function migrate(storage: KeyValue): AccountRecord[] {
  const id = newAccountId();
  const record: AccountRecord = {
    id,
    email: null,
    label: null,
    db: FIRST_DB,
    signedOut: false,
  };
  try {
    // Moved rather than copied so a later sign-in on the old keys cannot diverge.
    for (const [from, to] of [
      ['todo.token', tokenKey(id)],
      ['todo.consented', consentKey(id)],
    ] as const) {
      const value = storage.getItem(from);
      if (value !== null) {
        storage.setItem(to, value);
        storage.removeItem(from);
      }
    }
  } catch {
    // Unreadable storage just means signing in again.
  }
  const records = [record];
  saveRegistry(storage, records);
  return records;
}

export function loadRegistry(storage: KeyValue): AccountRecord[] {
  let raw: string | null = null;
  try {
    raw = storage.getItem(REGISTRY_KEY);
  } catch {
    // Treated as missing: the device then starts with one fresh account.
  }
  if (raw === null) return migrate(storage);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
  } catch {
    // Corrupt JSON falls through to a fresh start below.
  }
  return migrate(storage);
}
