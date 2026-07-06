// Mobile API — meetings companion for the Rork iOS app.
// POST /api/mobile/meetings with a discriminated `kind`:
//   { kind: "upcoming" }
//     -> { ok, calendar_access, events: [...] }  (next 14 days, all inboxes)
//   { kind: "set_exclusion", account_id, calendar_event_id, excluded }
//     -> { ok }  (skip / re-include one event for auto-record)
//   { kind: "in_person_create", title?, ext }
//     -> { ok, id, audio_path }  (meeting row + storage path to upload to)
//   { kind: "in_person_transcribe", id, audio_path }
//     -> { ok, status }  (record the upload, transcribe and summarize)
// All handlers run as the calling user via their Supabase bearer token, so
// RLS scopes every read/write exactly like the web app's server functions.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest } from "@/lib/mobile-auth.server";
import { logError } from "@/lib/log.server";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upcoming") }),
  z.object({
    kind: z.literal("set_exclusion"),
    account_id: z.string().uuid(),
    calendar_event_id: z.string().min(1).max(1024),
    excluded: z.boolean(),
  }),
  z.object({
    kind: z.literal("in_person_create"),
    title: z.string().max(200).optional(),
    ext: z.enum(["webm", "m4a", "mp4", "ogg", "wav"]).default("m4a"),
  }),
  z.object({
    kind: z.literal("in_person_transcribe"),
    id: z.string().uuid(),
    audio_path: z.string().max(300),
  }),
]);

type Body = z.infer<typeof bodySchema>;
type Auth = Awaited<ReturnType<typeof authenticateRequest>>;

/** Upcoming events (next 14 days) across every calendar-enabled inbox —
 *  the same merged list the web's Upcoming tab renders. */
async function handleUpcoming({ supabase, userId }: Auth): Promise<Response> {
  const { data: accounts } = await supabase
    .from("gmail_accounts")
    .select("id, email_address, calendar_access")
    .eq("calendar_access", true);

  if (!accounts || accounts.length === 0) {
    return Response.json({ ok: true, calendar_access: false, events: [] });
  }

  const { listUpcomingCalendarEventsForAccount } = await import(
    "@/lib/meetings-autojoin.server"
  );
  const events: Record<string, unknown>[] = [];
  for (const acct of accounts) {
    try {
      const accountEvents = await listUpcomingCalendarEventsForAccount(acct.id, userId);
      for (const e of accountEvents) {
        events.push({
          id: e.id,
          title: e.title,
          start: e.start,
          has_meeting_link: e.hasMeetingLink,
          scheduled: e.scheduled,
          excluded: e.excluded,
          blocked: e.blocked,
          blocked_by: e.blockedBy,
          account_id: acct.id,
          account_email: acct.email_address ?? null,
        });
      }
    } catch (e) {
      // One broken inbox shouldn't hide everyone else's calendar.
      logError("mobile_meetings_upcoming_failed", { accountId: acct.id, userId }, e);
    }
  }
  events.sort((a, b) => String(a.start ?? "").localeCompare(String(b.start ?? "")));
  return Response.json({ ok: true, calendar_access: true, events });
}

/** Exclude (or re-include) one calendar event from auto-record. */
async function handleSetExclusion(
  { supabase, userId }: Auth,
  body: Extract<Body, { kind: "set_exclusion" }>,
): Promise<Response> {
  const { data: acct } = await supabase
    .from("gmail_accounts")
    .select("id")
    .eq("id", body.account_id)
    .maybeSingle();
  if (!acct) {
    return Response.json({ ok: false, error: "Account not found" }, { status: 404 });
  }

  if (body.excluded) {
    const { error } = await supabase.from("meeting_autojoin_exclusions").upsert(
      {
        user_id: userId,
        gmail_account_id: body.account_id,
        calendar_event_id: body.calendar_event_id,
      },
      { onConflict: "user_id,calendar_event_id" },
    );
    if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  } else {
    const { error } = await supabase
      .from("meeting_autojoin_exclusions")
      .delete()
      .eq("user_id", userId)
      .eq("calendar_event_id", body.calendar_event_id);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  }
  return Response.json({ ok: true });
}

/** Create the meeting row for an in-person recording and hand back the
 *  storage path the phone should upload the audio file to. */
async function handleInPersonCreate(
  { supabase, userId }: Auth,
  body: Extract<Body, { kind: "in_person_create" }>,
): Promise<Response> {
  const { data: inserted, error } = await supabase
    .from("meetings")
    .insert({
      user_id: userId,
      meeting_url: null,
      platform: "in_person",
      source: "in_person",
      status: "processing",
      title: body.title?.trim() || "In-person meeting",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });

  return Response.json({
    ok: true,
    id: inserted.id,
    audio_path: `${userId}/${inserted.id}.${body.ext}`,
  });
}

/** After the phone uploaded the audio, record its path then transcribe and
 *  summarize — the same finalize step the web recorder uses. */
async function handleInPersonTranscribe(
  { supabase, userId }: Auth,
  body: Extract<Body, { kind: "in_person_transcribe" }>,
): Promise<Response> {
  const { data: meeting } = await supabase
    .from("meetings")
    .select("id, source")
    .eq("id", body.id)
    .maybeSingle();
  if (!meeting) {
    return Response.json({ ok: false, error: "Meeting not found" }, { status: 404 });
  }
  if (!body.audio_path.startsWith(`${userId}/`)) {
    return Response.json({ ok: false, error: "Invalid audio path" }, { status: 400 });
  }

  const { error: updErr } = await supabase
    .from("meetings")
    .update({ audio_storage_path: body.audio_path, status: "processing" })
    .eq("id", body.id);
  if (updErr) return Response.json({ ok: false, error: updErr.message }, { status: 400 });

  // Dynamic import keeps the service-role module strictly server-side.
  const { finalizeInPersonMeeting } = await import("@/lib/meetings.server");
  const status = await finalizeInPersonMeeting(body.id);
  return Response.json({ ok: true, status });
}

export const Route = createFileRoute("/api/mobile/meetings")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let auth: Auth;
        try {
          auth = await authenticateRequest(request);
        } catch (r) {
          if (r instanceof Response) return r;
          return new Response("Unauthorized", { status: 401 });
        }

        let body: Body;
        try {
          body = bodySchema.parse(await request.json());
        } catch {
          return new Response("Invalid request body", { status: 400 });
        }

        try {
          switch (body.kind) {
            case "upcoming":
              return await handleUpcoming(auth);
            case "set_exclusion":
              return await handleSetExclusion(auth, body);
            case "in_person_create":
              return await handleInPersonCreate(auth, body);
            case "in_person_transcribe":
              return await handleInPersonTranscribe(auth, body);
          }
        } catch (e) {
          logError("mobile_meetings_failed", { userId: auth.userId, kind: body.kind }, e);
          return Response.json(
            { ok: false, error: (e as Error)?.message ?? "Request failed" },
            { status: 400 },
          );
        }
      },
    },
  },
});
