import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { Bot, Upload, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { getMeetingBotSettings, updateMeetingBotSettings } from "@/lib/meetings.functions";

const BUCKET = "meeting-bot-avatars";
// Recall renders the picture as the bot's video tile; platforms accept up to
// 1280x720 16:9 JPEG (<= 1.3MB). We resize client-side to keep uploads small.
const TARGET_W = 1280;
const TARGET_H = 720;

/**
 * Resize/crop a chosen image to a 1280x720 JPEG (letterboxed on a dark
 * background to preserve aspect ratio) so it matches what meeting platforms
 * accept for a bot's video output.
 */
async function toBotJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, TARGET_W, TARGET_H);
  const scale = Math.min(TARGET_W / bitmap.width, TARGET_H / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (TARGET_W - w) / 2, (TARGET_H - h) / 2, w, h);
  bitmap.close();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not process image"))),
      "image/jpeg",
      0.9,
    );
  });
}

export function MeetingBotCard() {
  const qc = useQueryClient();
  const getSettings = useServerFn(getMeetingBotSettings);
  const saveSettings = useServerFn(updateMeetingBotSettings);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: settings } = useQuery({
    queryKey: ["meeting-bot-settings"],
    queryFn: () => getSettings(),
  });

  const [botName, setBotName] = useState("");
  const [chatMessage, setChatMessage] = useState("");
  const [resend, setResend] = useState(true);
  const [autoLeaveEnabled, setAutoLeaveEnabled] = useState(true);
  const [autoLeaveMinutes, setAutoLeaveMinutes] = useState(30);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [hasAvatar, setHasAvatar] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setBotName(settings.botName);
    setChatMessage(settings.chatMessage);
    setResend(settings.chatResendOnJoin);
    setAutoLeaveEnabled(settings.autoLeaveEnabled);
    setAutoLeaveMinutes(settings.autoLeaveMinutes);
    setHasAvatar(settings.hasAvatar);
  }, [settings]);

  // Load a private preview of the existing picture via a short-lived signed URL.
  useEffect(() => {
    let active = true;
    if (!hasAvatar) {
      setPreviewUrl(null);
      return;
    }
    (async () => {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id;
      if (!uid) return;
      const { data: signed } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(`${uid}/avatar.jpg`, 300);
      if (active && signed?.signedUrl) setPreviewUrl(`${signed.signedUrl}&t=${Date.now()}`);
    })();
    return () => {
      active = false;
    };
  }, [hasAvatar]);

  const handlePick = () => fileRef.current?.click();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file.");
      return;
    }
    setUploading(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) throw new Error("Not signed in");
      const blob = await toBotJpeg(file);
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(`${uid}/avatar.jpg`, blob, { upsert: true, contentType: "image/jpeg" });
      if (upErr) throw upErr;
      await saveSettings({
        data: {
          botName: botName.trim() || "Zerrow Notetaker",
          chatMessage,
          chatResendOnJoin: resend,
          avatar: "set",
        },
      });
      setHasAvatar(true);
      setPreviewUrl(URL.createObjectURL(blob));
      qc.invalidateQueries({ queryKey: ["meeting-bot-settings"] });
      toast.success("Bot picture updated.");
    } catch {
      toast.error("Couldn't upload the picture.");
    } finally {
      setUploading(false);
    }
  };

  const handleRemovePicture = async () => {
    setUploading(true);
    try {
      await saveSettings({
        data: {
          botName: botName.trim() || "Zerrow Notetaker",
          chatMessage,
          chatResendOnJoin: resend,
          avatar: "clear",
        },
      });
      setHasAvatar(false);
      setPreviewUrl(null);
      qc.invalidateQueries({ queryKey: ["meeting-bot-settings"] });
      toast.success("Bot picture removed.");
    } catch {
      toast.error("Couldn't remove the picture.");
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!botName.trim()) {
      toast.error("Give the bot a name.");
      return;
    }
    setSaving(true);
    try {
      await saveSettings({
        data: {
          botName: botName.trim(),
          chatMessage,
          chatResendOnJoin: resend,
        },
      });
      qc.invalidateQueries({ queryKey: ["meeting-bot-settings"] });
      toast.success("Meeting bot settings saved.");
    } catch {
      toast.error("Couldn't save settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b bg-muted/20 p-4 md:p-6">
        <Bot className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="font-display text-2xl">Meeting bot</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Personalize the notetaker that joins your calls. These settings apply to every meeting
            across all connected inboxes.
          </p>
        </div>
      </div>

      <div className="space-y-6 p-4 md:p-6">
        <div className="space-y-2">
          <Label htmlFor="bot-name">Bot name</Label>
          <Input
            id="bot-name"
            value={botName}
            maxLength={100}
            onChange={(e) => setBotName(e.target.value)}
            placeholder="Zerrow Notetaker"
          />
          <p className="text-xs text-muted-foreground">
            The name shown in the participant list when the bot joins.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Bot picture</Label>
          <div className="flex items-center gap-4">
            <div className="flex h-[72px] w-32 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Bot picture preview"
                  className="h-full w-full object-cover"
                />
              ) : (
                <Bot className="h-6 w-6 text-muted-foreground" />
              )}
            </div>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handlePick}
                  disabled={uploading}
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {hasAvatar ? "Replace" : "Upload"}
                </Button>
                {hasAvatar && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRemovePicture}
                    disabled={uploading}
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Shown as the bot's video tile in the call (platforms have no bot profile photo). JPG
                or PNG, auto-cropped to 16:9.
              </p>
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFile}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="chat-message">Chat message</Label>
          <Textarea
            id="chat-message"
            value={chatMessage}
            maxLength={1000}
            rows={3}
            onChange={(e) => setChatMessage(e.target.value)}
            placeholder="Hi! I'm the Zerrow notetaker. I'm here to record and summarize this meeting."
          />
          <p className="text-xs text-muted-foreground">
            Posted in the meeting chat when the bot joins. Leave empty to post nothing.
          </p>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Notify people who join late</p>
            <p className="text-xs text-muted-foreground">
              Re-post the chat message each time a new participant joins.
            </p>
          </div>
          <Switch
            checked={resend}
            onCheckedChange={setResend}
            aria-label="Re-post chat message for late joiners"
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </div>
      </div>
    </Card>
  );
}
