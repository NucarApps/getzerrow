import { cn } from "@/lib/utils";

type Props = {
  /** Error message from the server's best-effort AI pass; renders nothing when absent. */
  error: string | null | undefined;
  className?: string;
};

// Server messages that are config internals get product-friendly copy; the
// raw text is already logged server-side.
const FRIENDLY_MESSAGES: Record<string, string> = {
  "Missing LOVABLE_API_KEY": "AI is not configured for this deployment",
};

/** Inline notice shown near a "use AI" toggle when the AI pass failed and
 * only rule-based results are displayed. */
export function AiUnavailableNote({ error, className }: Props) {
  if (!error) return null;
  return (
    <p role="status" className={cn("text-xs text-destructive", className)}>
      AI review unavailable: {FRIENDLY_MESSAGES[error] ?? error} — showing rule-based matches only.
    </p>
  );
}
