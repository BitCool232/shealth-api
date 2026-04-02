import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  anthropic,
  MODEL_FAST,
  extractText,
  parseClaudeJSON,
  errorResponse,
} from "../lib/claude";
import { checkRateLimit, getDeviceId } from "../lib/rate-limit";

// ---------------------------------------------------------------------------
// POST /api/analyze-food-photo
// Proxies food photo analysis to Claude Vision (no caching — photos are unique)
// ---------------------------------------------------------------------------

interface AnalyzeFoodPhotoBody {
  imageBase64: string;
  userContext: string | null;
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
    const body = req.body as AnalyzeFoodPhotoBody;

    if (!body.imageBase64) {
      res.status(400).json(errorResponse("imageBase64 is required", "BAD_REQUEST"));
      return;
    }

    const contextNote = body.userContext ? ` User note: ${body.userContext}` : "";

    const prompt = `Analyze this food photo and estimate calories and macronutrients for each item visible.${contextNote}

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "foodItems": [
    {
      "name": "<food item>",
      "estimatedCalories": <integer>,
      "estimatedProtein": <double in grams>,
      "estimatedCarbs": <double in grams>,
      "estimatedFat": <double in grams>,
      "portionSize": "<estimated portion>"
    }
  ],
  "totalCalories": <integer>,
  "totalProtein": <double>,
  "totalCarbs": <double>,
  "totalFat": <double>,
  "confidence": "<high|medium|low>",
  "hormoneNote": "<optional: how this meal affects testosterone/hormones, or null>"
}

Be realistic with portions visible in the photo. Include a hormone note if the meal has significant testosterone-relevant properties (zinc, healthy fats, phytoestrogens, etc.).`;

    const response = await anthropic.messages.create({
      model: MODEL_FAST,
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: body.imageBase64,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });

    const text = extractText(response);
    const parsed = parseClaudeJSON(text);

    res.status(200).json(parsed);
  } catch (err: unknown) {
    console.error("[analyze-food-photo] Error:", err);

    if (err instanceof Error && err.message.includes("rate_limit")) {
      res.status(429).json(errorResponse("Anthropic rate limit hit. Try again shortly.", "UPSTREAM_RATE_LIMITED", true));
      return;
    }

    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json(errorResponse(message, "INTERNAL_ERROR", true));
  }
}
