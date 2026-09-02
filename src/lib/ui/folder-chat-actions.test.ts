import { describe, expect, it } from "vitest";
import {
  BOOL_LABELS,
  describeAction,
  describeSettings,
  settingsToLocalPatch,
  type FolderChatAction,
  type SettingsPatch,
} from "./folder-chat-actions";

/**
 * Every key the AI may propose, all set at once. Typed `Required` so adding a
 * key to `SettingsPatch` without adding it here is a compile error — which is
 * how the two exhaustiveness tests below stay honest as the type grows.
 */
const EVERY_SETTING: Required<SettingsPatch> = {
  name: "Newsletters",
  color: "#ff0000",
  priority: 3,
  auto_archive: true,
  auto_mark_read: false,
  auto_star: true,
  hide_from_inbox: false,
  skip_ai: true,
  overrides_inbox_override: false,
  is_cold_email: true,
  forward_to: "ops@example.com",
  snooze_hours: 4,
  min_ai_confidence: 0.75,
  filter_logic: "all",
};

/**
 * A settings blob as it arrives from the model: JSON that claims to be a
 * `SettingsPatch` but has not been validated against it. The describe/patch
 * pair has to survive keys and value types the model made up.
 */
function unvalidatedSettings(raw: Record<string, unknown>): SettingsPatch {
  return raw as SettingsPatch;
}

function settingsAction(settings: SettingsPatch): FolderChatAction {
  return { type: "update_folder_settings", settings, why: "because" };
}

describe("describeSettings", () => {
  it("says nothing about a patch that sets nothing", () => {
    expect(describeSettings({})).toStrictEqual([]);
  });

  it("describes every key of a fully-populated patch", () => {
    expect(describeSettings(EVERY_SETTING)).toStrictEqual([
      'Rename to "Newsletters"',
      "Set color to #ff0000",
      "Set priority to 3",
      "Turn on auto-archive",
      "Turn off auto mark-read",
      "Turn on auto-star",
      "Turn off hide from inbox",
      "Turn on rules only",
      'Turn off beat "always send to inbox"',
      "Turn on cold-email folder",
      "Auto-forward to ops@example.com",
      "Snooze on arrival for 4h",
      "Set min AI confidence to 75%",
      "Match all filters",
    ]);
  });

  it("leaves no settings key without a sentence", () => {
    // A key the AI can set but the user is never shown is a change approved
    // blind — so the sentence count has to keep up with the type.
    expect(describeSettings(EVERY_SETTING)).toHaveLength(Object.keys(EVERY_SETTING).length);
  });

  it.each(Object.entries(BOOL_LABELS))("describes %s in both directions", (key, label) => {
    expect(describeSettings({ [key]: true })).toStrictEqual([`Turn on ${label}`]);
    expect(describeSettings({ [key]: false })).toStrictEqual([`Turn off ${label}`]);
  });

  it("ignores a boolean key that is present but not a boolean", () => {
    // The proposal is JSON from a model; a string "true" is not a toggle.
    expect(describeSettings(unvalidatedSettings({ auto_archive: "yes" }))).toStrictEqual([]);
  });

  it("describes an empty forward_to as stopping the forward, not as forwarding nowhere", () => {
    expect(describeSettings({ forward_to: null })).toStrictEqual(["Stop auto-forwarding"]);
    expect(describeSettings({ forward_to: "" })).toStrictEqual(["Stop auto-forwarding"]);
  });

  it("describes a zero snooze as turning snooze off", () => {
    expect(describeSettings({ snooze_hours: 0 })).toStrictEqual(["Turn off snooze"]);
  });

  it("renders the AI confidence as a whole percentage", () => {
    expect(describeSettings({ min_ai_confidence: 0 })).toStrictEqual([
      "Set min AI confidence to 0%",
    ]);
    expect(describeSettings({ min_ai_confidence: 0.666 })).toStrictEqual([
      "Set min AI confidence to 67%",
    ]);
    expect(describeSettings({ min_ai_confidence: 1 })).toStrictEqual([
      "Set min AI confidence to 100%",
    ]);
  });

  it("describes both filter-logic values", () => {
    expect(describeSettings({ filter_logic: "any" })).toStrictEqual(["Match any filters"]);
    expect(describeSettings({ filter_logic: "all" })).toStrictEqual(["Match all filters"]);
  });

  it("describes a priority of zero rather than treating it as unset", () => {
    expect(describeSettings({ priority: 0 })).toStrictEqual(["Set priority to 0"]);
  });

  it("ignores keys it does not know about", () => {
    expect(describeSettings(unvalidatedSettings({ some_future_setting: true }))).toStrictEqual([]);
  });
});

