import { Phone } from "lucide-react";
import { validatePhoneNumber } from "@/lib/contacts/phone";
import { EntriesEditor } from "./EntriesEditor";

export type PhoneEntry = {
  label: string;
  number: string;
  is_primary: boolean;
};

const LABEL_OPTIONS = ["mobile", "work", "home", "other"] as const;

function validate(raw: string): string | null {
  const r = validatePhoneNumber(raw);
  return r.ok ? null : r.reason;
}

type Props = {
  value: PhoneEntry[];
  onChange: (next: PhoneEntry[]) => void;
};

export function PhonesEditor({ value, onChange }: Props) {
  return (
    <EntriesEditor<PhoneEntry>
      value={value}
      onChange={onChange}
      heading="Phones"
      headingIcon={<Phone className="h-3.5 w-3.5" />}
      labelOptions={LABEL_OPTIONS}
      defaultLabel="mobile"
      valueOf={(p) => p.number}
      withValue={(_p, number, is_primary, label) => ({ label, number, is_primary })}
      inputType="tel"
      placeholder="+1 555 123 4567"
      emptyText="No phone numbers yet."
      addLabel="Add phone"
      noun="phone"
      validate={validate}
    />
  );
}
