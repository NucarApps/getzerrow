import { Label } from "@/components/ui/label";

/** Labelled form field wrapper shared by the contacts detail view, the
 * add-contacts dialog, and the company page (previously three private
 * near-identical helpers). */
export function Field({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </Label>
      {children}
    </div>
  );
}
