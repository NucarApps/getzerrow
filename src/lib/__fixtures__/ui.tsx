// Shared harness for the jsdom ("ui") vitest project.
//
// Every component test needs the same three things, and each one was being
// re-written per file:
//
//   1. a QueryClientProvider whose client does NOT retry — a retrying
//      client turns a rejected server fn into a five-second test timeout
//      instead of the error branch you meant to exercise, and leaks state
//      between tests when the client is shared,
//   2. the `@tanstack/react-start` / `@tanstack/react-router` stubs, since
//      a component tree under test has no router and `useServerFn` is
//      identity for a mocked server fn,
//   3. `sonner` spies, because a toast is how most of these components
//      report success and failure and is therefore the assertion.
//
// (2) and (3) must be installed by the test file itself — `vi.mock` is
// hoisted per module and cannot be applied from a helper — so this file
// exports the factory bodies to pass to `vi.mock`, and the render wrapper
// which can live here.
//
// Lives in __fixtures__ so it is excluded from the coverage/test globs and
// never ships.
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** A fresh query client per render: no retries (so a rejection surfaces as
 * the error branch, not a timeout), no cache carried between tests. */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function QueryWrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>;
}

/** Render inside a fresh query client, and hand back a userEvent session
 * bound to this document. Use the returned `user` rather than the default
 * export of userEvent so pointer state does not leak between tests. */
export function renderWithQuery(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
): RenderResult & { user: ReturnType<typeof userEvent.setup> } {
  const user = userEvent.setup();
  return { ...render(ui, { ...options, wrapper: QueryWrapper }), user };
}

/** Body for `vi.mock("@tanstack/react-start", …)`. `useServerFn` is the
 * identity function: the test has already mocked the server fn module, so
 * the value it hands back is the spy. */
export function mockReactStart() {
  return { useServerFn: <T,>(fn: T) => fn };
}

/** Body for `vi.mock("@tanstack/react-router", …)`. Renders `Link` as a
 * plain anchor so link text stays queryable, and stubs the navigation
 * hooks a component may reach for. Pass the spies back in to assert on
 * navigation. */
export function mockReactRouter(spies: { navigate?: (...a: unknown[]) => unknown } = {}) {
  const navigate = spies.navigate ?? vi.fn();
  return {
    Link: ({ to, children, ...rest }: { to?: string; children?: ReactNode }) => (
      <a href={typeof to === "string" ? to : "#"} {...rest}>
        {children}
      </a>
    ),
    useNavigate: () => navigate,
    useRouter: () => ({ navigate, invalidate: vi.fn() }),
    useSearch: () => ({}),
    useParams: () => ({}),
  };
}

/** Spies for the four `sonner` toast channels, plus the `vi.mock` body.
 * A toast is how these components report outcomes, so it is usually the
 * assertion rather than incidental. */
export function makeToastSpies() {
  const toast = {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  };
  return {
    toast,
    /** `vi.mock("sonner", () => sonnerModule(toast))` */
    module: () => ({ toast, Toaster: () => null }),
  };
}
