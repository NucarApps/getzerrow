import { useCallback, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Upload, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { Slider } from "@/components/ui/slider";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Props = {
  userId: string;
  kind: "avatar" | "cover";
  value: string | null;
  onChange: (url: string | null) => void;
  /** crop aspect ratio (width / height) */
  aspect: number;
  /** rendered preview shape */
  shape?: "circle" | "rect";
  className?: string;
  /** output image max dimension (px on longer side) */
  outputSize?: number;
};

export function ImageCropUpload({
  userId,
  kind,
  value,
  onChange,
  aspect,
  shape = "rect",
  className,
  outputSize = 1200,
}: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [uploading, setUploading] = useState(false);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Image must be under 8 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setSrc(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  const onCropComplete = useCallback((_: Area, px: Area) => setArea(px), []);

  async function onConfirm() {
    if (!src || !area) return;
    setUploading(true);
    try {
      const blob = await cropToBlob(src, area, outputSize);
      const path = `${userId}/${kind}-${Date.now()}.jpg`;
      const { error } = await supabase.storage.from("card-images").upload(path, blob, {
        contentType: "image/jpeg",
        upsert: true,
      });
      if (error) throw error;
      const { data } = supabase.storage.from("card-images").getPublicUrl(path);
      onChange(data.publicUrl);
      toast.success(kind === "avatar" ? "Avatar updated" : "Cover updated");
      setSrc(null);
      setZoom(1);
      setCrop({ x: 0, y: 0 });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={cn("relative", className)}>
      <label className="block cursor-pointer">
        <input type="file" accept="image/*" className="hidden" onChange={onPick} />
        {value ? (
          <div
            className={cn(
              "group relative overflow-hidden border border-border bg-card",
              shape === "circle" ? "rounded-full" : "rounded-lg",
              kind === "avatar" ? "h-24 w-24" : "h-32 w-full",
            )}
          >
            <img src={value} alt="" className="h-full w-full object-cover" />
            <div className="absolute inset-0 hidden items-center justify-center bg-black/50 text-xs text-white group-hover:flex">
              <Upload className="mr-1 h-3.5 w-3.5" /> Replace
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "flex items-center justify-center border-2 border-dashed border-border bg-card/40 text-xs text-muted-foreground hover:bg-card/70",
              shape === "circle" ? "rounded-full" : "rounded-lg",
              kind === "avatar" ? "h-24 w-24" : "h-32 w-full",
            )}
          >
            <div className="flex flex-col items-center gap-1">
              <Upload className="h-4 w-4" />
              <span>{kind === "avatar" ? "Photo" : "Cover image"}</span>
            </div>
          </div>
        )}
      </label>
      {value && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onChange(null);
          }}
          className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-background border border-border text-muted-foreground hover:text-destructive"
          aria-label="Remove image"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      <ResponsiveDialog open={!!src} onOpenChange={(o) => !o && setSrc(null)}>
        <ResponsiveDialogContent className="max-w-lg">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              Crop {kind === "avatar" ? "photo" : "cover"}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <div className="relative h-72 w-full overflow-hidden rounded-md bg-black">
            {src && (
              <Cropper
                image={src}
                crop={crop}
                zoom={zoom}
                aspect={aspect}
                cropShape={shape === "circle" ? "round" : "rect"}
                showGrid={shape !== "circle"}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            )}
          </div>
          <div className="px-1">
            <div className="mb-1 text-xs text-muted-foreground">Zoom</div>
            <Slider
              min={1}
              max={4}
              step={0.05}
              value={[zoom]}
              onValueChange={(v) => setZoom(v[0])}
            />
          </div>
          <ResponsiveDialogFooter>
            <Button variant="ghost" onClick={() => setSrc(null)} disabled={uploading}>
              Cancel
            </Button>
            <Button onClick={onConfirm} disabled={uploading}>
              {uploading ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" /> Uploading…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}

async function cropToBlob(src: string, area: Area, maxSize: number): Promise<Blob> {
  const img = await loadImage(src);
  const scale = Math.min(1, maxSize / Math.max(area.width, area.height));
  const w = Math.round(area.width * scale);
  const h = Math.round(area.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, w, h);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas empty"))), "image/jpeg", 0.9),
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
