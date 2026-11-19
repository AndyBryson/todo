import { describe, expect, it } from 'vitest';
import { type AccountRecord, consentKey, type KeyValue, loadRegistry, tokenKey } from './registry';

function memory(initial: Record<string, string> = {}): KeyValue & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('loadRegistry', () => {
  it('migrates a single-account device', () => {
    const token = '{"token":"t","expiresAt":9}';
    const s = memory({ 'todo.token': token, 'todo.consented': '1' });
    const records = loadRegistry(s);
    expect(records).toHaveLength(1);
    const record = records[0] as AccountRecord;
    expect(record).toMatchObject({ db: 'todo', email: null, label: null, signedOut: false });
    expect(s.data.get(tokenKey(record.id))).toBe(token);
    expect(s.data.get(consentKey(record.id))).toBe('1');
    expect(s.data.has('todo.token')).toBe(false);
    expect(s.data.has('todo.consented')).toBe(false);
    expect(JSON.parse(s.data.get('todo.accounts') ?? 'null')).toEqual([record]);
  });

  it('keeps the old keys when the registry cannot be saved', () => {
    const token = '{"token":"t","expiresAt":9}';
    const s = memory({ 'todo.token': token, 'todo.consented': '1' });
    const setItem = s.setItem;
    s.setItem = (k, v) => {
      if (k === 'todo.accounts') throw new Error('QuotaExceededError');
      setItem(k, v);
    };
    loadRegistry(s);
    // The next start migrates again and must still find the token.
    expect(s.data.get('todo.token')).toBe(token);
    expect(s.data.get('todo.consented')).toBe('1');
  });

  it('a fresh device also gets a first record on db todo', () => {
    const s = memory();
    const records = loadRegistry(s);
    expect(records).toHaveLength(1);
    const record = records[0] as AccountRecord;
    expect(record.db).toBe('todo');
    expect(s.data.has(tokenKey(record.id))).toBe(false);
  });

  it('migration runs once', () => {
    const s = memory({ 'todo.token': '{"token":"t","expiresAt":9}', 'todo.consented': '1' });
    const first = loadRegistry(s);
    const keys = [...s.data.entries()];
    const second = loadRegistry(s);
    expect(second).toEqual(first);
    expect([...s.data.entries()]).toEqual(keys);
  });

  it('drops malformed records', () => {
    const good = { id: 'b', db: 'todo-b', email: null, label: null, signedOut: false };
    const s = memory({ 'todo.accounts': JSON.stringify([{ id: 'a' }, good]) });
    expect(loadRegistry(s)).toEqual([good]);
  });
});
