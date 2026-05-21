import { createContext, useContext, useState, type ReactNode } from "react";

export type FolderSelection = string | "all" | "all_mail" | "no_rules";

type Ctx = {
  selected: FolderSelection;
  setSelected: (v: FolderSelection) => void;
};

const FolderSelectionContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "zerrow.selectedFolder";

export function FolderSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelectedState] = useState<FolderSelection>(() => {
    if (typeof window === "undefined") return "all";
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      return (v as FolderSelection) || "all";
    } catch {
      return "all";
    }
  });
  const setSelected = (v: FolderSelection) => {
    setSelectedState(v);
    try { window.localStorage.setItem(STORAGE_KEY, v); } catch { /* ignore */ }
  };
  return (
    <FolderSelectionContext.Provider value={{ selected, setSelected }}>
      {children}
    </FolderSelectionContext.Provider>
  );
}

export function useFolderSelection() {
  const ctx = useContext(FolderSelectionContext);
  if (!ctx) throw new Error("useFolderSelection must be used inside FolderSelectionProvider");
  return ctx;
}
