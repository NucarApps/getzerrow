import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listMyGmailAccounts } from "@/lib/gmail.functions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Mail } from "lucide-react";

type Account = { id: string; email_address: string };

type Props = {
  value: string | null;
  onChange: (accountId: string, email: string) => void;
  label?: string;
};

export function AccountPicker({ value, onChange, label = "Account" }: Props) {
  const listAccounts = useServerFn(listMyGmailAccounts);
  const q = useQuery({
    queryKey: ["gmail-accounts"],
    queryFn: () => listAccounts(),
  });
  const accounts = useMemo(() => (q.data?.accounts ?? []) as Account[], [q.data?.accounts]);

  // Auto-select the first account if none is selected, or if the current
  // selection is no longer valid (e.g. account was just disconnected).
  useEffect(() => {
    if (accounts.length === 0) return;
    if (!value || !accounts.some((a) => a.id === value)) {
      const first = accounts[0];
      onChange(first.id, first.email_address);
    }
  }, [accounts, value, onChange]);

  if (accounts.length <= 1) return null;

  const current = accounts.find((a) => a.id === value);

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
      <Mail className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <Select
        value={current?.id ?? ""}
        onValueChange={(id) => {
          const a = accounts.find((x) => x.id === id);
          if (a) onChange(a.id, a.email_address);
        }}
      >
        <SelectTrigger className="h-8 flex-1 text-sm">
          <SelectValue placeholder="Pick an account" />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.email_address}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
