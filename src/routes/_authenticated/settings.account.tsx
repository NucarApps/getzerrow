import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { deleteAccount } from "@/lib/account.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/account")({
  head: () => ({
    meta: [{ title: "Account — Settings — Zerrow" }, { name: "robots", content: "noindex" }],
  }),
  component: AccountSettings,
});

function AccountSettings() {
  return (
    <div className="space-y-6">
      <DangerZone />
    </div>
  );
}

function DangerZone() {
  const remove = useServerFn(deleteAccount);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function onDelete() {
    setBusy(true);
    try {
      await remove();
      try {
        await supabase.auth.signOut();
      } catch {
        /* noop */
      }
      toast.success("Account deleted");
      window.location.href = "/";
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to delete account";
      toast.error(message);
      setBusy(false);
    }
  }

  return (
    <Card className="border-destructive/40 p-4 md:p-6">
      <h2 className="font-display text-xl text-destructive">Delete account</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Permanently delete your Zerrow account, revoke Google access, and remove all synced
        messages, folders, contacts, and settings. This cannot be undone.
      </p>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setConfirm("");
        }}
      >
        <AlertDialogTrigger asChild>
          <Button variant="destructive" className="mt-4">
            Delete my account
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your Zerrow account?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revoke Google access on all connected mailboxes, delete every email, folder,
              filter, contact, and queued job we hold for you, and remove your sign-in. It cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="confirm-delete">
              Type <span className="font-mono">DELETE</span> to confirm
            </Label>
            <Input
              id="confirm-delete"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || confirm !== "DELETE"}
              onClick={(e) => {
                e.preventDefault();
                onDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? "Deleting…" : "Delete forever"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
