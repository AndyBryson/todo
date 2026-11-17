import { AuthError } from './api';

export interface Auth {
  getToken(): Promise<string>;
  signIn(): Promise<void>;
  signedIn(): boolean;
  subscribe(fn: () => void): () => void;
}

const SCOPES = [
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');
const GIS_URL = 'https://accounts.google.com/gsi/client';
const CONSENT_KEY = 'todo.consented';
const REFRESH_MARGIN_MS = 5 * 60_000;
// A silent request that never answers would leave every sync waiting.
const SILENT_TIMEOUT_MS = 15_000;

const hasConsented = () => {
  try {
    return localStorage.getItem(CONSENT_KEY) !== null;
  } catch {
    return false;
  }
};

const rememberConsent = () => {
  try {
    localStorage.setItem(CONSENT_KEY, '1');
  } catch {
    // Without storage the user simply signs in again next visit.
  }
};

let scriptLoad: Promise<void> | undefined;
function loadScript(): Promise<void> {
  scriptLoad ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GIS_URL;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptLoad = undefined; // allow a retry once back online
      reject(new AuthError('Could not load Google sign-in'));
    };
    document.head.append(el);
  });
  return scriptLoad;
}

export function createAuth(clientId: string): Auth {
  let token: string | null = null;
  let expiresAt = 0;
  let client: google.accounts.oauth2.TokenClient | undefined;
  let waiting: { resolve: () => void; reject: (e: Error) => void } | undefined;
  let silent: Promise<string> | undefined;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const fn of listeners) fn();
  };
  const fresh = (margin: number) => token !== null && expiresAt - Date.now() > margin;

  async function request(prompt: '' | 'consent'): Promise<void> {
    await loadScript();
    client ??= google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (res) => {
        if (res.error || !res.access_token) {
          waiting?.reject(new AuthError(res.error ?? 'No token returned'));
          return;
        }
        token = res.access_token;
        expiresAt = Date.now() + Number(res.expires_in ?? 3600) * 1000;
        rememberConsent();
        waiting?.resolve();
      },
      error_callback: (err) => waiting?.reject(new AuthError(err.type)),
    });
    const c = client;
    await new Promise<void>((resolve, reject) => {
      waiting = { resolve, reject };
      c.requestAccessToken({ prompt });
    });
  }

  return {
    async getToken() {
      if (fresh(REFRESH_MARGIN_MS) && token) return token;
      // Never prompt here: a popup outside a user gesture is blocked on iOS.
      if (!hasConsented()) throw new AuthError('Sign in needed');
      silent ??= (async () => {
        try {
          await Promise.race([
            request(''),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new AuthError('Silent sign-in timed out')),
                SILENT_TIMEOUT_MS,
              ),
            ),
          ]);
          return token as string;
        } catch (e) {
          token = null;
          throw e instanceof AuthError ? e : new AuthError('Sign in needed');
        } finally {
          silent = undefined;
          notify();
        }
      })();
      return silent;
    },

    async signIn() {
      await request(hasConsented() ? '' : 'consent');
      notify();
    },

    signedIn: () => fresh(0),

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
