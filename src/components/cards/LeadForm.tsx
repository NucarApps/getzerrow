import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Send, CheckCircle2 } from "lucide-react";
import { submitCardLead } from "@/lib/cards.functions";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export function LeadForm({ handle, accentClass }: { handle: string; accentClass: string }) {
  const submit = useServerFn(submitCardLead);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", company: "", phone: "", message: "" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim()) {
      toast.error("Name and email are required");
      return;
    }
    setSending(true);
    try {
      await submit({ data: { handle, ...form } });
      setDone(true);
    } catch (err: any) {
      toast.error(err?.message ?? "Couldn't send. Try again.");
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <div className="mt-6 rounded-lg border border-border bg-card/60 p-5 text-center">
        <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-foreground" />
        <p className="text-sm font-medium text-foreground">Thanks — we'll be in touch.</p>
        <p className="mt-1 text-xs text-muted-foreground">Your details have been shared.</p>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 w-full rounded-md border border-dashed border-border bg-transparent px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
      >
        Leave your details
      </button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-4 space-y-2 rounded-lg border border-border bg-card/60 p-4"
    >
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Get in touch
      </p>
      <Input
        placeholder="Your name *"
        value={form.name}
        onChange={(v) => setForm({ ...form, name: v })}
        required
      />
      <Input
        placeholder="Email *"
        type="email"
        value={form.email}
        onChange={(v) => setForm({ ...form, email: v })}
        required
      />
      <div className="grid grid-cols-2 gap-2">
        <Input
          placeholder="Company"
          value={form.company}
          onChange={(v) => setForm({ ...form, company: v })}
        />
        <Input
          placeholder="Phone"
          value={form.phone}
          onChange={(v) => setForm({ ...form, phone: v })}
        />
      </div>
      <textarea
        placeholder="Message (optional)"
        value={form.message}
        onChange={(e) => setForm({ ...form, message: e.target.value })}
        rows={3}
        maxLength={1000}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={sending}
          className={cn(
            "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50",
            accentClass,
          )}
        >
          <Send className="h-4 w-4" /> {sending ? "Sending…" : "Send"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      required={required}
      maxLength={255}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}
