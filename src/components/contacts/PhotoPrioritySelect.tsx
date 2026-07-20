import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  setContactPhotoPriority,
  setCompanyPhotoPriority,
} from "@/lib/contacts/photo-priority.functions";

export type PhotoPriorityValue = "company_first" | "personal_first" | "personal_only";
export type PhotoPrioritySource = "contact" | "company" | "global" | "default";

const LABELS: Record<PhotoPriorityValue, string> = {
  company_first: "Company photo first",
  personal_first: "Personal photo first",
  personal_only: "Personal photo only",
};

const SOURCE_LABEL: Record<PhotoPrioritySource, string> = {
  contact: "this contact",
  company: "the company",
  global: "your global default",
  default: "the default",
};

type SharedProps = {
  effective: PhotoPriorityValue;
  source: PhotoPrioritySource;
  onChanged: () => void;
};

function PrioritySelect({
  value,
  onChange,
  effective,
  source,
  disabled,
}: {
  value: PhotoPriorityValue | null;
  onChange: (v: PhotoPriorityValue | null) => Promise<void>;
  effective: PhotoPriorityValue;
  source: PhotoPrioritySource;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<PhotoPriorityValue | "">(value ?? "");
  const handle = async (next: PhotoPriorityValue | "") => {
    setLocal(next);
    setBusy(true);
    try {
      await onChange(next === "" ? null : next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update");
      setLocal(value ?? "");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <label className="whitespace-nowrap">Photo shown:</label>
      <select
        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        value={local}
        onChange={(e) => handle(e.target.value as PhotoPriorityValue | "")}
        disabled={disabled || busy}
      >
        <option value="">Inherit ({LABELS[effective]})</option>
        <option value="company_first">{LABELS.company_first}</option>
        <option value="personal_first">{LABELS.personal_first}</option>
        <option value="personal_only">{LABELS.personal_only}</option>
      </select>
      <span className="text-[11px]">
        Currently: {LABELS[effective]} · from {SOURCE_LABEL[source]}
      </span>
    </div>
  );
}

export function ContactPhotoPrioritySelect({
  contactId,
  override,
  effective,
  source,
  onChanged,
}: SharedProps & {
  contactId: string;
  override: PhotoPriorityValue | null | undefined;
}) {
  const qc = useQueryClient();
  const setContact = useServerFn(setContactPhotoPriority);
  return (
    <PrioritySelect
      value={override ?? null}
      effective={effective}
      source={source}
      onChange={async (priority) => {
        await setContact({ data: { contactId, priority } });
        onChanged();
        qc.invalidateQueries({ queryKey: ["contact", contactId] });
      }}
    />
  );
}

export function CompanyPhotoPrioritySelect({
  companyId,
  override,
  effective,
  source,
  onChanged,
}: SharedProps & {
  companyId: string;
  override: PhotoPriorityValue | null | undefined;
}) {
  const setCompany = useServerFn(setCompanyPhotoPriority);
  return (
    <PrioritySelect
      value={override ?? null}
      effective={effective}
      source={source}
      onChange={async (priority) => {
        await setCompany({ data: { companyId, priority } });
        onChanged();
      }}
    />
  );
}
