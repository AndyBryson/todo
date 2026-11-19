import {
  ACCOUNT_FILE,
  newerName,
  parseAccountFile,
  serialiseAccountFile,
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
    const local = store.snapshot().accountName;
    const merged = newerName(local, remote);
    if (!merged) return;
    if (merged !== local) await store.commit({ meta: { accountName: merged } });
    if (remote && serialiseAccountFile(merged) === serialiseAccountFile(remote)) return;
    if ((await google.writeAppFile(ACCOUNT_FILE, serialiseAccountFile(merged), version)) === 'ok') {
      return;
    }
  }
}
