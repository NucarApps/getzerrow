// MeetingBotCard — the notetaker bot's name, chat message, picture and
// auto-leave.
//
// Every one of these settings is read by a bot that joins a real meeting
// with real people in it, so the contracts pinned here are the ones where
// a wrong value is visible to those people or costs money:
//
//   * the bot always has a name. A blank one would show up in the
//     participant list as an anonymous joiner, so Save refuses it and the
//     two picture paths — which save the whole settings object as a side
//     effect — substitute the default rather than persisting a blank,
//   * auto-leave minutes is clamped to 5–240 and rounded before it is
//     sent: it is what stops a forgotten bot sitting in an empty meeting
//     billing minutes, and a zero or a fraction would be honoured
//     literally by the scheduler,
//   * the picture is resized client-side to the 1280x720 the platforms
//     accept, uploaded to a per-user key, and the settings write that
//     records it is what makes it take effect — an upload without it is
//     an orphan object,
//   * the preview is a short-lived signed URL, because the bucket is
//     private.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

vi.mock("@/integrations/supabase/client", () => ({
  get supabase() {
    return fake.supabaseAdmin;
  },
}));

const getMeetingBotSettings = vi.fn();
const updateMeetingBotSettings = vi.fn();
vi.mock("@/lib/meetings.functions", () => ({
  getMeetingBotSettings: (...a: unknown[]) => getMeetingBotSettings(...a),
  updateMeetingBotSettings: (...a: unknown[]) => updateMeetingBotSettings(...a),
}));

const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

const { MeetingBotCard } = await import("./MeetingBotCard");

const USER = "user-1";
const BUCKET = "meeting-bot-avatars";

const settings = (over: Record<string, unknown> = {}) => ({
  botName: "Atzro Notetaker",
  chatMessage: "Hi, I'm recording.",
  chatResendOnJoin: true,
  autoLeaveEnabled: true,
  autoLeaveMinutes: 30,
  hasAvatar: false,
  ...over,
});

const nameBox = () => screen.getByLabelText("Bot name");
const minutesBox = () => screen.getByLabelText("Leave after");
const saveButton = () => screen.getByRole("button", { name: /Save/ });
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
const saved = () =>
  (updateMeetingBotSettings.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data;

/** Replace the minutes field's contents outright. */
async function setMinutes(user: ReturnType<typeof renderWithQuery>["user"], value: string) {
  await user.tripleClick(minutesBox());
  await user.keyboard(value);
  await waitFor(() => expect(minutesBox()).toHaveValue(Number(value)));
}

/** jsdom has no canvas or createImageBitmap; stand in for both so the
 * resize path is reachable. The resize maths itself is browser API glue. */
function stubImagePipeline() {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1920, height: 1080, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => {
    cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
  });
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:preview") });
}

beforeEach(() => {
  fake.reset();
  fake.signedInAs(USER);
  getMeetingBotSettings.mockResolvedValue(settings());
  updateMeetingBotSettings.mockResolvedValue(undefined);
});

describe("loading the settings", () => {
  it("fills the form from the stored settings", async () => {
    getMeetingBotSettings.mockResolvedValue(
      settings({ botName: "Scribe", chatMessage: "Recording this call.", autoLeaveMinutes: 45 }),
    );
    renderWithQuery(<MeetingBotCard />);

    await waitFor(() => expect(nameBox()).toHaveValue("Scribe"));
    expect(screen.getByLabelText("Chat message")).toHaveValue("Recording this call.");
    expect(minutesBox()).toHaveValue(45);
  });

  it("shows the switches in their stored positions", async () => {
    getMeetingBotSettings.mockResolvedValue(
      settings({ chatResendOnJoin: false, autoLeaveEnabled: false }),
    );
    renderWithQuery(<MeetingBotCard />);

    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Re-post chat message for late joiners" }),
      ).not.toBeChecked(),
    );
    expect(
      screen.getByRole("switch", { name: "Automatically leave empty meetings" }),
    ).not.toBeChecked();
  });
});

describe("saving", () => {
  it("refuses a blank name rather than joining as an anonymous participant", async () => {
    const { user } = renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    await user.clear(nameBox());
    await user.click(saveButton());

    expect(toast.error).toHaveBeenCalledWith("Give the bot a name.");
    expect(updateMeetingBotSettings).not.toHaveBeenCalled();
  });

  it("trims the name it sends", async () => {
    const { user } = renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    await user.clear(nameBox());
    await user.type(nameBox(), "  Scribe  ");
    await user.click(saveButton());

    await waitFor(() => expect(updateMeetingBotSettings).toHaveBeenCalled());
    expect(saved().botName).toBe("Scribe");
  });

  it("clamps auto-leave minutes into the 5–240 range", async () => {
    // A forgotten bot in an empty meeting bills minutes; 0 would be
    // honoured literally by the scheduler.
    for (const [typed, expected] of [
      ["1", 5],
      // 0 reads as "unset" and falls back to the 30-minute default rather
      // than to the 5-minute floor — an emptied box is not a request to
      // leave as soon as possible.
      ["0", 30],
      ["999", 240],
      ["45", 45],
    ] as const) {
      const { user, unmount } = renderWithQuery(<MeetingBotCard />);
      await waitFor(() => expect(minutesBox()).toHaveValue(30));
      // Select-all then type. `clear()` on a number input can leave the
      // old digits in place and append, quietly turning "1" into "301".
      await setMinutes(user, typed);
      await user.click(saveButton());

      await waitFor(() => expect(updateMeetingBotSettings).toHaveBeenCalled());
      expect(saved().autoLeaveMinutes, `typed ${typed}`).toBe(expected);
      unmount();
      updateMeetingBotSettings.mockClear();
    }
  });

  it("writes the clamped value back into the field the user is looking at", async () => {
    const { user } = renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(minutesBox()).toHaveValue(30));
    await setMinutes(user, "999");
    await user.click(saveButton());

    await waitFor(() => expect(minutesBox()).toHaveValue(240));
  });

  it("sends the switches and refreshes the settings cache", async () => {
    const { user } = renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    await user.click(screen.getByRole("switch", { name: "Re-post chat message for late joiners" }));
    await user.click(saveButton());

    await waitFor(() => expect(updateMeetingBotSettings).toHaveBeenCalled());
    expect(saved()).toMatchObject({ chatResendOnJoin: false, autoLeaveEnabled: true });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["meeting-bot-settings"] });
    expect(toast.success).toHaveBeenCalledWith("Meeting bot settings saved.");
  });

  it("does not touch the picture when only settings are saved", async () => {
    // `avatar` absent means "leave it as it is"; sending "clear" here
    // would wipe a picture the user never mentioned.
    const { user } = renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));
    await user.click(saveButton());

    await waitFor(() => expect(updateMeetingBotSettings).toHaveBeenCalled());
    expect(saved()).not.toHaveProperty("avatar");
  });

  it("reports a failed save", async () => {
    updateMeetingBotSettings.mockRejectedValue(new Error("rls"));
    const { user } = renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));
    await user.click(saveButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't save settings."));
  });
});

