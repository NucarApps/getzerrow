import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const createLovableAiGatewayProvider = (lovableApiKey: string) =>
  createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
  });

export const DEFAULT_AI_MODEL = "google/gemini-2.5-flash";

/** Build the Lovable AI gateway provider from the ambient API key. Throws if
 * `LOVABLE_API_KEY` is unset. Single home for what used to be copy-pasted
 * across ~17 AI callers. */
export function getGateway() {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  return createLovableAiGatewayProvider(key);
}

/** A model handle from the Lovable gateway, defaulting to the standard model. */
export function getModel(modelId: string = DEFAULT_AI_MODEL) {
  return getGateway()(modelId);
}
