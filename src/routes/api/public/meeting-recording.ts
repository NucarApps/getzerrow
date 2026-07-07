// Public streaming proxy for meeting recordings. Some upstream/storage URLs are
// served with generic headers, which mobile Safari and other browsers can refuse
// to play inline. This route streams bytes back with explicit media headers and
// forwards Range requests so seeking works. Access is gated by a short-lived HMAC
// token minted by the authenticated getRecordingStreamUrl.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/meeting-recording")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const meetingId = url.searchParams.get("m") ?? "";
        const exp = Number(url.searchParams.get("e") ?? "");
        const token = url.searchParams.get("t") ?? "";
        const isDownload = url.searchParams.get("dl") === "1";

        const { verifyRecordingStreamToken } = await import("@/lib/meeting-stream.server");
        if (!verifyRecordingStreamToken(meetingId, exp, token)) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Resolve a playable URL cheaply (stored URL, no transcript work).
        const { resolvePlayableRecordingUrl, mintFreshRecordingUrl } =
          await import("@/lib/meetings.server");
        let recordingUrl: string | null;
        let recallBotId: string | null = null;
        let contentType = "video/mp4";
        let filename = `recording-${meetingId}.mp4`;
        try {
          const r = await resolvePlayableRecordingUrl(meetingId);
          recordingUrl = r.url;
          recallBotId = r.recallBotId;
          contentType = r.contentType;
          filename = r.filename;
        } catch {
          recordingUrl = null;
        }
        if (!recordingUrl) {
          return new Response("Recording not available", { status: 404 });
        }

        // Forward the browser's Range header so seeking / progressive playback works.
        const range = request.headers.get("range");
        let upstream = await fetch(recordingUrl, {
          headers: range ? { Range: range } : {},
        });

        // The stored S3 URL is short-lived. If it has expired (403/401), mint a
        // fresh one from Recall ONCE and retry — instead of doing that on every
        // request, which would hammer Recall during playback.
        if ((upstream.status === 403 || upstream.status === 401) && recallBotId) {
          try {
            const fresh = await mintFreshRecordingUrl(meetingId, recallBotId);
            if (fresh) {
              upstream = await fetch(fresh, { headers: range ? { Range: range } : {} });
            }
          } catch {
            /* fall through to the error handling below */
          }
        }

        if (!upstream.ok && upstream.status !== 206) {
          return new Response("Upstream fetch failed", { status: 502 });
        }

        const headers = new Headers();
        headers.set("Content-Type", contentType);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "private, max-age=0, no-store");
        const contentLength = upstream.headers.get("content-length");
        if (contentLength) headers.set("Content-Length", contentLength);
        const contentRange = upstream.headers.get("content-range");
        if (contentRange) headers.set("Content-Range", contentRange);
        if (isDownload) {
          headers.set("Content-Disposition", `attachment; filename="${filename}"`);
        }

        return new Response(upstream.body, { status: upstream.status, headers });
      },
    },
  },
});
