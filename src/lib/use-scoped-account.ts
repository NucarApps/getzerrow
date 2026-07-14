import { useCallback, useState } from "react";
import { useAccountSelection } from "./account-selection";

/**
 * Shared settings-page helper: wires the global active-account selection to a
 * locally scoped email label. Removes the repeated
 * `useState(scopedEmail)` + inline `AccountPicker` onChange boilerplate that
 * every settings route used to duplicate.
 */
export function useScopedAccount() {
  const { activeAccountId, setActiveAccountId } = useAccountSelection();
  const [scopedEmail, setScopedEmail] = useState<string | null>(null);

  const onAccountChange = useCallback(
    (id: string, email: string) => {
      setActiveAccountId(id);
      setScopedEmail(email);
    },
    [setActiveAccountId],
  );

  return { activeAccountId, setActiveAccountId, scopedEmail, onAccountChange };
}
