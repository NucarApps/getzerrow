import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Plus, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { listCompanies, createCompany } from "@/lib/companies/companies.functions";
import { CompanyLogo } from "@/components/contacts/CompanyLogo";
import { CompanyDuplicatesDrawer } from "@/components/contacts/CompanyDuplicatesDrawer";

export const Route = createFileRoute("/_authenticated/contacts/companies/")({
  head: () => ({
    meta: [
      { title: "Companies — Zerrow" },
      {
        name: "description",
        content: "Manage the companies your contacts belong to.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CompaniesListPage,
});

function CompaniesListPage() {
  const fetchList = useServerFn(listCompanies);
  const createFn = useServerFn(createCompany);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["companies", "list"],
    queryFn: () => fetchList(),
  });
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [dupOpen, setDupOpen] = useState(false);

  const createMut = useMutation({
    mutationFn: (name: string) => createFn({ data: { name } }),
    onSuccess: () => {
      toast.success("Company created");
      setNewName("");
      qc.invalidateQueries({ queryKey: ["companies"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const term = search.trim().toLowerCase();
  const companies = (q.data?.companies ?? []).filter((c) =>
    term ? c.name.toLowerCase().includes(term) : true,
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/contacts">
              <ArrowLeft className="mr-2 h-4 w-4" /> Contacts
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold">Companies</h1>
          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={() => setDupOpen(true)}>
              <Sparkles className="mr-2 h-4 w-4" /> Find duplicates
            </Button>
          </div>
        </div>
        <CompanyDuplicatesDrawer open={dupOpen} onOpenChange={setDupOpen} />

        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search companies"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="New company name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) createMut.mutate(newName.trim());
              }}
            />
            <Button
              onClick={() => createMut.mutate(newName.trim())}
              disabled={!newName.trim() || createMut.isPending}
            >
              <Plus className="mr-2 h-4 w-4" /> New
            </Button>
          </div>
        </div>

        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!q.isLoading && companies.length === 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No companies yet. Add one above or set a company on a contact.
          </div>
        )}

        <ul className="divide-y rounded-lg border">
          {companies.map((c) => {
            const primary = c.domains[0]?.domain ?? null;
            return (
              <li key={c.id}>
                <Link
                  to="/contacts/companies/$companyId"
                  params={{ companyId: c.id }}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted"
                >
                  <CompanyLogo domain={primary} name={c.name} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {primary ?? "No domain yet"}
                      {c.industry ? ` · ${c.industry}` : ""}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>
                      {c.member_count} contact{c.member_count === 1 ? "" : "s"}
                    </div>
                    <div>
                      {c.domains.length} domain{c.domains.length === 1 ? "" : "s"}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
