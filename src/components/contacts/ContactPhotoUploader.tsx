import { useRef, useState, type ChangeEvent } from "react";
import { Camera, Trash2, Loader2 } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CompanyLogo } from "@/components/contacts/CompanyLogo";
import { contactLogoDomain } from "@/lib/company-domains";
import { listCompanyLogoChoices } from "@/lib/company-logo.functions";
import {
  uploadContactPhoto,
  removeContactPhoto,
  getContactPhotoSignedUrl,
} from "@/lib/contacts/photos.functions";

const ALLOWED = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type AllowedMime = (typeof ALLOWED)[number];

function isAllowedMime(mime: string): mime is AllowedMime {
  return (ALLOWED as readonly string[]).includes(mime);
}

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(bin);
}

type Props = {
  contactId: string;
  avatarUrl: string | null;
  displayName: string;
  email?: string | null;
  website?: string | null;
  onChanged: () => void;
};

/**
 * Circular avatar with hover-to-change controls. Uploads route through the
 * `uploadContactPhoto` server fn; the picture is stored in the private
 * `contact-photos` bucket and marked dirty for Google/CardDAV sync so the
 * change propagates to iPhone and Google Contacts on their next tick.
 */
export function ContactPhotoUploader({ contactId, avatarUrl, displayName, email, website, onChanged }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = useServerFn(uploadContactPhoto);
  const remove = useServerFn(removeContactPhoto);
  const signUrl = useServerFn(getContactPhotoSignedUrl);

  // The bucket is private, so we mint a short-lived signed URL after
  // server-side ownership check. `avatarUrl` from the DB just tells us
  // whether a photo exists; the browser never fetches it directly.
  const signedQuery = useQuery({
    queryKey: ["contact-photo-signed", contactId, avatarUrl],
    queryFn: async () => (await signUrl({ data: { contactId } })).url,
    enabled: !!avatarUrl,
    staleTime: 50 * 60 * 1000, // refresh well before the 1h signed-URL expiry
  });
  const displaySrc = avatarUrl ? signedQuery.data ?? null : null;


  const openPicker = () => fileRef.current?.click();

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!isAllowedMime(file.type)) {
      toast.error("Use JPG, PNG, GIF or WebP");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image too large (max 5 MB)");
      return;
    }
    setBusy(true);
    try {
      const base64 = await fileToBase64(file);
      await upload({ data: { contactId, base64, mime: file.type } });
      toast.success("Photo updated");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    try {
      await remove({ data: { contactId } });
      toast.success("Photo removed");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  };

  const logoDomain = !displaySrc ? contactLogoDomain(website ?? null, email ?? null) : null;

  return (
    <div className="group relative h-16 w-16 shrink-0">
      {displaySrc ? (
        <img
          src={displaySrc}
          alt={displayName}
          className="h-16 w-16 rounded-full object-cover"
        />
      ) : logoDomain ? (
        <CompanyLogo domain={logoDomain} name={displayName} size={64} className="!rounded-full" />
      ) : (
        <div className="grid h-16 w-16 place-items-center rounded-full bg-primary/15 text-2xl font-semibold text-primary">
          {displayName.slice(0, 1).toUpperCase()}
        </div>
      )}
      <button
        type="button"
        onClick={openPicker}
        disabled={busy}
        aria-label="Change photo"
        className="absolute inset-0 grid place-items-center rounded-full bg-black/40 text-white opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
      </button>
      {avatarUrl && !busy ? (
        <Button
          type="button"
          size="icon"
          variant="secondary"
          onClick={onRemove}
          aria-label="Remove photo"
          className="absolute -right-1 -bottom-1 h-6 w-6 rounded-full opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={onPick}
        hidden
      />
    </div>
  );
}
