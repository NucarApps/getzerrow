/** Shared schedule display helpers (non-component module so the editor
 * components stay fast-refresh friendly). */

export const browserTz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n);
}
