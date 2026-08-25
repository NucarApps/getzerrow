// Which engine decides (Phase E cutover switch).
//
//   "off"    — legacy decide-folder only.
//   "shadow" — legacy decides; the amended engine runs alongside and every
//              disagreement is logged. Default: zero behaviour change, full
//              visibility before the switch.
//   "on"     — the amended engine decides the deterministic stages and its
//              v2 trace is what gets stored.
//
// Read at call time, never at module scope: env injection happens per
// request in the worker runtime.
export type RulesEngineMode = "off" | "shadow" | "on";

export function rulesEngineMode(): RulesEngineMode {
  const raw = (process.env["RULES_ENGINE_V2"] ?? "").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return "on";
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  return "shadow";
}

export const rulesEngineDecides = (): boolean => rulesEngineMode() === "on";
export const rulesEngineShadows = (): boolean => rulesEngineMode() !== "off";
