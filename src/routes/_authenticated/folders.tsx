import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/folders")({
  beforeLoad: () => {
    throw redirect({ to: "/inbox" });
  },
});
