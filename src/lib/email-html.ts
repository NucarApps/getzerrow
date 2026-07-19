/** True when the HTML has any user-visible text once tags/styles/scripts
 * and whitespace entities are stripped. Used to decide whether to render
 * an email's HTML body or fall back to plain text. */
export function hasVisibleHtml(html: string | null | undefined): boolean {
  return (
    (html ?? "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;|\s/g, "").length > 0
  );
}
