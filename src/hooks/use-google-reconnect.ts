import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { startConnectGmail } from "@/lib/gmail.functions";

/**
 * Start the Google OAuth redirect, shared by the seven places that offer a
 * "reconnect" / "add account" affordance.
 *
 * Each of those hand-rolled the same setBusy → startConnectGmail → assign
 * location → catch/toast/reset sequence, with five different error strings for
 * the same failure.
 *
 * Deliberately does NOT own the busy state: callers key it differently (a
 * boolean, an account id, `reconnect-${email}`), and moving it in here would
 * have meant rewriting state in seven components for no gain. Callers keep
 * their own and use the returned boolean to decide whether to clear it.
 *
 * Returns false — after toasting — when the redirect could not be started. On
 * success the browser navigates away, so nothing after it runs.
 */
export function useGoogleReconnect() {
  const connect = useServerFn(startConnectGmail);

  return async function startGoogleReconnect(
    opts: { loginHint?: string | null; errorMessage?: string } = {},
  ): Promise<boolean> {
    try {
      const { url } = await connect({
        data: opts.loginHint ? { login_hint: opts.loginHint } : {},
      });
      window.location.href = url;
      return true;
    } catch (e) {
      toast.error(
        opts.errorMessage ?? (e instanceof Error ? e.message : "Couldn't start Google sign-in"),
      );
      return false;
    }
  };
}
