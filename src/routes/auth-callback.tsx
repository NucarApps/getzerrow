import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import zerrowLogo from "@/assets/zerrow-logo-v2.png";

// Deep-link bridge for the native Zerrow app.
//
// A custom URL scheme (zerrow://) cannot be added to the backend auth redirect
// allow-list, so the native app points Supabase OAuth at this HTTPS page
// (https://getzerrow.com/auth-callback), which IS allow-listed. After Google
// redirects here with the OAuth result, this page forwards the exact same
// tokens/code to zerrow://auth-callback, where supabase-swift's
// `session(from:)` completes the session.
export const Route = createFileRoute("/auth-callback")({
  // Purely a client-side redirect bridge — no SSR, no auth gate.
  ssr: false,
  head: () => ({
    meta: [
      { title: "Completing sign-in — Zerrow" },
      { name: "robots", content: "noindex" },
      {
        name: "description",
        content: "Returning you to the Zerrow app to finish signing in.",
      },
    ],
  }),
  component: AuthCallbackBridge,
});

const APP_SCHEME = "zerrow://auth-callback";

function buildDeepLink(): string {
  if (typeof window === "undefined") return APP_SCHEME;
  // Implicit flow returns tokens in the fragment (#access_token=...);
  // PKCE flow returns ?code=... in the query; errors can appear in either.
  const hash = window.location.hash.replace(/^#/, "");
  const search = window.location.search.replace(/^\?/, "");
  const parts: string[] = [];
  if (search) parts.push(search);
  if (hash) parts.push(hash);
  const payload = parts.join("&");
  return payload ? `${APP_SCHEME}#${payload}` : APP_SCHEME;
}

function AuthCallbackBridge() {
  const [deepLink, setDeepLink] = useState(APP_SCHEME);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(
      window.location.search.replace(/^\?/, "") ||
        window.location.hash.replace(/^#/, ""),
    );
    const oauthError = params.get("error_description") ?? params.get("error");
    if (oauthError) {
      setError(oauthError);
      return;
    }

    const link = buildDeepLink();
    setDeepLink(link);
    // Hand off to the native app.
    window.location.href = link;
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center">
        <img src={zerrowLogo} alt="Zerrow" className="mx-auto mb-6 h-20 w-auto" />
        {error ? (
          <>
            <h1 className="text-lg font-medium text-foreground">Sign-in didn't complete</h1>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <Button asChild variant="outline" className="mt-6">
              <a href="/login">Try again</a>
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-lg font-medium text-foreground">Returning you to Zerrow…</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              If the app doesn't open automatically, tap the button below.
            </p>
            <Button asChild className="mt-6">
              <a href={deepLink}>Open Zerrow</a>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
