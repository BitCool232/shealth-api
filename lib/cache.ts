import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Simple in-memory cache with TTL
// ---------------------------------------------------------------------------
// NOTE: This works well for a single Vercel serverless instance but resets
// on cold starts. For production persistence, upgrade to Vercel KV:
//
//   import { kv } from "@vercel/kv";
//   await kv.set(key, value, { ex: ttlSeconds });
//   const cached = await kv.get<T>(key);
//
// The interface below is designed so the swap is a drop-in replacement.
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** Default TTL: 24 hours */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Maximum cache entries before eviction (LRU-ish: just clear oldest half) */
const MAX_ENTRIES = 500;

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS): void {
  // Simple eviction when cache is full
  if (store.size >= MAX_ENTRIES) {
    const keys = Array.from(store.keys());
    for (let i = 0; i < keys.length / 2; i++) {
      store.delete(keys[i]);
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Build a deterministic cache key from parts. */
export function buildCacheKey(...parts: (string | number | null | undefined)[]): string {
  const raw = parts
    .map((p) => (p == null ? "_null_" : String(p)))
    .join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}
