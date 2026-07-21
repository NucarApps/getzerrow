import { Mail } from "lucide-react";
import { isValidEmailAddress } from "@/lib/contacts/email-address";
import { EntriesEditor } from "./EntriesEditor";

export type EmailEntry = {
  label: string;
  address: string;
  is_primary: boolean;
};

const LABEL_OPTIONS = ["work", "home", "other"] as const;

// Display-level check only (the save path still trims/filters): flags rows
// that would sync a junk address to CardDAV/Google. Mirrors PhonesEditor's
// inline validation, which this editor previously lacked entirely.
function validateEmail(raw: string): string | null {
  return isValidEmailAddress(raw) ? null : "Enter a valid email address";
}

type Props = {
  value: EmailEntry[];
  onChange: (next: EmailEntry[]) => void;
};

export function EmailsEditor({ value, onChange }: Props) {
  return (
    <EntriesEditor<EmailEntry>
      value={value}
      onChange={onChange}
      heading="Emails"
      headingIcon={<Mail className="h-3.5 w-3.5" />}
      labelOptions={LABEL_OPTIONS}
      defaultLabel="work"
      valueOf={(e) => e.address}
      withValue={(_e, address, is_primary, label) => ({ label, address, is_primary })}
      inputType="email"
      placeholder="name@example.com"
      emptyText="No email addresses yet."
      addLabel="Add email"
      noun="email"
      validate={validateEmail}
    />
  );
}
