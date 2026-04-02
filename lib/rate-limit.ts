// ---------------------------------------------------------------------------
// Basic per-device rate limiting (in-memory)
// ---------------------------------------------------------------------------
// Same caveat as cache.ts — resets on cold start. For production, use
// Vercel KV or Upstash Redis for durable counters.
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const limits = new Map<string, RateLimitEntry>();

/** Window = 24 hours */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default free-tier limit */
const FREE_TIER_LIMIT = parseInt(process.env.RATE_LIMIT_FREE_TIER ?? "20", 10);

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetsAt: number;
}

export function checkRateLimit(deviceId: string): RateLimitResult {
  const now = Date.now();
  let entry = limits.get(deviceId);

  // New window or expired
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    limits.set(deviceId, entry);
  }

  entry.count++;
  const allowed = entry.count <= FREE_TIER_LIMIT;
  const remaining = Math.max(0, FREE_TIER_LIMIT - entry.count);
  const resetsAt = entry.windowStart + WINDOW_MS;

  return { allowed, remaining, limit: FREE_TIER_LIMIT, resetsAt };
}

/**
 * Extract device ID from request headers.
 * Falls back to IP-based identification if no device ID header is present.
 */
export function getDeviceId(headers: Record<string, string | string[] | undefined>): string {
  const deviceHeader = headers["x-device-id"];
  if (deviceHeader) {
    return Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader;
  }
  // Fallback to forwarded IP
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return `ip:${ip.trim()}`;
  }
  return "unknown";
}
