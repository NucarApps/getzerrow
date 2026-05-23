import { useEffect, useState } from "react";
import { logoUrl } from "@/lib/company-domains";
import { getLogoDominantColor } from "@/lib/logo-color";

type Props = {
  domain: string | null;
  name?: string | null;
  size?: number;
  className?: string;
  onColor?: (color: string | null) => void;
};

/** Company logo with monogram fallback on load error. */
export function CompanyLogo({ domain, name, size = 32, className = "", onColor }: Props) {
  const [failed, setFailed] = useState(false);
  const initial = ((name || domain || "?").trim().charAt(0) || "?").toUpperCase();
  const px = `${size}px`;

  useEffect(() => {
    if (!onColor || !domain || failed) return;
    let cancelled = false;
    getLogoDominantColor(domain).then((c) => { if (!cancelled) onColor(c); });
    return () => { cancelled = true; };
  }, [domain, failed, onColor]);

  if (!domain || failed) {
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
      src={logoUrl(domain, size * 2)}
      width={size}
      height={size}
      alt={name ? `${name} logo` : `${domain} logo`}
      loading="lazy"
      crossOrigin="anonymous"
      referrerPolicy="no-referrer"
      onError={() => { setFailed(true); onColor?.(null); }}
      className={`shrink-0 rounded-md bg-card object-contain ${className}`}
      style={{ width: px, height: px }}
    />
  );
}
