import markAsset from "@/assets/atzro-mark.webp.asset.json";
import { cn } from "@/lib/utils";

/**
 * Atzro lockup — the iridescent ring mark plus the wordmark.
 *
 * The supplied logo file has a dark wordmark meant for light backgrounds, so the
 * word is rendered as text in the current foreground color instead. That keeps
 * the lockup legible on the dark app surface and on any light surface it lands
 * on later, and keeps the mark itself pixel-accurate.
 */
export function AtzroLogo({
  className,
  markClassName,
  wordClassName,
  showWord = true,
  alt = "Atzro",
}: {
  className?: string;
  markClassName?: string;
  wordClassName?: string;
  showWord?: boolean;
  alt?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <img
        src={markAsset.url}
        alt={showWord ? "" : alt}
        aria-hidden={showWord ? true : undefined}
        className={cn("h-full w-auto shrink-0", markClassName)}
      />
      {showWord ? (
        <span
          className={cn(
            "text-[0.62em] leading-none font-medium tracking-[-0.02em] lowercase",
            wordClassName,
          )}
        >
          atzro
        </span>
      ) : null}
    </span>
  );
}
