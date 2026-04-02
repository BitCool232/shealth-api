import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  anthropic,
  MODEL_SMART,
  extractText,
  parseClaudeJSON,
  errorResponse,
} from "../lib/claude";
import { cacheGet, cacheSet, buildCacheKey } from "../lib/cache";
import { checkRateLimit, getDeviceId } from "../lib/rate-limit";

// ---------------------------------------------------------------------------
// POST /api/analyze-supplement-stack
// Proxies supplement stack analysis to Claude Sonnet (complex reasoning)
// ---------------------------------------------------------------------------

interface AnalyzeStackBody {
  supplements: string[];
  userAge: number | null;
  fitnessGoal: string | null;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json(errorResponse("Method not allowed", "METHOD_NOT_ALLOWED"));
    return;
  }

  // Rate limiting
  const deviceId = getDeviceId(req.headers as Record<string, string | string[] | undefined>);
  const rateLimit = checkRateLimit(deviceId);
  res.setHeader("X-RateLimit-Remaining", rateLimit.remaining.toString());
  res.setHeader("X-RateLimit-Limit", rateLimit.limit.toString());
  res.setHeader("X-RateLimit-Reset", rateLimit.resetsAt.toString());

  if (!rateLimit.allowed) {
    res.status(429).json(
      errorResponse(
        `Rate limit exceeded. Resets at ${new Date(rateLimit.resetsAt).toISOString()}.`,
        "RATE_LIMITED",
        true
      )
    );
    return;
  }

  try {
    const body = req.body as AnalyzeStackBody;

    if (!body.supplements?.length) {
      res.status(400).json(errorResponse("supplements array is required", "BAD_REQUEST"));
      return;
    }

    // Cache by sorted supplement list + user context
    const sortedSupplements = [...body.supplements].sort();
    const cacheKey = buildCacheKey(
      "stack",
      ...sortedSupplements,
      body.userAge?.toString(),
      body.fitnessGoal
    );

    const cached = cacheGet<object>(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      res.status(200).json(cached);
      return;
    }

    const stackDescription = body.supplements.join("\n");

    const prompt = `Analyze this supplement stack for interactions, redundancies, and gaps. Focus on testosterone and hormone optimization.

SUPPLEMENTS:
${stackDescription}

USER: Age ${body.userAge ?? "unknown"}, Goal: ${body.fitnessGoal ?? "general health"}

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "overallRating": <1-10 integer>,
  "summary": "<2-3 sentence overview>",
  "interactions": [
    {
      "supplements": ["<name1>", "<name2>"],
      "type": "<positive|negative|neutral>",
      "description": "<explanation>"
    }
  ],
  "redundancies": [
    {
      "ingredient": "<name>",
      "sources": ["<supplement1>", "<supplement2>"],
      "recommendation": "<what to do>"
    }
  ],
  "gaps": [
    {
      "nutrient": "<name>",
      "importance": "<critical|recommended>",
      "reason": "<why it matters>",
      "suggestion": "<what to add>"
    }
  ],
  "timingRecommendations": [
    {
      "supplement": "<name>",
      "bestTime": "<morning|afternoon|evening|with_meals|before_bed>",
      "reason": "<why this timing>"
    }
  ],
  "hormoneInsights": [
    {
      "hormone": "<Testosterone|Cortisol|Estrogen|Thyroid>",
      "effect": "<supporting|hindering|mixed>",
      "explanation": "<details>",
      "contributors": ["<supplement1>"]
    }
  ]
}

Provide:
1. Dangerous or counterproductive interactions
2. Redundant ingredients (doubling up)
3. Missing supplements that would complement the stack for their goal
4. Optimal timing recommendations
5. Overall stack rating (1-10)

Be concise and actionable. Use plain language.`;

    const response = await anthropic.messages.create({
      model: MODEL_SMART,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractText(response);
    const parsed = parseClaudeJSON(text);

    cacheSet(cacheKey, parsed);
    res.setHeader("X-Cache", "MISS");
    res.status(200).json(parsed);
  } catch (err: unknown) {
    console.error("[analyze-supplement-stack] Error:", err);

    if (err instanceof Error && err.message.includes("rate_limit")) {
      res.status(429).json(errorResponse("Anthropic rate limit hit. Try again shortly.", "UPSTREAM_RATE_LIMITED", true));
      return;
    }

    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json(errorResponse(message, "INTERNAL_ERROR", true));
  }
}
