// Authenticated server fns to trigger extraction on demand (also used by the
// UI to re-run extraction if the user asks). Extraction itself is
// idempotency-guarded by task_extraction_runs.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const extractTasksFromMeeting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ meetingId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: meeting, error } = await context.supabase
      .from("meetings")
      .select("id, transcript, summary")
      .eq("id", data.meetingId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!meeting) throw new Error("Meeting not found");

    const { data: profile } = await context.supabase.auth.getUser();
    const email = profile.user?.email ?? "";
    const meta = profile.user?.user_metadata as { full_name?: string; name?: string } | undefined;
    const names = [meta?.full_name, meta?.name, email].filter(Boolean) as string[];

    type Seg = { speaker?: string | null; text?: string | null };
    const segs = (meeting.transcript ?? []) as Seg[];
    const transcriptText = segs
      .map((s) => `${s.speaker ? `${s.speaker}: ` : ""}${s.text ?? ""}`)
      .join("\n")
      .trim() || (meeting.summary ?? "");

    const { extractTasksFromMeetingTranscript } = await import("./extract.server");
    const count = await extractTasksFromMeetingTranscript({
      userId: context.userId,
      meetingId: data.meetingId,
      transcriptText,
      userDisplayNames: names,
    });
    return { count };
  });
