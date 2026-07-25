/**
 * Escape a value for interpolation into a SQL `LIKE`/`ILIKE` pattern.
 *
 * `%`, `_` and `\` are pattern metacharacters. Interpolating a raw value that
 * contains them silently widens the match — a domain like `foo_bar.com` would
 * also match `fooXbar.com` — so every caller that builds a pattern from
 * user-controlled or parsed input must run the value through this first.
 *
 * Backslash is PostgreSQL's default LIKE escape character.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
