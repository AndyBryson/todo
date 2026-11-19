export interface AccountName {
  // Empty means "use the Google name".
  name: string;
  updatedAt: string;
}

export const ACCOUNT_FILE = 'account.json';

// newerName compares these as strings, so a value that is not a time could beat every real rename.
export function isTime(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

export function parseAccountFile(raw: string | null): AccountName | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (o.version !== 1 || typeof o.name !== 'string' || !isTime(o.updatedAt)) return null;
    return { name: o.name, updatedAt: o.updatedAt };
  } catch {
    return null;
  }
}

export function serialiseAccountFile(n: AccountName): string {
  return JSON.stringify({ version: 1, name: n.name, updatedAt: n.updatedAt });
}

// A tie goes to the remote copy so two devices that stamped the same instant settle on one.
export function newerName(
  local: AccountName | null,
  remote: AccountName | null,
): AccountName | null {
  if (!local || !remote) return local ?? remote;
  return local.updatedAt > remote.updatedAt ? local : remote;
}

// Every screen takes its account name from here, so a rename shows up everywhere at once.
export function accountLabel(
  record: { label: string | null; email: string | null },
  saved: AccountName | null,
): string {
  return (saved?.name ? saved.name : null) ?? record.label ?? record.email ?? 'Account';
}
