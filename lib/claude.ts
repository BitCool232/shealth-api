import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Shared Claude API client for all SHealth proxy endpoints
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.warn(
    "[shealth-api] ANTHROPIC_API_KEY is not set. Requests will fail."
  );
}

/** Pre-configured Anthropic SDK client (singleton per cold-start). */
export const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY ?? "",
});

// Model selection — Haiku for cheap / fast scans, Sonnet for complex analysis
export const MODEL_FAST = "claude-haiku-4-5-20251001";
export const MODEL_SMART = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first text block from a Claude Messages response. */
export function extractText(
  response: Anthropic.Messages.Message
): string {
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("No text content in Claude response");
  }
  return block.text;
}

/**
 * Parse JSON from Claude's response, tolerating markdown code fences.
 */
export function parseClaudeJSON<T = unknown>(raw: string): T {
  let cleaned = raw.trim();

  // Strip ```json ... ``` wrapper if present
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) cleaned = cleaned.slice(firstNewline + 1);
    const lastFence = cleaned.lastIndexOf("```");
    if (lastFence !== -1) cleaned = cleaned.slice(0, lastFence);
    cleaned = cleaned.trim();
  }

  return JSON.parse(cleaned) as T;
}

/** Standard error response shape the iOS app can parse. */
export interface APIErrorResponse {
  error: string;
  code: string;
  retryable: boolean;
}

export function errorResponse(
  message: string,
  code: string,
  retryable = false
): APIErrorResponse {
  return { error: message, code, retryable };
}
