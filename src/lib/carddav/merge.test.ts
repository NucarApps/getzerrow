import { describe, expect, it } from "vitest";
import { buildCardDavContactPatch } from "./merge";
import { parseVCard } from "./vcard";

const userId = "11111111-1111-1111-1111-111111111111";
const nowIso = "2026-07-18T13:45:00.000Z";

function parsedCard(body: string) {
  const parsed = parseVCard(body);
  if (!parsed) throw new Error("Expected a vCard");
  return parsed;
}

describe("buildCardDavContactPatch", () => {
  it("preserves an existing email when a follow-up iOS card omits EMAIL", () => {
    const parsed = parsedCard(
      "BEGIN:VCARD\r\n" +
        "VERSION:3.0\r\n" +
        "UID:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r\n" +
        "FN:Chanell Dagesse\r\n" +
        "TEL;TYPE=HOME:1 (302) 745-0507\r\n" +
        "END:VCARD\r\n",
    );

    const merge = buildCardDavContactPatch({
      userId,
      existing: { email: "chanelldagesse@gmail.com", source: "google" },
      parsed,
      nowIso,
    });

    expect(merge.patch).not.toHaveProperty("email");
    expect(merge.emailDecision).toBe("missing_existing_contact");
  });

  it("preserves an existing email when a client sends a blank EMAIL field", () => {
    const parsed = parsedCard(
      "BEGIN:VCARD\r\n" +
        "VERSION:3.0\r\n" +
        "UID:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r\n" +
        "FN:Chanell Dagesse\r\n" +
        "EMAIL;TYPE=INTERNET;TYPE=pref:\r\n" +
        "END:VCARD\r\n",
    );
    // Simulate a parser/client shape where EMAIL presence leaks through as a
    // defensive handler-level regression guard.
    parsed.presentFields.add("EMAIL");

    const merge = buildCardDavContactPatch({
      userId,
      existing: { email: "chanelldagesse@gmail.com", source: "google" },
      parsed,
      nowIso,
    });

    expect(merge.patch).not.toHaveProperty("email");
    expect(merge.emailDecision).toBe("blank_preserved_existing");
    expect(merge.preservedEmailOverBlank).toBe(true);
  });

  it("accepts a real iOS email edit", () => {
    const parsed = parsedCard(
      "BEGIN:VCARD\r\n" +
        "VERSION:3.0\r\n" +
        "UID:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r\n" +
        "FN:Chanell Dagesse\r\n" +
        "item1.EMAIL;TYPE=INTERNET;TYPE=pref:ChanellDagesse@Gmail.com\r\n" +
        "item1.X-ABLabel:_$!<Work>!$_\r\n" +
        "END:VCARD\r\n",
    );

    const merge = buildCardDavContactPatch({
      userId,
      existing: { email: null, source: "google" },
      parsed,
      nowIso,
    });

    expect(merge.patch.email).toBe("chanelldagesse@gmail.com");
    expect(merge.emailDecision).toBe("accepted_value");
  });

  it("does not re-accept legacy placeholder addresses from stale iOS cache", () => {
    const parsed = parsedCard(
      "BEGIN:VCARD\r\n" +
        "VERSION:3.0\r\n" +
        "UID:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r\n" +
        "FN:Chanell Dagesse\r\n" +
        "EMAIL;TYPE=INTERNET;TYPE=pref:carddav+aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@local.zerrow\r\n" +
        "END:VCARD\r\n",
    );

    const merge = buildCardDavContactPatch({
      userId,
      existing: { email: "chanelldagesse@gmail.com", source: "google" },
      parsed,
      nowIso,
    });

    expect(merge.patch).not.toHaveProperty("email");
    expect(merge.emailDecision).toBe("blank_preserved_existing");
  });
});
