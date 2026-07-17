import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const TaskSelect =
  "id, title, notes, status, due_at, source, source_meeting_id, source_email_id, source_snippet, completed_at, dismissed_at, created_at, updated_at";

export const listTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        status: z.enum(["open", "done", "dismissed", "all"]).optional().default("open"),
        source: z.enum(["manual", "meeting", "email", "all"]).optional().default("all"),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("tasks")
      .select(TaskSelect)
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.source !== "all") q = q.eq("source", data.source);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const { data: sugg } = await context.supabase
      .from("task_completion_suggestions")
      .select("id, task_id, sent_email_id, confidence, reasoning, status, created_at")
      .eq("user_id", context.userId)
      .eq("status", "pending");

    return { tasks: rows ?? [], suggestions: sugg ?? [] };
  });

export const listTasksForMeeting = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ meetingId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("tasks")
      .select(TaskSelect)
      .eq("user_id", context.userId)
      .eq("source_meeting_id", data.meetingId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { tasks: rows ?? [] };
  });

export const listTasksForEmail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ emailId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("tasks")
      .select(TaskSelect)
      .eq("user_id", context.userId)
      .eq("source_email_id", data.emailId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { tasks: rows ?? [] };
  });

export const createTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        title: z.string().trim().min(1).max(500),
        notes: z.string().trim().max(4000).nullish(),
        due_at: z.string().datetime().nullish(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("tasks")
      .insert({
        user_id: context.userId,
        title: data.title,
        notes: data.notes ?? null,
        due_at: data.due_at ?? null,
        source: "manual",
      })
      .select(TaskSelect)
      .single();
    if (error) throw new Error(error.message);
    return { task: row };
  });

export const updateTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        title: z.string().trim().min(1).max(500).optional(),
        notes: z.string().trim().max(4000).nullish(),
        due_at: z.string().datetime().nullish(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: {
      title?: string;
      notes?: string | null;
      due_at?: string | null;
    } = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.notes !== undefined) patch.notes = data.notes ?? null;
    if (data.due_at !== undefined) patch.due_at = data.due_at ?? null;
    const { error } = await context.supabase
      .from("tasks")
      .update(patch)
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const completeTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const reopenTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("tasks")
      .update({ status: "open", completed_at: null, dismissed_at: null })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const dismissTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("tasks")
      .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("tasks")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const confirmCompletionSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: sugg, error: e1 } = await context.supabase
      .from("task_completion_suggestions")
      .select("task_id")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (e1) throw new Error(e1.message);
    if (!sugg) throw new Error("Suggestion not found");

    await context.supabase
      .from("task_completion_suggestions")
      .update({ status: "confirmed" })
      .eq("id", data.id)
      .eq("user_id", context.userId);

    const { error } = await context.supabase
      .from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", sugg.task_id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const dismissCompletionSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("task_completion_suggestions")
      .update({ status: "dismissed" })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
