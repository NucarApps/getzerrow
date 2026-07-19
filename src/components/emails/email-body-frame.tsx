import { useId, useLayoutEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";

const MIN_PX = 400;

export function EmailBodyFrame({ html }: { html: string }) {
  const frameId = useId();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const srcDoc = useMemo(() => {
    // Sanitize email HTML to strip <script>, event handlers, and other
    // dangerous constructs BEFORE injecting into the iframe. Even though the
    // iframe is sandboxed without allow-same-origin, attacker scripts could
    // otherwise auto-execute (outbound tracking beacons, popup phishing).
    // Stripping them at the source removes that capability entirely.
    const cleanHtml = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target"],
      FORBID_TAGS: ["script", "object", "embed", "form", "input", "meta", "link"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "onsubmit"],
    });
    const resizeScript = `
<script>
(function(){
  var id = ${JSON.stringify(frameId)};
  function post(){
    try {
      var h = Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      );
      parent.postMessage({ __zerrowFrame: id, height: h }, "*");
    } catch(e){}
  }
  post();
  document.addEventListener("DOMContentLoaded", function(){
    post();
    if (typeof ResizeObserver !== "undefined" && document.body) {
      try { new ResizeObserver(post).observe(document.body); } catch(e){}
    }
    var imgs = document.getElementsByTagName("img");
    for (var i=0; i<imgs.length; i++) {
      imgs[i].addEventListener("load", post);
      imgs[i].addEventListener("error", post);
    }
  });
  window.addEventListener("load", function(){
    post();
    requestAnimationFrame(post);
    setTimeout(post, 100);
    setTimeout(post, 400);
    setTimeout(post, 1200);
  });
  window.addEventListener("resize", post);
  window.addEventListener("message", function(e){
    if (e && e.data && e.data.__zerrowPing === id) post();
  });
})();
</script>`;
    return `<!doctype html><html><head><base target="_blank"><meta charset="utf-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light only;}html,body{margin:0;padding:16px;background:#fff !important;color:#111 !important;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;word-wrap:break-word;overflow-wrap:break-word;}body *{color:inherit;}img{max-width:100%;height:auto;}a{color:#2563eb !important;}table{max-width:100%;}</style></head><body>${cleanHtml}${resizeScript}</body></html>`;
  }, [html, frameId]);

  useLayoutEffect(() => {
    function onMessage(e: MessageEvent) {
      // Only accept height reports from our own sandboxed iframe. Its origin is
      // opaque ("null") for a srcdoc sandbox, so we pin to the contentWindow and
      // the per-render frameId nonce rather than checking e.origin.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { __zerrowFrame?: string; height?: number } | null;
      if (!d || d.__zerrowFrame !== frameId || typeof d.height !== "number") return;
      const f = iframeRef.current;
      if (!f) return;
      const clamped = Math.min(Math.max(d.height + 4, MIN_PX), 8000);
      f.style.height = clamped + "px";
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameId]);

  function pingForHeight() {
    const f = iframeRef.current;
    // The email iframe is sandboxed without allow-same-origin, so its origin is
    // opaque ("null") and "*" is the only targetOrigin that can reach it. The
    // payload is a non-sensitive per-render nonce (no user data) sent only to our
    // own iframe's contentWindow, so wildcard disclosure is moot.
    try {
      // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
      f?.contentWindow?.postMessage({ __zerrowPing: frameId }, "*");
    } catch {
      /* best-effort: iframe may not be ready yet */
    }
  }

  return (
    <iframe
      ref={iframeRef}
      title="Email body"
      srcDoc={srcDoc}
      onLoad={pingForHeight}
      sandbox="allow-popups allow-scripts"
      className="w-full rounded-lg bg-white"
      style={{ border: 0, colorScheme: "light", height: MIN_PX, minHeight: MIN_PX }}
    />
  );
}

export function EmailBodyInline({ html }: { html: string }) {
  const clean = useMemo(
    () =>
      DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["target"],
        FORBID_TAGS: [
          "script",
          "style",
          "iframe",
          "object",
          "embed",
          "form",
          "input",
          "meta",
          "link",
        ],
        FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
      }),
    [html],
  );
  return (
    <div
      className="email-body-inline rounded-lg bg-white p-4 text-[14px] leading-relaxed text-[#111]"
      style={{ colorScheme: "light", wordWrap: "break-word", overflowWrap: "break-word" }}
      // `clean` is DOMPurify-sanitized HTML (see useMemo above).
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
