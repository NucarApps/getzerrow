import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";

/**
 * Per-route error boundary fallback. Unlike the root errorComponent (which
 * replaces the entire app shell), this renders inside the authenticated
 * layout so the sidebar and navigation stay usable when a single page fails.
 */
export function RouteErrorFallback({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="font-display text-xl text-foreground">Something went wrong</h1>
        <p className="mt-2 break-words text-sm text-muted-foreground">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
