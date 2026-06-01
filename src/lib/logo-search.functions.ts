import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type LogoBrand = { name: string; domain: string };

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export const searchLogoBrands = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ query: z.string().trim().min(2).max(50) }).parse(input),
  )
  .handler(async ({ data }): Promise<{ results: LogoBrand[] }> => {
    const secret = process.env.LOGO_DEV_SECRET;
    if (!secret) return { results: [] };
    try {
      const res = await fetch(`https://api.logo.dev/search?q=${encodeURIComponent(data.query)}`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return { results: [] };
      const json: unknown = await res.json();
      const arr = Array.isArray(json) ? json : [];
      const results: LogoBrand[] = [];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const name = typeof rec.name === "string" ? rec.name : null;
        const domain = typeof rec.domain === "string" ? rec.domain.toLowerCase() : null;
        if (!name || !domain || !DOMAIN_RE.test(domain)) continue;
        results.push({ name, domain });
        if (results.length >= 10) break;
      }
      return { results };
    } catch {
      return { results: [] };
    }
  });
