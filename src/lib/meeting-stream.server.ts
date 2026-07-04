// Server-only helpers for signing short-lived meeting-recording stream URLs.
// The <video> element can't send an Authorization header, so we mint an HMAC
// token (over meetingId + expiry) that the public streaming route verifies.
import { createHmac, timingSafeEqual } from "crypto";

const DEFAULT_TTL_SECONDS = 60 * 60 * 2; // 2 hours — long enough to watch.

function secret(): string {
  const s = process.env.MEETING_STREAM_SECRET;
  if (!s) throw new Error("MEETING_STREAM_SECRET is not configured");
  return s;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(meetingId: string, exp: number): string {
  return base64url(createHmac("sha256", secret()).update(`${meetingId}.${exp}`).digest());
}

/** Build a same-origin, tokenized stream path for one meeting recording. */
export function buildRecordingStreamPath(meetingId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = sign(meetingId, exp);
  const params = new URLSearchParams({ m: meetingId, e: String(exp), t: token });
  return `/api/public/meeting-recording?${params.toString()}`;
}

/** Verify a stream token. Returns true only when the signature and expiry hold. */
export function verifyRecordingStreamToken(
  meetingId: string,
  exp: number,
  token: string,
): boolean {
  if (!meetingId || !Number.isFinite(exp) || !token) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const expected = sign(meetingId, exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
