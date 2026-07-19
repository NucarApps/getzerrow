// Mobile API — contacts companion for the Rork iOS app.
// POST /api/mobile/contacts with a discriminated `kind`:
//   { kind: "scan", image_data_url }
//     -> { ok, draft }    (same AI extraction as the web's card scanner)
//   { kind: "create", email, name?, ..., phones? }
//     -> { ok, contact }  (same upsert + encrypted-field path as the web)
// Auth: the user's Supabase bearer token, exactly like the other mobile routes.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest } from "@/lib/mobile-auth.server";
import { logError } from "@/lib/log.server";

const PHONE_NUMBER_RE = /^[+\d\s().,#x/A-Za-z-]{3,60}$/;

const phoneSchema = z.object({
  label: z.string().trim().min(1).max(20),
  number: z.string().trim().min(3).max(60).regex(PHONE_NUMBER_RE, "Invalid phone format"),
  is_primary: z.boolean().optional(),
});

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scan"),
    image_data_url: z
      .string()
      .min(64)
      .max(15_000_000)
      .regex(/^data:image\//, "Must be a data URL"),
  }),
  z.object({
    kind: z.literal("create"),
    email: z.string().trim().toLowerCase().email().max(255),
    name: z.string().max(200).nullable().optional(),
    title: z.string().max(200).nullable().optional(),
    company: z.string().max(200).nullable().optional(),
    phone: z.string().max(60).nullable().optional(),
    website: z.string().max(500).nullable().optional(),
    linkedin: z.string().max(500).nullable().optional(),
    twitter: z.string().max(500).nullable().optional(),
    address_line1: z.string().trim().max(200).nullable().optional(),
    address_line2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    region: z.string().trim().max(120).nullable().optional(),
    postal_code: z.string().trim().max(40).nullable().optional(),
    country: z.string().trim().max(60).nullable().optional(),
    card_image_url: z
      .string()
      .max(500)
      .regex(/^[A-Za-z0-9_\-/.]+$/)
      .nullable()
      .optional(),
    phones: z.array(phoneSchema).max(20).optional(),
  }),
]);

type Body = z.infer<typeof bodySchema>;
type Auth = Awaited<ReturnType<typeof authenticateRequest>>;

/** Run the card photo through the shared AI extraction and hand back the draft. */
async function handleScan(body: Extract<Body, { kind: "scan" }>): Promise<Response> {
  const { extractCardDraft } = await import("@/lib/card-scan.server");
  const draft = await extractCardDraft(body.image_data_url);
  return Response.json({ ok: true, draft });
}

/** Save the reviewed draft as a contact (upsert on user+email). */
async function handleCreate(
  auth: Auth,
  body: Extract<Body, { kind: "create" }>,
): Promise<Response> {
  const { saveScannedContact } = await import("@/lib/card-scan.server");
  const { contact } = await saveScannedContact(auth.userId, {
    email: body.email,
    name: body.name,
    title: body.title,
    company: body.company,
    phone: body.phone,
    website: body.website,
    linkedin: body.linkedin,
    twitter: body.twitter,
    address_line1: body.address_line1,
    address_line2: body.address_line2,
    city: body.city,
    region: body.region,
    postal_code: body.postal_code,
    country: body.country,
    card_image_url: body.card_image_url,
    phones: body.phones,
  });
  return Response.json({ ok: true, contact });
}

export const Route = createFileRoute("/api/mobile/contacts")({
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
            case "scan":
              return await handleScan(body);
            case "create":
              return await handleCreate(auth, body);
          }
        } catch (e) {
          logError("mobile_contacts_failed", { userId: auth.userId, kind: body.kind }, e);
          return Response.json(
            { ok: false, error: (e as Error)?.message ?? "Request failed" },
            { status: 400 },
          );
        }
      },
    },
  },
});
