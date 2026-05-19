import { createContext, useContext, useState, type ReactNode } from "react";

export type FolderSelection = string | "all" | "unsorted";

type Ctx = {
  selected: FolderSelection;
  setSelected: (v: FolderSelection) => void;
};

const FolderSelectionContext = createContext<Ctx | null>(null);

export function FolderSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<FolderSelection>("all");
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
