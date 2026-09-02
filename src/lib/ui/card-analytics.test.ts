import { describe, expect, it } from "vitest";
import { cardEventLabel } from "./card-analytics";

describe("cardEventLabel", () => {
  it.each([
    ["view", "Viewed"],
    ["link_click", "Clicked link"],
    ["vcard_download", "Saved vCard"],
    ["share", "Shared"],
  ])("names %s as %s", (type, label) => {
    expect(cardEventLabel(type)).toBe(label);
  });

  it("shows an event type it has no name for rather than hiding the row", () => {
    expect(cardEventLabel("qr_scan")).toBe("qr_scan");
  });

  it("does not fall back for the empty string in a way that blanks the row", () => {
    expect(cardEventLabel("")).toBe("");
  });

  it("is case-sensitive, so a differently-cased type is passed through", () => {
    expect(cardEventLabel("View")).toBe("View");
  });
});
