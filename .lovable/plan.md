## Plan

1. **Serve in-person recordings through the existing playback proxy**
   - Stop returning the raw storage signed URL for `audio_storage_path`.
   - Return the same `/api/public/meeting-recording?...` signed proxy URL for audio recordings, with `kind: "audio"`.

2. **Teach the proxy to stream stored in-person files**
   - Update `/api/public/meeting-recording` so it can resolve `audio_storage_path` / `video_storage_path`, not only external bot recordings.
   - Set the response `Content-Type` from the actual file extension: `audio/wav`, `audio/mp4`, `audio/webm`, or `video/webm` / `video/mp4`.
   - Keep forwarding `Range` headers so browser audio controls can load metadata, seek, and play reliably.

3. **Keep the player as the primary UI**
   - Leave the `<audio controls>` player visible for in-person recordings.
   - Keep open/download links as secondary actions only.

4. **Verify the current new recording**
   - Check that the new `.wav` recording is requested through the proxy with `audio/wav`.
   - Run the relevant typecheck/test and, if possible, verify the preview no longer shows the native player error.