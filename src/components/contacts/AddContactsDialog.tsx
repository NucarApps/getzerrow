// Add-contacts dialog: manual entry, or bulk-pick people from inbox senders
// or calendar meetings. The inbox and meetings tabs share one PeoplePicker
// (search + select-all + checkbox list + footer) — they used to be two
// ~100-line near-identical copies inside contacts.index.tsx.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { UserPlus, Inbox, CalendarClock, Search, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  createContactManual,
  listFoldersForPicker,
  listUniqueInboxSenders,
  bulkCreateContactsFromEmails,
} from "@/lib/contacts.functions";
import { listMeetingPeople } from "@/lib/calendar.functions";
import { Field } from "./Field";

type PickerPerson = {
  email: string;
  name: string | null;
  /** Secondary line under the name (defaults to the email). */
  secondary?: string;
  /** Small right-aligned meta lines (message count, dates…). */
  metaRight?: string[];
};

/** Shared bulk-picker body: search box, select-all row, checkbox list, and
 * the Add/Cancel footer. Tab-specific scope controls (folder chips, past/
 * upcoming toggle) render above it via `children`. */
function PeoplePicker({
  items,
  loading,
  loadingText,
  emptyContent,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  selected,
  onToggle,
  onSelectAllVisible,
  adding,
  onCancel,
  onSubmit,
}: {
  items: PickerPerson[];
  loading: boolean;
  loadingText: string;
  emptyContent: React.ReactNode;
  searchValue: string;
  onSearchChange: (v: string) => void;
  searchPlaceholder: string;
  selected: Set<string>;
  onToggle: (email: string) => void;
  onSelectAllVisible: () => void;
  adding: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const allVisibleSelected = items.length > 0 && items.every((s) => selected.has(s.email));
  return (
    <>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={searchPlaceholder}
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <button
          onClick={onSelectAllVisible}
          disabled={items.length === 0}
          className="underline-offset-2 hover:underline disabled:opacity-50"
        >
          {allVisibleSelected ? "Unselect all" : "Select all visible"}
        </button>
        <span>{selected.size} selected</span>
      </div>

      <div className="flex-1 min-h-[200px] max-h-[40vh] overflow-y-auto rounded-md border border-border bg-card/40">
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground">{loadingText}</div>
        ) : items.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{emptyContent}</div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((s) => (
              <li key={s.email}>
                <button
                  onClick={() => onToggle(s.email)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
                >
                  <Checkbox
                    checked={selected.has(s.email)}
                    onCheckedChange={() => onToggle(s.email)}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {s.name || s.email}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {s.secondary ?? s.email}
                    </div>
                  </div>
                  {s.metaRight && s.metaRight.length > 0 && (
                    <div className="text-right text-[11px] text-muted-foreground shrink-0">
                      {s.metaRight.map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={adding || selected.size === 0}>
          {adding
            ? "Adding…"
            : `Add ${selected.size || ""} ${selected.size === 1 ? "contact" : "contacts"}`}
        </Button>
      </DialogFooter>
    </>
  );
}

export function AddContactsDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const createManual = useServerFn(createContactManual);
  const listFolders = useServerFn(listFoldersForPicker);
  const listSenders = useServerFn(listUniqueInboxSenders);
  const listMeeting = useServerFn(listMeetingPeople);
  const bulkAdd = useServerFn(bulkCreateContactsFromEmails);

  const [tab, setTab] = useState<"manual" | "inbox" | "meetings">("manual");

  // Manual form state
  const [m, setM] = useState({
    email: "",
    name: "",
    title: "",
    company: "",
    phone: "",
    website: "",
    linkedin: "",
    twitter: "",
  });
  const [saving, setSaving] = useState(false);

  // Picker state (shared by the inbox + meetings tabs)
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [meetingWhen, setMeetingWhen] = useState<"past" | "upcoming">("past");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!open) {
      setM({
        email: "",
        name: "",
        title: "",
        company: "",
        phone: "",
        website: "",
        linkedin: "",
        twitter: "",
      });
      setFolderIds([]);
      setSearch("");
      setDebounced("");
      setSelected(new Set());
      setTab("manual");
      setMeetingWhen("past");
    }
  }, [open]);

  const foldersQ = useQuery({
    queryKey: ["folders-picker"],
    queryFn: () => listFolders(),
    enabled: open,
  });

  const sendersQ = useQuery({
    queryKey: ["inbox-senders", folderIds.join(","), debounced],
    queryFn: () =>
      listSenders({
        data: {
          folderIds: folderIds.length ? folderIds : undefined,
          search: debounced || undefined,
        },
      }),
    enabled: open && tab === "inbox",
  });

  const meetingsQ = useQuery({
    queryKey: ["meeting-people", meetingWhen, debounced],
    queryFn: () => listMeeting({ data: { when: meetingWhen, search: debounced || undefined } }),
    enabled: open && tab === "meetings",
  });

  async function submitManual() {
    if (!/.+@.+\..+/.test(m.email)) {
      toast.error("Enter a valid email");
      return;
    }
    setSaving(true);
    try {
      await createManual({
        data: {
          email: m.email,
          name: m.name || null,
          title: m.title || null,
          company: m.company || null,
          phone: m.phone || null,
          website: m.website || null,
          linkedin: m.linkedin || null,
          twitter: m.twitter || null,
        },
      });
      toast.success("Contact added");
      onAdded();
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Couldn't add contact");
    } finally {
      setSaving(false);
    }
  }

  function toggleFolder(id: string) {
    setFolderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function togglePerson(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  const senders = sendersQ.data?.senders ?? [];
  const meetingPeople = meetingsQ.data?.people ?? [];
  const meetingAccess = meetingsQ.data?.calendarAccess ?? true;

  // The list the picker currently shows (inbox senders or meeting people).
  const pickerItems: PickerPerson[] =
    tab === "meetings"
      ? meetingPeople.map((p) => ({
          email: p.email,
          name: p.name,
          secondary: p.eventTitle ? `${p.email} · ${p.eventTitle}` : p.email,
          metaRight: p.meetingAt ? [new Date(p.meetingAt).toLocaleDateString()] : [],
        }))
      : senders.map((s) => ({
          email: s.email,
          name: s.name,
          metaRight: [
            `${s.count} ${s.count === 1 ? "msg" : "msgs"}`,
            ...(s.lastReceivedAt ? [new Date(s.lastReceivedAt).toLocaleDateString()] : []),
          ],
        }));

  function selectAllVisible() {
    const allSelected = pickerItems.length > 0 && pickerItems.every((s) => selected.has(s.email));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of pickerItems) {
        if (allSelected) next.delete(s.email);
        else next.add(s.email);
      }
      return next;
    });
  }

  async function submitBulk() {
    if (selected.size === 0) return;
    const source = tab === "meetings" ? meetingPeople : senders;
    const items = source
      .filter((s) => selected.has(s.email))
      .map((s) => ({ email: s.email, name: s.name }));
    if (items.length === 0) return;
    setAdding(true);
    try {
      const r = await bulkAdd({ data: { items } });
      toast.success(`Added ${r.created} ${r.created === 1 ? "contact" : "contacts"}`);
      onAdded();
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Couldn't add contacts");
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Add contacts</DialogTitle>
          <DialogDescription>
            Enter someone manually, or pick from your inbox senders or calendar meetings.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setSelected(new Set());
            setSearch("");
            setDebounced("");
            setTab(v as typeof tab);
          }}
          className="flex-1 flex flex-col min-h-0"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="manual">
              <UserPlus className="mr-2 h-4 w-4" /> Manual
            </TabsTrigger>
            <TabsTrigger value="inbox">
              <Inbox className="mr-2 h-4 w-4" /> From inbox
            </TabsTrigger>
            <TabsTrigger value="meetings">
              <CalendarClock className="mr-2 h-4 w-4" /> From meetings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="manual" className="space-y-3 pt-3 overflow-y-auto">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email *">
                <Input
                  type="email"
                  value={m.email}
                  onChange={(e) => setM({ ...m, email: e.target.value })}
                  placeholder="person@example.com"
                  autoFocus
                />
              </Field>
              <Field label="Name">
                <Input
                  value={m.name}
                  onChange={(e) => setM({ ...m, name: e.target.value })}
                  placeholder="Jane Doe"
                />
              </Field>
              <Field label="Title">
                <Input value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} />
              </Field>
              <Field label="Company">
                <Input
                  value={m.company}
                  onChange={(e) => setM({ ...m, company: e.target.value })}
                />
              </Field>
              <Field label="Phone">
                <Input value={m.phone} onChange={(e) => setM({ ...m, phone: e.target.value })} />
              </Field>
              <Field label="Website">
                <Input
                  value={m.website}
                  onChange={(e) => setM({ ...m, website: e.target.value })}
                />
              </Field>
              <Field label="LinkedIn">
                <Input
                  value={m.linkedin}
                  onChange={(e) => setM({ ...m, linkedin: e.target.value })}
                />
              </Field>
              <Field label="Twitter / X">
                <Input
                  value={m.twitter}
                  onChange={(e) => setM({ ...m, twitter: e.target.value })}
                />
              </Field>
            </div>
            <DialogFooter className="pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={submitManual} disabled={saving || !m.email}>
                {saving ? "Adding…" : "Add contact"}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="inbox" className="flex flex-col min-h-0 pt-3 gap-3">
            <div>
              <Label className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">
                Search in folders
              </Label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setFolderIds([])}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${folderIds.length === 0 ? "border-foreground/40 bg-accent text-accent-foreground" : "border-border bg-card/60 text-muted-foreground hover:text-foreground"}`}
                >
                  All folders
                </button>
                {(foldersQ.data?.folders ?? []).map((f) => {
                  const on = folderIds.includes(f.id);
                  return (
                    <button
                      key={f.id}
                      onClick={() => toggleFolder(f.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${on ? "border-foreground/40 bg-accent text-accent-foreground" : "border-border bg-card/60 text-foreground hover:bg-accent/40"}`}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: f.color }} />
                      {f.name}
                      {on && <Check className="h-3 w-3" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <PeoplePicker
              items={pickerItems}
              loading={sendersQ.isLoading}
              loadingText="Loading senders…"
              emptyContent="No new senders found in this scope."
              searchValue={search}
              onSearchChange={setSearch}
              searchPlaceholder="Search senders by name or email…"
              selected={selected}
              onToggle={togglePerson}
              onSelectAllVisible={selectAllVisible}
              adding={adding}
              onCancel={() => onOpenChange(false)}
              onSubmit={submitBulk}
            />
          </TabsContent>

          <TabsContent value="meetings" className="flex flex-col min-h-0 pt-3 gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(["past", "upcoming"] as const).map((w) => (
                <button
                  key={w}
                  onClick={() => {
                    setMeetingWhen(w);
                    setSelected(new Set());
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${meetingWhen === w ? "border-foreground/40 bg-accent text-accent-foreground" : "border-border bg-card/60 text-muted-foreground hover:text-foreground"}`}
                >
                  {w === "past" ? "Past meetings" : "Upcoming meetings"}
                </button>
              ))}
            </div>

            <PeoplePicker
              items={pickerItems}
              loading={meetingAccess && meetingsQ.isLoading}
              loadingText="Loading people from your calendar…"
              emptyContent={
                !meetingAccess ? (
                  <>
                    Connect a Google account and enable calendar access in{" "}
                    <Link to="/settings" className="text-foreground underline underline-offset-2">
                      Settings
                    </Link>{" "}
                    to pull people from your meetings.
                  </>
                ) : (
                  `No new people found in your ${meetingWhen} meetings.`
                )
              }
              searchValue={search}
              onSearchChange={setSearch}
              searchPlaceholder="Search people by name or email…"
              selected={selected}
              onToggle={togglePerson}
              onSelectAllVisible={selectAllVisible}
              adding={adding}
              onCancel={() => onOpenChange(false)}
              onSubmit={submitBulk}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