describe("the bot picture", () => {
  beforeEach(() => {
    stubImagePipeline();
  });

  it("refuses a non-image without uploading anything", async () => {
    renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "a.pdf", { type: "application/pdf" })] },
    });

    expect(toast.error).toHaveBeenCalledWith("Please choose an image file.");
    expect(fake.calls.storage).toEqual([]);
  });

  it("uploads a resized jpeg under the user's own key", async () => {
    renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(fake.calls.storage.length).toBeGreaterThan(0));
    const upload = fake.calls.storage.find((c) => c.method === "upload")!;
    expect(upload.bucket).toBe(BUCKET);
    expect(upload.args[0]).toBe(`${USER}/avatar.jpg`);
    expect(upload.args[2]).toMatchObject({ upsert: true, contentType: "image/jpeg" });
  });

  it("records the picture in the settings, or it is an orphan object", async () => {
    renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(updateMeetingBotSettings).toHaveBeenCalled());
    expect(saved()).toMatchObject({ avatar: "set" });
    expect(toast.success).toHaveBeenCalledWith("Bot picture updated.");
  });

  it("substitutes the default name rather than persisting a blank one", async () => {
    // The picture paths save the WHOLE settings object as a side effect,
    // so an empty name box here would otherwise be written through.
    const { user } = renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));
    await user.clear(nameBox());

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(updateMeetingBotSettings).toHaveBeenCalled());
    expect(saved().botName).toBe("Atzro Notetaker");
  });

  it("reports a failed upload without claiming the picture changed", async () => {
    fake.onStorage(BUCKET, "upload", () => ({ error: { message: "quota" } }));
    renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't upload the picture."));
    expect(updateMeetingBotSettings).not.toHaveBeenCalled();
  });

  it("refuses to upload when the session is gone", async () => {
    fake.signedInAs(null);
    renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't upload the picture."));
    expect(fake.calls.storage).toEqual([]);
  });

  it("previews an existing picture through a short-lived signed URL", async () => {
    // The bucket is private, so the stored object is never fetched directly.
    getMeetingBotSettings.mockResolvedValue(settings({ hasAvatar: true }));
    fake.onStorage(BUCKET, "createSignedUrl", () => ({
      data: { signedUrl: "https://signed.test/avatar.jpg?token=x" },
    }));
    renderWithQuery(<MeetingBotCard />);

    await waitFor(() => expect(fake.calls.storage.length).toBeGreaterThan(0));
    const signed = fake.calls.storage.find((c) => c.method === "createSignedUrl")!;
    expect(signed.args).toEqual([`${USER}/avatar.jpg`, 300]);
  });

  it("clears the picture through the settings write", async () => {
    getMeetingBotSettings.mockResolvedValue(settings({ hasAvatar: true }));
    fake.onStorage(BUCKET, "createSignedUrl", () => ({
      data: { signedUrl: "https://signed.test/avatar.jpg" },
    }));
    const { user } = renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    await user.click(await screen.findByRole("button", { name: /Remove/ }));

    await waitFor(() => expect(updateMeetingBotSettings).toHaveBeenCalled());
    expect(saved()).toMatchObject({ avatar: "clear" });
    expect(toast.success).toHaveBeenCalledWith("Bot picture removed.");
  });

  it("reports a failed removal", async () => {
    getMeetingBotSettings.mockResolvedValue(settings({ hasAvatar: true }));
    fake.onStorage(BUCKET, "createSignedUrl", () => ({
      data: { signedUrl: "https://signed.test/avatar.jpg" },
    }));
    updateMeetingBotSettings.mockRejectedValue(new Error("nope"));
    const { user } = renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    await user.click(await screen.findByRole("button", { name: /Remove/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't remove the picture."));
  });

  it("offers no removal when there is no picture", async () => {
    renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  it("clears the input so the same file can be picked twice", async () => {
    renderWithQuery(<MeetingBotCard />);
    await waitFor(() => expect(nameBox()).toHaveValue("Atzro Notetaker"));

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(updateMeetingBotSettings).toHaveBeenCalled());
    expect(fileInput().value).toBe("");
  });
});
