import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { PageTitle } from "@/components/PageTitle";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Zerrow" },
      {
        name: "description",
        content: "Manage your Zerrow account, connected Gmail accounts, and preferences.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <div className="h-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageTitle>Settings</PageTitle>

        <div className="flex flex-col gap-6 md:flex-row md:gap-10">
          <aside className="md:w-52 md:shrink-0">
            <SettingsNav />
          </aside>
          <div className="min-w-0 flex-1 space-y-6">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
