// A short in-memory copy of checked sessions, keyed by the session cookie.
//
// Why: every staff page checks the session in the registry database (two
// queries one after the other). The auth settings already accept a session
// copy up to one minute old (cookieCache in auth.ts), but that cookie copy
// cannot be renewed while a server page renders, so after the first minute
// every page went to the database again. This keeps the same one-minute rule
// inside the server process.
//
// Same limits as the cookie copy: a disabled person or a revoked session is
// refused within a minute. Signing out clears the browser's cookie, so its
// entry is never used again. Only valid sessions are kept, never "no session".

export interface CachedSessionStore<T> {
  get(key: string, now?: number): T | undefined;
  set(key: string, value: T, expiresAt: number | Date, now?: number): void;
  clear(): void;
}

export const SESSION_CACHE_MS = 60_000;
const MAX_ENTRIES = 2_000;

export function createSessionStore<T>(ttlMs = SESSION_CACHE_MS, maxEntries = MAX_ENTRIES): CachedSessionStore<T> {
  const entries = new Map<string, { value: T; until: number }>();
  return {
    get(key, now = Date.now()) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.until <= now) {
        entries.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value, expiresAt, now = Date.now()) {
      // Never past the session's own expiry.
      const until = Math.min(now + ttlMs, new Date(expiresAt).getTime());
      if (until <= now) return;
      if (entries.size >= maxEntries) {
        for (const [k, e] of entries) if (e.until <= now) entries.delete(k);
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      }
      entries.set(key, { value, until });
    },
    clear() {
      entries.clear();
    },
  };
}
