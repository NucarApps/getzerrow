import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Ctx = {
  activeAccountId: string | null;
  setActiveAccountId: (id: string | null) => void;
};

const AccountSelectionContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "zerrow.activeAccountId";

export function AccountSelectionProvider({ children }: { children: ReactNode }) {
  const [activeAccountId, setActiveAccountIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const setActiveAccountId = (id: string | null) => {
    setActiveAccountIdState(id);
    try {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  // Keep selection in sync across tabs
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setActiveAccountIdState(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <AccountSelectionContext.Provider value={{ activeAccountId, setActiveAccountId }}>
      {children}
    </AccountSelectionContext.Provider>
  );
}

export function useAccountSelection() {
  const ctx = useContext(AccountSelectionContext);
  if (!ctx) throw new Error("useAccountSelection must be used inside AccountSelectionProvider");
  return ctx;
}
