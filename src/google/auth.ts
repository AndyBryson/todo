import { consentKey, tokenKey } from '../accounts/registry';
import { AuthError, OfflineError } from './api';

export interface Auth {
  getToken(): Promise<string>;
  signIn(opts?: { chooseAccount?: boolean }): Promise<void>;
  // Drops this account's saved pass without telling Google, so other tabs and
  // devices using the same grant are unaffected.
  forget(): void;
  signedIn(): boolean;
  subscribe(fn: () => void): () => void;
}

const SCOPES = [
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');
const GIS_URL = 'https://accounts.google.com/gsi/client';
// Google gives a browser-only app an hour-long pass and no way to renew it quietly,
// so keeping it across restarts saves the sign-in window flashing on every launch.
const REFRESH_MARGIN_MS = 5 * 60_000;
// A silent request that never answers would leave every sync waiting.
const SILENT_TIMEOUT_MS = 15_000;

const hasConsented = (id: string) => {
  try {
    return localStorage.getItem(consentKey(id)) !== null;
  } catch {
    return false;
  }
};

const rememberConsent = (id: string) => {
  try {
    localStorage.setItem(consentKey(id), '1');
  } catch {
    // Without storage the user simply signs in again next visit.
  }
};

interface Saved {
  token: string;
  expiresAt: number;
}

function loadSaved(id: string): Saved | null {
  try {
    const saved = JSON.parse(localStorage.getItem(tokenKey(id)) ?? 'null') as Partial<Saved> | null;
    if (typeof saved?.token === 'string' && typeof saved.expiresAt === 'number') {
      return { token: saved.token, expiresAt: saved.expiresAt };
    }
  } catch {
    // Unreadable or blocked storage just means a fresh sign-in.
  }
  return null;
}

function save(id: string, saved: Saved) {
  try {
    localStorage.setItem(tokenKey(id), JSON.stringify(saved));
  } catch {
    // Without storage the pass lasts only as long as this window.
  }
}

let scriptLoad: Promise<void> | undefined;
function loadScript(): Promise<void> {
  scriptLoad ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GIS_URL;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Usually the device is offline; drop the tag so a later call can retry.
      el.remove();
      scriptLoad = undefined;
      reject(new OfflineError('Could not load Google sign-in'));
    };
    document.head.append(el);
  });
  return scriptLoad;
}

interface Waiting {
  resolve: () => void;
  reject: (e: Error) => void;
}

function forgetSaved(id: string) {
  try {
    localStorage.removeItem(tokenKey(id));
    localStorage.removeItem(consentKey(id));
  } catch {
    // Nothing readable was stored, so nothing is left to clear.
  }
}

export function createAuth(
  clientId: string,
  { id, loginHint }: { id: string; loginHint: () => string | null },
): Auth {
  const saved = loadSaved(id);
  let token: string | null = saved?.token ?? null;
  let expiresAt = saved?.expiresAt ?? 0;
  let client: google.accounts.oauth2.TokenClient | undefined;
  // Only the newest request is waiting on the GIS callback; each request owns its
  // own promise, so a late timeout can only ever affect itself.
  let waiting: Waiting | undefined;
  let silent: Promise<string> | undefined;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const fn of listeners) fn();
  };
  const fresh = (margin: number) => token !== null && expiresAt - Date.now() > margin;

  async function request(timeoutMs?: number, chooseAccount = false): Promise<void> {
    await loadScript();
    client ??= google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (res) => {
        const current = waiting;
        waiting = undefined;
        if (res.error || !res.access_token) {
          current?.reject(new AuthError(res.error ?? 'No token returned'));
          return;
        }
        token = res.access_token;
        expiresAt = Date.now() + Number(res.expires_in ?? 3600) * 1000;
        save(id, { token, expiresAt });
        rememberConsent(id);
        current?.resolve();
      },
      error_callback: (err) => {
        const current = waiting;
        waiting = undefined;
        current?.reject(new AuthError(err.type));
      },
    });
    const c = client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const mine: Waiting = { resolve, reject };
        // A newer request supersedes an older one that never got an answer.
        waiting?.reject(new AuthError('Superseded by a newer sign-in request'));
        waiting = mine;
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            if (waiting === mine) waiting = undefined;
            reject(new AuthError('Silent sign-in timed out'));
          }, timeoutMs);
        }
        // Google shows the consent screen by itself when access is not yet granted.
        // Forcing it with 'consent' lost the popup's reply, so sign-in never finished.
        // Pinning the email keeps a silent renewal on this account when the browser
        // is signed in to several; the chooser is only for adding a new one.
        const hint = loginHint();
        c.requestAccessToken({
          prompt: chooseAccount ? 'select_account' : '',
          ...(hint === null ? {} : { login_hint: hint }),
        });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getToken() {
      if (fresh(REFRESH_MARGIN_MS) && token) return token;
      // Never prompt here: a popup outside a user gesture is blocked on iOS.
      if (!hasConsented(id)) throw new AuthError('Sign in needed');
      silent ??= (async () => {
        try {
          await request(SILENT_TIMEOUT_MS);
          return token as string;
        } catch (e) {
          // A failed renewal must not discard a token that still works.
          if (token !== null && fresh(0)) return token;
          throw e instanceof AuthError || e instanceof OfflineError
            ? e
            : new AuthError('Sign in needed');
        } finally {
          silent = undefined;
          notify();
        }
      })();
      return silent;
    },

    async signIn(opts) {
      await request(undefined, opts?.chooseAccount);
      notify();
    },

    forget() {
      token = null;
      expiresAt = 0;
      forgetSaved(id);
      notify();
    },

    signedIn: () => fresh(0),

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
