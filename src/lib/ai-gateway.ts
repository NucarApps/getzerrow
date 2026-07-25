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

/**
 * Flatten a provider/model error into one loggable line.
 *
 * Model SDK errors carry the useful detail on non-standard fields (`status`,
 * `responseBody`) that `String(e)` throws away, which is what makes a failed
 * cascade attempt diagnosable. Four near-identical copies of this lived in
 * ai.server (twice), card-scan.server, and contacts/scan.functions; this is the
 * superset — the two that omitted `responseBody` were the lossy ones.
 */
export function describeError(e: unknown): string {
  const err = e as {
    name?: unknown;
    status?: unknown;
    message?: unknown;
    responseBody?: unknown;
  };
  const parts: string[] = [];
  if (typeof err?.name === "string") parts.push(err.name);
  if (typeof err?.status === "number") parts.push(`status=${err.status}`);
  if (typeof err?.message === "string") parts.push(err.message);
  if (err?.responseBody != null) parts.push(`body=${String(err.responseBody).slice(0, 200)}`);
  return parts.join(" | ").slice(0, 400) || "unknown error";
}
