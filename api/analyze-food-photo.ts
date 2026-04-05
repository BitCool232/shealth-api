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
  userGoal?: string;
  calorieTarget?: number;
  proteinTarget?: number;
  plateDiameterCM?: number;
  foodRegionsJSON?: string;
  userContext?: string | null;
}

// Goal-based defaults (mirrors iOS UserProfile logic)
function defaultCalorieTarget(goal: string): number {
  switch (goal.toLowerCase()) {
    case "bulking":
    case "bulk":
    case "gain":
    case "mass":
      return 3000;
    case "cutting":
    case "cut":
    case "lose":
    case "loss":
      return 1800;
    case "maintenance":
    case "maintain":
      return 2200;
    default:
      return 2200;
  }
}

function defaultProteinTarget(goal: string): number {
  switch (goal.toLowerCase()) {
    case "bulking":
    case "bulk":
    case "gain":
    case "mass":
      return 180;
    case "cutting":
    case "cut":
    case "lose":
    case "loss":
      return 150;
    case "maintenance":
    case "maintain":
      return 140;
    default:
      return 140;
  }
}

function buildFoodAnalysisPrompt(
  userGoal: string,
  calorieTarget: number,
  proteinTarget: number,
  plateDiameterCM?: number,
  foodRegionsJSON?: string
): string {
  let prompt =
    "You are SHealth's food analysis AI. Analyze this food photo and return a JSON object with each food item's name, estimated portion size in grams, calories, protein_g, carbs_g, fat_g, and an item_confidence of high/medium/low \u2014 plus a totals object and a calorie_range with low and high estimates. Only identify foods you can clearly see \u2014 never guess hidden ingredients like bacon or cheese unless visually confirmed. Use the plate as a scale reference assuming a standard 26.7cm dinner plate, and estimate portions relative to it. When portion size is uncertain, err 5-10% high on calories. Include a hidden_additions object estimating cooking oils or sauces with a brief note. ";

  // LiDAR / AR depth data paragraph (optional)
  if (plateDiameterCM && foodRegionsJSON) {
    prompt += `AR depth data is available \u2014 the plate measures ${plateDiameterCM.toFixed(1)}cm in diameter and the following food regions were detected with estimated volumes: ${foodRegionsJSON}. Use these volumes as ground truth for portion sizing, converting to weight using density estimates (meat ~1.0 g/mL, vegetables ~0.6 g/mL, grains ~0.85 g/mL, starches ~0.9 g/mL). When volume data is present, default to high confidence. `;
  }

  prompt += `Finally include a health_profile_notes string with one actionable sentence about this meal relative to the user's goal of ${userGoal} and daily target of ${calorieTarget} kcal and ${proteinTarget}g protein. Return only valid JSON, no markdown or preamble.`;

  return prompt;
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

    // Resolve user profile values with defaults
    const userGoal = body.userGoal || "maintenance";
    const calorieTarget = body.calorieTarget || defaultCalorieTarget(userGoal);
    const proteinTarget = body.proteinTarget || defaultProteinTarget(userGoal);

    const prompt = buildFoodAnalysisPrompt(
      userGoal,
      calorieTarget,
      proteinTarget,
      body.plateDiameterCM,
      body.foodRegionsJSON
    );

    const response = await anthropic.messages.create({
      model: MODEL_FAST,
      max_tokens: 1500,
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
