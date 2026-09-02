/** Labelled form field wrapper shared by the contacts detail view, the
 * add-contacts dialog, and the company page (previously three private
 * near-identical helpers).
 *
 * The control is nested INSIDE the label element rather than sitting beside
 * a `<Label>` with no `htmlFor`: that gave 6 of the 8 add-contact inputs no
 * accessible name at all, so a screen reader announced them as bare edit
 * boxes and clicking the caption did not focus anything. Nesting associates
 * the two implicitly, whatever the control renders — which matters because
 * these wrap an Input, a Textarea and a combobox that does not forward an
 * `id` prop. Each Field holds exactly one control, which is what makes
 * nesting the right tool here.
 */
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
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </span>
      {children}
    </label>
  );
}
