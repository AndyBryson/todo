import {
  ACCOUNT_FILE,
  type AccountName,
  newerName,
  parseAccountFile,
  serialiseAccountFile as serialise,
} from '../domain/account-name';
import type { GoogleApi } from '../google/api';
import type { Store } from '../store/db';

const ATTEMPTS = 3;

// If another device keeps winning the write race the local name stays and the next
// cycle tries again; the later timestamp still decides, so nothing is lost for good.
export async function syncAccountName(google: GoogleApi, store: Store): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { raw, version } = await google.readAppFile(ACCOUNT_FILE);
    const remote = parseAccountFile(raw);
    // Decided inside the commit, so a rename still in flight is never overwritten by an older remote name.
    let merged: AccountName | null = null;
    await store.commit((cur) => {
      merged = newerName(cur.accountName, remote);
      const same = cur.accountName && merged && serialise(cur.accountName) === serialise(merged);
      return merged && !same ? { meta: { accountName: merged } } : {};
    });
    const stored = merged as AccountName | null;
    if (!stored) return;
    if (remote && serialise(stored) === serialise(remote)) return;
    if ((await google.writeAppFile(ACCOUNT_FILE, serialise(stored), version)) === 'ok') {
      return;
    }
  }
}
