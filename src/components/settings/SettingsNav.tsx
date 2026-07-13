import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type NavItem = { label: string; to: string };
type NavGroup = { heading: string; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    heading: "Email",
    items: [
      { label: "Accounts", to: "/settings/accounts" },
      { label: "Inbox filters", to: "/settings/inbox" },
      { label: "Activity", to: "/settings/activity" },
    ],
  },
  {
    heading: "Meetings",
    items: [
      { label: "Recording", to: "/settings/meetings-recording" },
      { label: "Calendar", to: "/settings/meetings-calendar" },
    ],
  },
  {
    heading: "Account",
    items: [{ label: "General", to: "/settings/account" }],
  },
];

const ALL_ITEMS = GROUPS.flatMap((g) => g.items);

export function SettingsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <>
      {/* Mobile: single select */}
      <div className="md:hidden">
        <Select value={pathname} onValueChange={() => undefined}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ALL_ITEMS.map((item) => (
              <SelectItem key={item.to} value={item.to} asChild>
                <Link to={item.to}>{item.label}</Link>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: grouped rail */}
      <nav className="hidden md:block">
        <div className="space-y-6">
          {GROUPS.map((group) => (
            <div key={group.heading}>
              <p className="mb-1.5 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.heading}
              </p>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const active = pathname === item.to;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`rounded-md px-3 py-2 text-sm transition-colors ${
                        active
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}
