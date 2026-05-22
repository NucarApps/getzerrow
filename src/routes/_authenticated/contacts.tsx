import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Users, ScanLine, Search, IdCard, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listContacts, backfillContacts } from "@/lib/contacts.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/contacts")({
  head: () => ({
    meta: [
      { title: "Contacts — Zerrow" },
      { name: "description", content: "People you've emailed with, enriched from signatures." },
    ],
  }),
  component: ContactsPage,
});

function ContactsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useServerFn(listContacts);
  const build = useServerFn(backfillContacts);

  const [query, setQuery] = useState("");
  const [building, setBuilding] = useState(false);

  const q = useQuery({ queryKey: ["contacts"], queryFn: () => list() });

  // Auto-backfill once if the list is empty.
  useEffect(() => {
    if (q.data && q.data.contacts.length === 0 && !building) {
      setBuilding(true);
      build()
        .then((r) => {
          if (r.added > 0) toast.success(`Built ${r.added} contacts from your inbox`);
          qc.invalidateQueries({ queryKey: ["contacts"] });
        })
        .catch((e) => toast.error(e?.message ?? "Failed to build contacts"))
        .finally(() => setBuilding(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.contacts.length]);

  const filtered = useMemo(() => {
    const c = q.data?.contacts ?? [];
    if (!query.trim()) return c;
    const t = query.toLowerCase();
    return c.filter((x) =>
      (x.name ?? "").toLowerCase().includes(t) ||
      x.email.toLowerCase().includes(t) ||
      (x.company ?? "").toLowerCase().includes(t)
    );
  }, [q.data, query]);

  async function rebuild() {
    setBuilding(true);
    try {
      const r = await build();
      toast.success(`Added ${r.added} new contacts`);
      qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <header className="mb-6 flex flex-wrap items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
            <Users className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-[200px]">
            <h1 className="font-display text-2xl text-foreground">Contacts</h1>
            <p className="text-xs text-muted-foreground">
              {q.data ? `${q.data.contacts.length} people` : "Loading…"}
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/my-card"><IdCard className="mr-2 h-4 w-4" /> My card</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/contacts/scan"><ScanLine className="mr-2 h-4 w-4" /> Scan card</Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={rebuild} disabled={building}>
            <RefreshCw className={`mr-2 h-4 w-4 ${building ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </header>

        <div className="mb-4 relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or company…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {q.isLoading || building ? (
          <div className="grid gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-md border border-border bg-card/40" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {query ? "No matches." : "No contacts yet — they'll appear as you receive email."}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border bg-card/40">
            {filtered.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => navigate({ to: "/contacts/$id", params: { id: c.id } })}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40"
                >
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                    {(c.name || c.email).slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{c.name || c.email}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.company ? `${c.company} · ` : ""}{c.email}
                    </div>
                  </div>
                  {c.source === "scan" && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                      scanned
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
