import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { ContactDetailView } from "@/components/contacts/ContactDetailView";

export const Route = createFileRoute("/_authenticated/contacts/$id")({
  component: ContactDetail,
});

function ContactDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <Link
          to="/contacts"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <ContactDetailView id={id} onDeleted={() => navigate({ to: "/contacts" })} />
      </div>
    </div>
  );
}
