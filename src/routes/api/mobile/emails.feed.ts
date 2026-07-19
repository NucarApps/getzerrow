// Mobile API — decrypted mail feed for the Zerrow iOS companion app.
// POST /api/mobile/emails/feed
//   { kind: "list", scope?, folder_id?, cursor?, limit? } → { ok, emails }
//   { kind: "detail", email_id } → { ok, email }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest } from "@/lib/mobile-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  getEmailsDecrypted,
  getEmailsListDecrypted,
  type EmailListRow,
  type EmailListScope,
} from "@/lib/sync/encrypted-reader";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("list"),
    scope: z.enum(["all", "all_mail", "no_rules", "folder"]).default("all"),
    folder_id: z.string().uuid().nullish(),
    cursor: z.string().nullish(),
    limit: z.number().int().min(1).max(500).default(300),
  }),
  z.object({
    kind: z.literal("detail"),
    email_id: z.string().uuid(),
  }),
]);

export const Route = createFileRoute("/api/mobile/emails/feed")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let userId: string;
        try {
          ({ userId } = await authenticateRequest(request));
        } catch (r) {
          if (r instanceof Response) return r;
          return new Response("Unauthorized", { status: 401 });
        }

        let body: z.infer<typeof bodySchema>;
        try {
          body = bodySchema.parse(await request.json());
        } catch {
          return new Response("Invalid request body", { status: 400 });
        }

        try {
          if (body.kind === "detail") {
            const { rows, error } = await getEmailsDecrypted([body.email_id]);
            if (error) throw new Error(error);
            const email = rows[0];
            if (!email || email.user_id !== userId) {
              return Response.json({ ok: false, error: "Email not found" }, { status: 404 });
            }
            return Response.json({ ok: true, email });
          }

          const { data: accounts, error: accountsError } = await supabaseAdmin
            .from("gmail_accounts")
            .select("id")
            .eq("user_id", userId);
          if (accountsError) throw new Error(accountsError.message);

          const scope: EmailListScope = body.scope;
          const perAccount = await Promise.all(
            (accounts ?? []).map(async (account) => {
              const { rows, error } = await getEmailsListDecrypted({
                accountId: account.id,
                userId,
                scope,
                folderId: body.folder_id ?? null,
                cursor: body.cursor ?? null,
                limit: body.limit,
              });
              if (error) throw new Error(error);
              return rows;
            }),
          );

          const emails: EmailListRow[] = perAccount
            .flat()
            .sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""))
            .slice(0, body.limit);

          return Response.json({ ok: true, emails });
        } catch (e) {
          return Response.json(
            { ok: false, error: (e as Error)?.message ?? "Mail feed failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
