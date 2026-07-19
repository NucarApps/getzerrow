// End-to-end regression for the iOS CardDAV sync loop that repeatedly wiped
// an existing contact email. We replay the exact PUT-body shapes iOS sends
// (empty EMAIL, empty PREF EMAIL, grouped item labels, EMAIL omitted entirely)
// through parseVCard -> buildCardDavContactPatch and assert the server never
// nulls an email that has already been saved.

import { describe, expect, it } from "vitest";
import { parseVCard } from "./vcard";
import { buildCardDavContactPatch, type ExistingCardDavContact } from "./merge";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const UID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SAVED_EMAIL = "chanelldagesse@gmail.com";

function vcard(lines: string[]): string {
  return ["BEGIN:VCARD", "VERSION:3.0", `UID:${UID}`, ...lines, "END:VCARD", ""].join("\r\n");
}

function applyPut(existing: ExistingCardDavContact | null, body: string) {
  const parsed = parseVCard(body);
  if (!parsed) throw new Error("Expected a vCard");
  return buildCardDavContactPatch({
    userId: USER_ID,
    existing,
    parsed,
    nowIso: "2026-07-18T14:00:00.000Z",
  });
}

/** Reduce a merge result into the resulting stored email column. */
function nextEmail(existing: ExistingCardDavContact | null, body: string): string | null {
  const { patch } = applyPut(existing, body);
  return Object.prototype.hasOwnProperty.call(patch, "email")
    ? (patch.email ?? null)
    : (existing?.email ?? null);
}

describe("CardDAV iOS sync regression: existing email must never be nulled", () => {
  const putBodies: Array<{ name: string; body: string }> = [
    {
      name: "follow-up card without any EMAIL line",
      body: vcard(["FN:Chanell Dagesse", "TEL;TYPE=CELL:+13027450507"]),
    },
    {
      name: "EMAIL line with blank value",
      body: vcard(["FN:Chanell Dagesse", "EMAIL;TYPE=INTERNET:"]),
    },
    {
      name: "PREF EMAIL line with blank value",
      body: vcard(["FN:Chanell Dagesse", "EMAIL;TYPE=INTERNET;TYPE=pref:"]),
    },
    {
      name: "grouped iOS item.EMAIL with blank value",
      body: vcard([
        "FN:Chanell Dagesse",
        "item1.EMAIL;TYPE=INTERNET;TYPE=pref:",
        "item1.X-ABLabel:_$!<Work>!$_",
      ]),
    },
    {
      name: "legacy carddav+uuid placeholder from stale iOS cache",
      body: vcard([
        "FN:Chanell Dagesse",
        `EMAIL;TYPE=INTERNET;TYPE=pref:carddav+${UID}@local.zerrow`,
      ]),
    },
    {
      name: "card containing only name/phone (typical iOS partial resync)",
      body: vcard(["FN:Chanell Dagesse", "N:Dagesse;Chanell;;;", "TEL;TYPE=HOME:302-745-0507"]),
    },
  ];

  const existing: ExistingCardDavContact = { email: SAVED_EMAIL, source: "google" };

  for (const { name, body } of putBodies) {
    it(`preserves saved email when iOS sends ${name}`, () => {
      expect(nextEmail(existing, body)).toBe(SAVED_EMAIL);
    });
  }

  it("still accepts a real email edit after a blank follow-up (full loop)", () => {
    // 1. iOS resends a blank card (network hiccup / partial sync).
    let currentEmail = nextEmail(
      existing,
      vcard(["FN:Chanell Dagesse", "EMAIL;TYPE=INTERNET;TYPE=pref:"]),
    );
    expect(currentEmail).toBe(SAVED_EMAIL);

    // 2. User edits the email on the phone; iOS pushes the real value.
    currentEmail = nextEmail(
      { email: currentEmail, source: "google" },
      vcard([
        "FN:Chanell Dagesse",
        "item1.EMAIL;TYPE=INTERNET;TYPE=pref:ChanellDagesse@Gmail.com",
        "item1.X-ABLabel:_$!<Work>!$_",
      ]),
    );
    expect(currentEmail).toBe("chanelldagesse@gmail.com");

    // 3. iOS follows up with another partial card. Email must survive.
    currentEmail = nextEmail(
      { email: currentEmail, source: "google" },
      vcard(["FN:Chanell Dagesse", "TEL;TYPE=CELL:+13027450507"]),
    );
    expect(currentEmail).toBe("chanelldagesse@gmail.com");
  });

  it("brand new contact with no EMAIL line stores null email", () => {
    // Regression guard: preservation must NOT accidentally invent an email
    // for a contact that never had one.
    const result = applyPut(null, vcard(["FN:New Person", "TEL;TYPE=CELL:+15551234567"]));
    expect(result.patch.email ?? null).toBeNull();
  });
});
