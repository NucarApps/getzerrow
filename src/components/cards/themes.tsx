import { cn } from "@/lib/utils";

export type CardTheme = {
  id: string;
  label: string;
  gradient: string; // tailwind classes for header gradient
  accent: string; // tailwind classes for primary button bg
};

export const CARD_THEMES: CardTheme[] = [
  { id: "default",  label: "Indigo",   gradient: "from-primary to-primary/40",            accent: "bg-primary text-primary-foreground" },
  { id: "sunset",   label: "Sunset",   gradient: "from-orange-500 via-pink-500 to-purple-600", accent: "bg-orange-500 text-white" },
  { id: "ocean",    label: "Ocean",    gradient: "from-cyan-500 via-blue-600 to-indigo-700",   accent: "bg-blue-600 text-white" },
  { id: "forest",   label: "Forest",   gradient: "from-emerald-500 via-green-600 to-teal-700", accent: "bg-emerald-600 text-white" },
  { id: "noir",     label: "Noir",     gradient: "from-zinc-700 via-zinc-900 to-black",        accent: "bg-zinc-900 text-white" },
  { id: "rose",     label: "Rose",     gradient: "from-rose-400 via-pink-500 to-fuchsia-600",  accent: "bg-rose-500 text-white" },
  { id: "amber",    label: "Amber",    gradient: "from-amber-400 via-orange-500 to-red-500",   accent: "bg-amber-500 text-black" },
  { id: "mono",     label: "Mono",     gradient: "from-neutral-200 to-neutral-400",            accent: "bg-foreground text-background" },
];

export function getTheme(id: string | null | undefined): CardTheme {
  return CARD_THEMES.find((t) => t.id === id) ?? CARD_THEMES[0];
}

export function ThemePicker({
  value, onChange,
}: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
      {CARD_THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            "group flex flex-col items-center gap-1 rounded-md border p-1.5 transition",
            value === t.id ? "border-foreground" : "border-border hover:border-muted-foreground"
          )}
          aria-label={t.label}
          title={t.label}
        >
          <span className={cn("h-8 w-full rounded bg-gradient-to-br", t.gradient)} />
          <span className="text-[10px] text-muted-foreground">{t.label}</span>
        </button>
      ))}
    </div>
  );
}
