import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { connectGmailFromSession } from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import zerrowLogo from "@/assets/zerrow-logo.png";

export const Route = createFileRoute("/login")({ component: LoginPage });

const GMAIL_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

function LoginPage() {
  const nav = useNavigate();
  const [loading, setLoading] = useState(false);
  const connectFn = useServerFn(connectGmailFromSession);
  const handledRef = useRef(false);

  useEffect(() => {
    async function handleSession(session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]) {
      if (!session?.user || handledRef.current) return;
      handledRef.current = true;

      // Only persist Gmail tokens when Google returned a refresh_token,
      // which only happens during an explicit consent flow (first sign-in
      // or after revoking access). On normal refreshes there's no
      // provider_refresh_token, so skip the upsert and just enter the app.
      const accessToken = session.provider_token;
      const refreshToken = session.provider_refresh_token;
      const email = session.user.email;
      const expiresIn = (session as any).expires_in ?? 3600;

      if (accessToken && refreshToken && email) {
        try {
          await connectFn({
            data: {
              access_token: accessToken,
              refresh_token: refreshToken,
              expires_in: typeof expiresIn === "number" ? expiresIn : 3600,
              email_address: email,
            },
          });
        } catch (e: any) {
          console.error("Auto-connect Gmail failed", e);
          toast.error(`Couldn't auto-connect Gmail: ${e?.message ?? "unknown error"}`);
        }
      }
      nav({ to: "/inbox" });
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => { void handleSession(session); });
    supabase.auth.getSession().then(({ data }) => { void handleSession(data.session); });
    return () => sub.subscription.unsubscribe();
  }, [nav, connectFn]);

  async function signInWithGoogle() {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin + "/login",
        scopes: GMAIL_SCOPES,
        // No prompt=consent: Google will skip the permissions screen on
        // subsequent sign-ins. Use the Settings → "Reauthorize Gmail" flow
        // when a fresh refresh token is needed.
        queryParams: { access_type: "offline" },
      },
    });
    if (error) {
      console.error("Google sign-in error", error);
      toast.error(error.message ?? "Google sign-in failed");
      setLoading(false);
    }
    // Otherwise the browser is redirecting to Google.
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-10 flex flex-col items-center text-center">
          <img src={zerrowLogo} alt="Zerrow" className="mb-3 h-28 w-auto" />
          <p className="mt-2 text-sm text-muted-foreground">An inbox that sorts itself.</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-6">
          <Button type="button" variant="outline" className="w-full" disabled={loading} onClick={signInWithGoogle}>
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.08-1.92 3.28-4.74 3.28-8.07z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.75c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.12c-.22-.66-.35-1.36-.35-2.12s.13-1.46.35-2.12V7.04H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.96l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.04l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
            </svg>
            {loading ? "Redirecting…" : "Continue with Google"}
          </Button>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            We'll sign you in and connect your inbox in one step.
          </p>
        </div>
      </div>
    </div>
  );
}
