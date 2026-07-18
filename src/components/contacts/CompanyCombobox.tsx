import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronsUpDown, Building2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { listCompanies } from "@/lib/companies/companies.functions";

type Props = {
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
  className?: string;
};

export function CompanyCombobox({ value, onChange, placeholder, className }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const fetchCompanies = useServerFn(listCompanies);
  const q = useQuery({
    queryKey: ["companies", "picker"],
    queryFn: () => fetchCompanies(),
    staleTime: 60_000,
  });

  const options = useMemo(() => {
    const list = q.data?.companies ?? [];
    const term = query.trim().toLowerCase();
    if (!term) return list.slice(0, 200);
    return list
      .filter((c) => c.name.toLowerCase().includes(term))
      .slice(0, 200);
  }, [q.data, query]);

  const exactMatch = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return null;
    return (q.data?.companies ?? []).find((c) => c.name.toLowerCase() === term) ?? null;
  }, [q.data, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span className="flex items-center gap-2 truncate">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value || placeholder || "Select or create a company"}
            </span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type new…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No companies yet.</CommandEmpty>
            {value && (
              <CommandGroup heading="Current">
                <CommandItem
                  value="__clear"
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  Clear company
                </CommandItem>
              </CommandGroup>
            )}
            {query.trim() && !exactMatch && (
              <CommandGroup heading="Create">
                <CommandItem
                  value={`__create:${query}`}
                  onSelect={() => {
                    onChange(query.trim());
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Create "{query.trim()}"
                </CommandItem>
              </CommandGroup>
            )}
            {options.length > 0 && (
              <CommandGroup heading="Companies">
                {options.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={c.name}
                    onSelect={() => {
                      onChange(c.name);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value.toLowerCase() === c.name.toLowerCase()
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                    <span className="flex-1 truncate">{c.name}</span>
                    {c.member_count > 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {c.member_count}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
