// Mobile API — meetings companion for the Rork iOS app.
// POST /api/mobile/meetings with a discriminated `kind`:
//   { kind: "upcoming" }
//     -> { ok, calendar_access, events: [...] }  (next 14 days, all inboxes)
//   { kind: "set_exclusion", account_id, calendar_event_id, excluded }
//     -> { ok }  (legacy on/off switch — kept for older app builds)
//   { kind: "set_mode", account_id, calendar_event_id, mode }
//     -> { ok }  (three-way choice: "bot" | "in_person" | "off")
//   { kind: "in_person_create", title?, ext, calendar_event_id?, account_id?, scheduled_start? }
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
  z.object({ kind: z.literal("calendar") }),
  z.object({
    kind: z.literal("set_exclusion"),
    account_id: z.string().uuid(),
    calendar_event_id: z.string().min(1).max(1024),
    excluded: z.boolean(),
  }),
  z.object({
    kind: z.literal("set_mode"),
    account_id: z.string().uuid(),
    calendar_event_id: z.string().min(1).max(1024),
    mode: z.enum(["bot", "in_person", "off"]),
  }),
  z.object({
    kind: z.literal("in_person_create"),
    title: z.string().max(200).optional(),
    ext: z.enum(["webm", "m4a", "mp4", "ogg", "wav"]).default("m4a"),
    // Optional link back to the calendar meeting this recording captures.
    calendar_event_id: z.string().min(1).max(1024).optional(),
    account_id: z.string().uuid().optional(),
    scheduled_start: z
      .string()
      .max(64)
      .refine((v) => !Number.isNaN(Date.parse(v)))
      .optional(),
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

  const { listUpcomingCalendarEventsForAccount } = await import("@/lib/meetings-autojoin.server");
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
          record_mode: e.recordMode,
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

/** Every calendar event from the past 7 days through the next 14 days across
 *  each calendar-enabled inbox, annotated with its recording plan — the same
 *  window the web meetings page shows. */
async function handleCalendar({ supabase, userId }: Auth): Promise<Response> {
  const { data: accounts } = await supabase
    .from("gmail_accounts")
    .select("id, email_address, calendar_access")
    .eq("calendar_access", true);

  if (!accounts || accounts.length === 0) {
    return Response.json({ ok: true, calendar_access: false, events: [] });
  }

  const { listCalendarEventsWindow } = await import("@/lib/meetings-autojoin.server");
  const events: Record<string, unknown>[] = [];
  for (const acct of accounts) {
    try {
      const accountEvents = await listCalendarEventsWindow(acct.id, userId, 7, 14);
      for (const e of accountEvents) {
        events.push({
          id: e.id,
          title: e.title,
          start: e.start,
          end: e.end,
          has_meeting_link: e.hasMeetingLink,
          scheduled: e.scheduled,
          excluded: e.excluded,
          record_mode: e.recordMode,
          blocked: e.blocked,
          blocked_by: e.blockedBy,
          declined: e.declined,
          will_record: e.willRecord,
          skip_reason: e.skipReason,
          meeting_id: e.meetingId,
          meeting_status: e.meetingStatus,
          has_recording: e.hasRecording,
          account_id: acct.id,
          account_email: acct.email_address ?? null,
        });
      }
    } catch (e) {
      // One broken inbox shouldn't hide everyone else's calendar.
      logError("mobile_meetings_calendar_failed", { accountId: acct.id, userId }, e);
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
    const { upsertEventExclusion } = await import("@/lib/meetings-autojoin.server");
    const errorMessage = await upsertEventExclusion(
      supabase,
      { userId, accountId: body.account_id, calendarEventId: body.calendar_event_id },
      "off",
    );
    if (errorMessage) return Response.json({ ok: false, error: errorMessage }, { status: 400 });
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

/** Three-way capture choice for one calendar event: bot, in-person, or off.
 *  "bot" removes the exclusion row; the other two upsert it with the mode. */
async function handleSetMode(
  { supabase, userId }: Auth,
  body: Extract<Body, { kind: "set_mode" }>,
): Promise<Response> {
  const { data: acct } = await supabase
    .from("gmail_accounts")
    .select("id")
    .eq("id", body.account_id)
    .maybeSingle();
  if (!acct) {
    return Response.json({ ok: false, error: "Account not found" }, { status: 404 });
  }

  if (body.mode === "bot") {
    const { error } = await supabase
      .from("meeting_autojoin_exclusions")
      .delete()
      .eq("user_id", userId)
      .eq("calendar_event_id", body.calendar_event_id);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  } else {
    const { upsertEventExclusion } = await import("@/lib/meetings-autojoin.server");
    const errorMessage = await upsertEventExclusion(
      supabase,
      { userId, accountId: body.account_id, calendarEventId: body.calendar_event_id },
      body.mode,
    );
    if (errorMessage) return Response.json({ ok: false, error: errorMessage }, { status: 400 });
  }
  return Response.json({ ok: true, mode: body.mode });
}

/** Create the meeting row for an in-person recording and hand back the
 *  storage path the phone should upload the audio file to. */
async function handleInPersonCreate(
  { supabase, userId }: Auth,
  body: Extract<Body, { kind: "in_person_create" }>,
): Promise<Response> {
  // If the recording is tied to a calendar event, confirm account ownership.
  if (body.account_id) {
    const { data: acct } = await supabase
      .from("gmail_accounts")
      .select("id")
      .eq("id", body.account_id)
      .maybeSingle();
    if (!acct) {
      return Response.json({ ok: false, error: "Account not found" }, { status: 404 });
    }
  }

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
      gmail_account_id: body.account_id ?? null,
      calendar_event_id: body.calendar_event_id ?? null,
      scheduled_start: body.scheduled_start ? new Date(body.scheduled_start).toISOString() : null,
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
            case "calendar":
              return await handleCalendar(auth);
            case "set_exclusion":
              return await handleSetExclusion(auth, body);
            case "set_mode":
              return await handleSetMode(auth, body);
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
