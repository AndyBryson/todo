// The slice of Google Identity Services this app uses; the library ships no types
// and a type package would be a new dependency.
declare namespace google.accounts.oauth2 {
  interface TokenResponse {
    access_token?: string;
    expires_in?: number | string;
    error?: string;
  }
  interface TokenClientConfig {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type: string }) => void;
  }
  interface TokenClient {
    requestAccessToken(overrides?: { prompt?: string }): void;
  }
  function initTokenClient(config: TokenClientConfig): TokenClient;
}
