// Single accessor for the symmetric encryption key (EMAIL_ENC_KEY) that the
// SECURITY DEFINER encrypt/decrypt RPCs take as `p_key`. Keeping the env read
// and the "not configured" guard in one place means the key column can be
// rotated or the guard tightened without hunting through every RPC call site.
export function emailEncKey(): string {
  const key = process.env.EMAIL_ENC_KEY;
  if (!key) throw new Error("EMAIL_ENC_KEY not configured");
  return key;
}