describe("describeAction — add_filter", () => {
  it.each([
    ["contains", 'Add filter: from contains "acme"'],
    ["equals", 'Add filter: from equals "acme"'],
    ["starts_with", 'Add filter: from starts with "acme"'],
    ["not_contains", 'Add filter: from does not contain "acme"'],
    ["not_equals", 'Add filter: from does not equal "acme"'],
  ] as const)("renders the %s operator in words", (op, expected) => {
    expect(describeAction({ type: "add_filter", field: "from", op, value: "acme", why: "w" })).toBe(
      expected,
    );
  });

  it.each(["from", "domain", "subject"] as const)("names the %s field", (field) => {
    expect(
      describeAction({ type: "add_filter", field, op: "contains", value: "x", why: "w" }),
    ).toBe(`Add filter: ${field} contains "x"`);
  });

  it("renders domain_in as an allowlist with a comma-separated domain list", () => {
    expect(
      describeAction({
        type: "add_filter",
        field: "domain",
        op: "domain_in",
        value: "acme.com, beta.io",
        why: "w",
      }),
    ).toBe("Add allowlist: only mail from acme.com, beta.io");
  });

  it.each([
    ["spaces", "acme.com beta.io"],
    ["commas", "acme.com,beta.io"],
    ["semicolons", "acme.com;beta.io"],
    ["mixed separators and padding", "  acme.com ,; beta.io  "],
    ["newlines", "acme.com\nbeta.io"],
  ])("splits a domain_in list on %s", (_label, value) => {
    expect(
      describeAction({ type: "add_filter", field: "domain", op: "domain_in", value, why: "w" }),
    ).toBe("Add allowlist: only mail from acme.com, beta.io");
  });

  it("renders an empty domain_in list without stray separators", () => {
    expect(
      describeAction({ type: "add_filter", field: "domain", op: "domain_in", value: "", why: "w" }),
    ).toBe("Add allowlist: only mail from ");
  });
});

describe("describeAction — the other action kinds", () => {
  it("describes removing a filter without leaking the id", () => {
    expect(describeAction({ type: "remove_filter", filter_id: "f-1", why: "w" })).toBe(
      "Remove a filter",
    );
  });

  it("quotes the proposed AI rule so the user reads the exact text", () => {
    expect(describeAction({ type: "update_folder_rule", ai_rule: "Only invoices", why: "w" })).toBe(
      'Update AI rule: "Only invoices"',
    );
  });

  it("summarises a learned-profile rewrite rather than dumping it", () => {
    expect(
      describeAction({
        type: "update_folder_profile",
        learned_profile: "a very long profile",
        why: "w",
      }),
    ).toBe("Refine the learned profile");
  });

  it("joins several settings changes with a separator", () => {
    expect(describeAction(settingsAction({ auto_archive: true, priority: 2 }))).toBe(
      "Set priority to 2 · Turn on auto-archive",
    );
  });

  it("falls back to a generic sentence when the settings patch describes nothing", () => {
    expect(describeAction(settingsAction({}))).toBe("Update folder settings");
  });

  it("falls back to the generic sentence for an unrecognised settings key", () => {
    expect(describeAction(settingsAction(unvalidatedSettings({ future_key: 1 })))).toBe(
      "Update folder settings",
    );
  });
});

describe("settingsToLocalPatch", () => {
  it("returns an empty patch for no actions", () => {
    expect(settingsToLocalPatch([])).toStrictEqual({});
  });

  it("carries every settings key into the editor patch", () => {
    expect(settingsToLocalPatch([settingsAction(EVERY_SETTING)])).toStrictEqual(EVERY_SETTING);
  });

  it("drops no settings key on the way to the editor", () => {
    // A key the user approved but that never reaches the editor is a change
    // silently lost, so the key sets have to match exactly.
    expect(Object.keys(settingsToLocalPatch([settingsAction(EVERY_SETTING)])).sort()).toStrictEqual(
      Object.keys(EVERY_SETTING).sort(),
    );
  });

  it("only carries the keys the patch actually set", () => {
    expect(settingsToLocalPatch([settingsAction({ auto_star: false })])).toStrictEqual({
      auto_star: false,
    });
  });

  it("trims the folder name and the AI rule but not the colour", () => {
    expect(
      settingsToLocalPatch([
        settingsAction({ name: "  Receipts  ", color: " #fff " }),
        { type: "update_folder_rule", ai_rule: "  keep receipts  ", why: "w" },
      ]),
    ).toStrictEqual({ name: "Receipts", color: " #fff ", ai_rule: "keep receipts" });
  });

  it("trims the learned profile", () => {
    expect(
      settingsToLocalPatch([
        { type: "update_folder_profile", learned_profile: "\n a profile \n", why: "w" },
      ]),
    ).toStrictEqual({ learned_profile: "a profile" });
  });

  it("carries a null forward_to through as a clear, not as unset", () => {
    expect(settingsToLocalPatch([settingsAction({ forward_to: null })])).toStrictEqual({
      forward_to: null,
    });
  });

  it("carries falsy values that are still real settings", () => {
    expect(
      settingsToLocalPatch([
        settingsAction({ priority: 0, snooze_hours: 0, min_ai_confidence: 0, auto_archive: false }),
      ]),
    ).toStrictEqual({
      priority: 0,
      snooze_hours: 0,
      min_ai_confidence: 0,
      auto_archive: false,
    });
  });

  it("ignores actions that do not change the folder record", () => {
    expect(
      settingsToLocalPatch([
        { type: "add_filter", field: "from", op: "contains", value: "x", why: "w" },
        { type: "remove_filter", filter_id: "f-1", why: "w" },
      ]),
    ).toStrictEqual({});
  });

  it("lets a later action win over an earlier one for the same key", () => {
    expect(
      settingsToLocalPatch([settingsAction({ priority: 1 }), settingsAction({ priority: 9 })]),
    ).toStrictEqual({ priority: 9 });
  });

  it("merges keys across several approved actions", () => {
    expect(
      settingsToLocalPatch([
        settingsAction({ priority: 1 }),
        { type: "update_folder_rule", ai_rule: "r", why: "w" },
        settingsAction({ hide_from_inbox: true }),
      ]),
    ).toStrictEqual({ priority: 1, ai_rule: "r", hide_from_inbox: true });
  });

  it("ignores a settings key it does not know about", () => {
    expect(
      settingsToLocalPatch([settingsAction(unvalidatedSettings({ future_key: 1 }))]),
    ).toStrictEqual({});
  });
});
