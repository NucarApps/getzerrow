import { createFileRoute, redirect, isRedirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { Shield, Mail, Users as UsersIcon, Inbox, AlertTriangle, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  getAdminMe,
  listAdminUsers,
  getAdminActivity,
  getFolderRetryMetrics,
  type AdminUser,
} from "@/lib/admin.functions";

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  Legend,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [{ title: "Admin — Zerrow" }, { name: "robots", content: "noindex" }],
  }),
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
    // Gate the page itself to admins only — non-admins never render the shell.
    try {
      await getAdminMe();
    } catch (e) {
      if (isRedirect(e)) throw e;
      throw redirect({ to: "/inbox" });
    }
  },
  component: AdminPage,
});

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 36e5;
}

function AdminPage() {
  const meFn = useServerFn(getAdminMe);
  const usersFn = useServerFn(listAdminUsers);
  const activityFn = useServerFn(getAdminActivity);

  // The route's beforeLoad already gated this page to admins, so the user
  // here is guaranteed to be an admin.
  const meQ = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => meFn(),
    retry: false,
  });

  const usersQ = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => usersFn(),
  });

  const activityQ = useQuery({
    queryKey: ["admin-activity", 30],
    queryFn: () => activityFn({ data: { days: 30 } }),
  });

  const totals = useMemo(() => {
    const users = usersQ.data?.users ?? [];
    let emails = 0;
    let contacts = 0;
    let connectedGmail = 0;
    for (const u of users) {
      emails += u.stats.emails;
      contacts += u.stats.contacts;
      if (u.gmail_accounts.length > 0) connectedGmail += 1;
    }
    return { users: users.length, emails, contacts, connectedGmail };
  }, [usersQ.data]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <header className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-display text-2xl text-foreground">Admin</h1>
            <p className="text-xs text-muted-foreground">Signed in as {meQ.data?.email ?? "…"}</p>
          </div>
        </header>

        {/* Summary cards */}
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<UsersIcon className="h-4 w-4" />}
            label="Users"
            value={totals.users}
            loading={usersQ.isLoading}
          />
          <StatCard
            icon={<Mail className="h-4 w-4" />}
            label="Gmail connected"
            value={totals.connectedGmail}
            loading={usersQ.isLoading}
          />
          <StatCard
            icon={<Inbox className="h-4 w-4" />}
            label="Emails ingested"
            value={totals.emails}
            loading={usersQ.isLoading}
          />
          <StatCard
            icon={<UsersIcon className="h-4 w-4" />}
            label="Contacts"
            value={totals.contacts}
            loading={usersQ.isLoading}
          />
        </div>

        {/* Activity charts */}
        <section className="mb-8 grid gap-4 lg:grid-cols-2">
          <ActivityChart
            title="Signups (last 30 days)"
            data={activityQ.data?.signups ?? []}
            loading={activityQ.isLoading}
            color="hsl(var(--primary))"
          />
          <ActivityChart
            title="Emails ingested (last 30 days)"
            data={activityQ.data?.emails ?? []}
            loading={activityQ.isLoading}
            color="#6bd1e0"
          />
        </section>

        {/* Users table */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Users
          </h2>
          <div className="overflow-x-auto rounded-md border border-border bg-card/40">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Email</th>
                  <th className="px-3 py-2 text-left">Signed up</th>
                  <th className="px-3 py-2 text-left">Last sign-in</th>
                  <th className="px-3 py-2 text-left">Gmail</th>
                  <th className="px-3 py-2 text-left">Last sync</th>
                  <th className="px-3 py-2 text-right">Emails</th>
                  <th className="px-3 py-2 text-right">Contacts</th>
                  <th className="px-3 py-2 text-right">Folders</th>
                  <th className="px-3 py-2 text-right">Jobs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {usersQ.isLoading && (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
                {!usersQ.isLoading && (usersQ.data?.users.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                      No users yet.
                    </td>
                  </tr>
                )}
                {(usersQ.data?.users ?? []).map((u) => (
                  <UserRow key={u.user_id} u={u} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  loading: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-card/40 p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-2 font-display text-2xl text-foreground">
        {loading ? "…" : value.toLocaleString()}
      </div>
    </div>
  );
}

function ActivityChart({
  title,
  data,
  loading,
  color,
}: {
  title: string;
  data: Array<{ date: string; count: number }>;
  loading: boolean;
  color: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card/40 p-4">
      <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="h-48">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={(v: string) => {
                  const d = new Date(v);
                  return `${d.getMonth() + 1}/${d.getDate()}`;
                }}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelFormatter={(v) => new Date(v as string | number).toLocaleDateString()}
              />
              <Line type="monotone" dataKey="count" stroke={color} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function UserRow({ u }: { u: AdminUser }) {
  const accounts = u.gmail_accounts;
  const jobs = u.stats.jobs_pending + u.stats.jobs_running;
  return (
    <tr className="hover:bg-accent/30 align-top">
      <td className="px-3 py-2 font-medium text-foreground">
        {u.email}
        {accounts.length > 1 && (
          <span className="ml-1 rounded bg-primary/15 px-1 text-[10px] text-primary">
            ×{accounts.length}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{fmtDate(u.created_at)}</td>
      <td className="px-3 py-2 text-muted-foreground">{fmtDateTime(u.last_sign_in_at)}</td>
      <td className="px-3 py-2">
        {accounts.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col gap-1">
            {accounts.map((g, i) => (
              <span
                key={`${g.email_address ?? "unknown"}-${i}`}
                className="inline-flex items-center gap-1 text-xs"
              >
                <Mail className="h-3 w-3 text-primary" /> {g.email_address ?? "—"}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {accounts.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col gap-1">
            {accounts.map((g, i) => {
              const last = g.last_push_at ?? g.last_poll_at;
              const hrs = hoursSince(last);
              const stale = hrs !== null && hrs > 24;
              return (
                <span
                  key={`${g.email_address ?? "unknown"}-${i}`}
                  className={`inline-flex items-center gap-1 text-xs ${stale ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {stale && <AlertTriangle className="h-3 w-3" />}
                  {fmtDateTime(last)}
                </span>
              );
            })}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{u.stats.emails.toLocaleString()}</td>
      <td className="px-3 py-2 text-right tabular-nums">{u.stats.contacts.toLocaleString()}</td>
      <td className="px-3 py-2 text-right tabular-nums">{u.stats.folders.toLocaleString()}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        <span
          title={`pending ${u.stats.jobs_pending} · running ${u.stats.jobs_running} · dlq ${u.stats.jobs_dlq}`}
        >
          {jobs.toLocaleString()}
          {u.stats.jobs_dlq > 0 && (
            <span className="ml-1 rounded bg-destructive/20 px-1 text-[10px] text-destructive">
              {u.stats.jobs_dlq} dlq
            </span>
          )}
        </span>
      </td>
    </tr>
  );
}
