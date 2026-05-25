// Gmail historyId comparison.
//
// Gmail history IDs are unsigned 64-bit decimals stored as TEXT. Two
// gotchas this helper handles:
//   1. Text comparison lies at digit-length transitions: "9" > "10"
//      lexicographically but 9 < 10 numerically.
//   2. JavaScript Number loses precision past 2^53; some Gmail mailboxes
//      can have history IDs exceeding that.
//
// The SQL counterpart is `bump_history_id_if_greater()`, which uses
// numeric comparison and must agree with this function. Tests pin
// boundary behavior on both sides.

/** True iff `incoming` is strictly greater than `current`. Returns true
 * when current is null (any real id beats "no id yet") and false when
 * incoming is null. Uses BigInt for the comparison so 64-bit values
 * don't lose precision. Falls back to length+lex if either input
 * contains non-decimals (defensive — Gmail always returns decimal). */
export function gmailHistoryIdGreater(incoming: string | null, current: string | null): boolean {
  if (!incoming) return false;
  if (!current) return true;
  if (/^\d+$/.test(incoming) && /^\d+$/.test(current)) {
    try {
      return BigInt(incoming) > BigInt(current);
    } catch {
      /* fall through */
    }
  }
  if (incoming.length !== current.length) return incoming.length > current.length;
  return incoming > current;
}
