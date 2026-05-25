import { useEffect, useMemo, useState } from "react";
import { logoCandidates } from "@/lib/company-domains";
import { getLogoDominantColor } from "@/lib/logo-color";

type Props = {
  domain: string | null;
  name?: string | null;
  size?: number;
  className?: string;
  onColor?: (color: string | null) => void;
  /** Force a specific logo provider index from the proxy. */
  provider?: number | null;
  /** Fetch the logo image from a different domain than `domain` (e.g. an alias). */
  sourceDomain?: string | null;
};

/** Company logo with multi-provider fallback, then monogram. */
export function CompanyLogo({
  domain, name, size = 32, className = "", onColor, provider, sourceDomain,
}: Props) {
  const fetchDomain = sourceDomain ?? domain;
  const candidates = useMemo(
    () => (fetchDomain ? logoCandidates(fetchDomain, Math.max(256, size * 6), provider) : []),
    [fetchDomain, size, provider],
  );
  const [idx, setIdx] = useState(0);
  const initial = ((name || domain || "?").trim().charAt(0) || "?").toUpperCase();
  const px = `${size}px`;

  // Reset retry index when domain changes.
  useEffect(() => { setIdx(0); }, [fetchDomain, provider]);

  useEffect(() => {
    if (!onColor || !domain) return;
    let cancelled = false;
    getLogoDominantColor(domain).then((c) => { if (!cancelled) onColor(c); });
    return () => { cancelled = true; };
  }, [domain, onColor]);

  const exhausted = idx >= candidates.length;

  if (!domain || exhausted) {
    return (
      <div
        className={`grid shrink-0 place-items-center rounded-md bg-primary/15 font-semibold text-primary ${className}`}
        style={{ width: px, height: px, fontSize: `${Math.max(10, Math.round(size * 0.45))}px` }}
        aria-hidden
      >
        {initial}
      </div>
    );
  }

  return (
    <img
      key={candidates[idx]}
      src={candidates[idx]}
      width={size}
      height={size}
      alt={name ? `${name} logo` : `${domain} logo`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setIdx((i) => i + 1)}
      className={`shrink-0 rounded-md bg-white object-contain p-0.5 ring-1 ring-border/40 ${className}`}
      style={{ width: px, height: px }}
    />
  );
}
