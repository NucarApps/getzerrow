import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  listCompanyLogoChoices,
  setCompanyLogoChoice,
  clearCompanyLogoChoice,
} from "@/lib/company-logo.functions";
import { searchLogoBrands, type LogoBrand } from "@/lib/logo-search.functions";
import { LOGO_PROVIDER_LABELS } from "@/lib/logo-providers";
import { logoCandidates } from "@/lib/company-domains";

/**
 * Self-contained logo chooser for a company, keyed by its primary domain.
 * Used by both the company detail page and the CompanyAliasesDialog so the
 * two management surfaces stay in sync. Renders a brand-name search plus
 * per-domain provider tiles; selection persists via company-logo choices.
 */
export function CompanyLogoPicker({
  primaryDomain,
  aliases = [],
  initialQuery = "",
  enabled = true,
}: {
  primaryDomain: string;
  aliases?: string[];
  initialQuery?: string;
  enabled?: boolean;
}) {
  const qc = useQueryClient();
  const listChoices = useServerFn(listCompanyLogoChoices);
  const setChoiceFn = useServerFn(setCompanyLogoChoice);
  const clearChoiceFn = useServerFn(clearCompanyLogoChoice);
  const searchBrandsFn = useServerFn(searchLogoBrands);

  const [busy, setBusy] = useState(false);
  const [brandQuery, setBrandQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    setBrandQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(brandQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [brandQuery]);

  const choicesQ = useQuery({
    queryKey: ["company-logo-choices"],
    queryFn: () => listChoices(),
    enabled,
  });
  const currentRow = choicesQ.data?.find((c) => c.domain === primaryDomain);
  const currentProvider = currentRow?.provider ?? null;
  const currentSource = currentRow?.source_domain ?? null;

  const brandsQ = useQuery({
    queryKey: ["logo-brand-search", debouncedQuery],
    queryFn: () => searchBrandsFn({ data: { query: debouncedQuery } }),
    enabled: enabled && debouncedQuery.length >= 2,
    staleTime: 60_000,
  });

  async function pickLogo(provider: number | null, sourceDomain: string) {
    setBusy(true);
    try {
      if (provider === null && sourceDomain === primaryDomain) {
        await clearChoiceFn({ data: { domain: primaryDomain } });
      } else {
        const p = provider ?? 0;
        await setChoiceFn({ data: { domain: primaryDomain, provider: p, sourceDomain } });
      }
      qc.invalidateQueries({ queryKey: ["company-logo-choices"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save logo choice");
    } finally {
      setBusy(false);
    }
  }

  async function pickBrand(brand: LogoBrand) {
    setBusy(true);
    try {
      await setChoiceFn({
        data: { domain: primaryDomain, provider: 0, sourceDomain: brand.domain },
      });
      toast.success(`Using ${brand.name} logo`);
      qc.invalidateQueries({ queryKey: ["company-logo-choices"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save logo choice");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card/40 p-2.5">
        <Input
          value={brandQuery}
          onChange={(e) => setBrandQuery(e.target.value)}
          placeholder="Search logos by company name"
          disabled={busy}
        />
        {debouncedQuery.length >= 2 && (
          <div className="mt-2">
            {brandsQ.isFetching ? (
              <p className="text-[11px] text-muted-foreground">Searching…</p>
            ) : (brandsQ.data?.results.length ?? 0) === 0 ? (
              <p className="text-[11px] text-muted-foreground">No matches.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {brandsQ.data!.results.map((b) => {
                  const selected = currentSource === b.domain && currentProvider === 0;
                  return (
                    <button
                      key={b.domain}
                      type="button"
                      onClick={() => pickBrand(b)}
                      disabled={busy}
                      title={`${b.name} (${b.domain})`}
                      aria-pressed={selected}
                      className={`relative grid aspect-square place-items-center overflow-hidden rounded-md border bg-white p-1.5 transition disabled:opacity-50 ${
                        selected
                          ? "border-primary ring-2 ring-primary/40"
                          : "border-border hover:border-primary/60"
                      }`}
                    >
                      <img
                        src={logoCandidates(b.domain, 256, 0)[0]}
                        alt={b.name}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-contain"
                      />
                      {selected && (
                        <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
                          <Check className="h-3 w-3" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="space-y-3">
        {[primaryDomain, ...aliases].map((d) => {
          const isActiveSource = (currentSource ?? primaryDomain) === d;
          return (
            <div key={d}>
              <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="truncate">{d}</span>
                {d === primaryDomain && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                    primary
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {d === primaryDomain && (
                  <LogoTile
                    label="Auto"
                    domain={d}
                    provider={null}
                    selected={isActiveSource && currentProvider === null}
                    disabled={busy}
                    onSelect={() => pickLogo(null, d)}
                  />
                )}
                {LOGO_PROVIDER_LABELS.map((label, i) => (
                  <LogoTile
                    key={`${d}-${i}`}
                    label={label}
                    domain={d}
                    provider={i}
                    selected={isActiveSource && currentProvider === i}
                    disabled={busy}
                    onSelect={() => pickLogo(i, d)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Tiles that can't load are hidden. Auto picks the first one that works on the primary domain.
      </p>
    </div>
  );
}

type TileProps = {
  label: string;
  domain: string;
  provider: number | null;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
};

function LogoTile({ label, domain, provider, selected, disabled, onSelect }: TileProps) {
  const [failed, setFailed] = useState(false);
  if (provider !== null && failed) return null;

  const src =
    provider === null ? logoCandidates(domain, 256)[0] : logoCandidates(domain, 256, provider)[0];

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      title={label}
      aria-pressed={selected}
      className={`relative grid aspect-square place-items-center overflow-hidden rounded-md border bg-white p-1.5 transition disabled:opacity-50 ${
        selected ? "border-primary ring-2 ring-primary/40" : "border-border hover:border-primary/60"
      }`}
    >
      <img
        src={src}
        alt={label}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full object-contain"
      />
      {selected && (
        <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-3 w-3" />
        </span>
      )}
    </button>
  );
}
