import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  anthropic,
  MODEL_FAST,
  extractText,
  parseClaudeJSON,
  errorResponse,
} from "../lib/claude";
import { cacheGet, cacheSet, buildCacheKey } from "../lib/cache";
import { checkRateLimit, getDeviceId } from "../lib/rate-limit";

// ---------------------------------------------------------------------------
// POST /api/analyze-ingredients
// Proxies ingredient analysis requests to Claude (Haiku for cost efficiency)
// ---------------------------------------------------------------------------

interface AnalyzeIngredientsBody {
  barcode: string;
  productName: string;
  brand: string;
  ingredients: string[];
  additives: string[];
  allergens: string[];
  nutriments: Record<string, number>;
  userAge: number | null;
  userWeight: number | null;
  fitnessGoal: string | null;
  dietaryRestrictions: string[];
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // CORS preflight
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
        `Rate limit exceeded. ${rateLimit.remaining} of ${rateLimit.limit} requests remaining. Resets at ${new Date(rateLimit.resetsAt).toISOString()}.`,
        "RATE_LIMITED",
        true
      )
    );
    return;
  }

  try {
    const body = req.body as AnalyzeIngredientsBody;

    if (!body.barcode || !body.productName) {
      res.status(400).json(errorResponse("barcode and productName are required", "BAD_REQUEST"));
      return;
    }

    // Cache key includes barcode + user-context hash for personalized results
    const userContextHash = buildCacheKey(
      body.userAge?.toString(),
      body.userWeight?.toString(),
      body.fitnessGoal,
      ...(body.dietaryRestrictions ?? [])
    );
    const cacheKey = `ingredients:${body.barcode}:${userContextHash}`;

    // Check cache
    const cached = cacheGet<object>(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      res.status(200).json(cached);
      return;
    }

    // Build prompt (matches ClaudeAPIService.swift exactly)
    const nutrimentsSummary = Object.entries(body.nutriments ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    const restrictionsText =
      !body.dietaryRestrictions?.length
        ? "None"
        : body.dietaryRestrictions.join(", ");

    const prompt = `You are SHealth's AI analysis engine. Analyze this product for health impact with special focus on hormonal health and testosterone optimization.

PRODUCT: ${body.productName}
BRAND: ${body.brand}
INGREDIENTS: ${(body.ingredients ?? []).join(", ")}
ADDITIVES: ${(body.additives ?? []).join(", ")}
ALLERGENS: ${(body.allergens ?? []).join(", ")}
NUTRITION: ${nutrimentsSummary}

USER PROFILE:
- Age: ${body.userAge ?? "Unknown"}
- Weight: ${body.userWeight ? `${body.userWeight} lbs` : "Unknown"}
- Fitness Goal: ${body.fitnessGoal ?? "General health"}
- Dietary Restrictions: ${restrictionsText}

Respond ONLY with valid JSON matching this exact structure (no markdown, no code fences):
{
  "overallScore": <0-100 integer>,
  "scoreReasoning": "<1-2 sentence explanation>",
  "ingredientBreakdown": [
    {
      "name": "<ingredient name>",
      "whatItDoes": "<brief explanation>",
      "safetyRating": "<safe|caution|avoid>",
      "hormoneEffect": "<positive|neutral|negative>",
      "hormoneExplanation": "<how it affects testosterone/hormones>",
      "evidenceLevel": "<strong|moderate|limited>"
    }
  ],
  "riskFlags": [
    {
      "title": "<flag title>",
      "level": "<low|moderate|high>",
      "explanation": "<why this matters>"
    }
  ],
  "goodHighlights": [
    {
      "title": "<highlight title>",
      "explanation": "<why this is good>"
    }
  ],
  "hormoneImpact": {
    "tScoreImpact": <-10 to +10 integer>,
    "testosteroneEffect": "<positive|neutral|negative>",
    "summary": "<1-2 sentence hormone impact summary>",
    "keyFactors": ["<factor1>", "<factor2>"]
  },
  "alternatives": [
    {
      "name": "<product name>",
      "reason": "<why it's better>",
      "estimatedScore": <0-100>
    }
  ],
  "personalizedNote": "<personalized recommendation based on user profile, or null>"
}

Focus on:
1. Ingredients that affect testosterone (phytoestrogens, zinc, vitamin D, etc.)
2. Endocrine disruptors (BPA, parabens, soy derivatives)
3. Artificial additives and their health effects
4. Nutritional quality for fitness goals
5. Personalize the analysis to the user's age, weight, and goals

Be direct and evidence-based. Limit ingredient breakdown to the 8 most important ingredients.`;

    const response = await anthropic.messages.create({
      model: MODEL_FAST,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractText(response);
    const parsed = parseClaudeJSON(text);

    // Cache the successful response
    cacheSet(cacheKey, parsed);
    res.setHeader("X-Cache", "MISS");
    res.status(200).json(parsed);
  } catch (err: unknown) {
    console.error("[analyze-ingredients] Error:", err);

    if (err instanceof Error && err.message.includes("rate_limit")) {
      res.status(429).json(errorResponse("Anthropic rate limit hit. Try again shortly.", "UPSTREAM_RATE_LIMITED", true));
      return;
    }

    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json(errorResponse(message, "INTERNAL_ERROR", true));
  }
}
