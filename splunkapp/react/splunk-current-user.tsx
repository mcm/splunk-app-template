import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";

import { fetchSplunkUser, type SplunkUser } from "../lib/splunk-user";

export type { SplunkUser };

const SplunkCurrentUserContext = createContext<SplunkUser | undefined>(undefined);

/**
 * The currently signed-in Splunk user, or `undefined` until the lookup resolves.
 * Always guard on it: `user?.realname`.
 */
export const useSplunkUser = () => useContext(SplunkCurrentUserContext);

export function SplunkCurrentUserProvider({ children }: PropsWithChildren) {
  const [currentSplunkUser, setCurrentSplunkUser] = useState<SplunkUser>();

  useEffect(() => {
    let cancelled = false;
    fetchSplunkUser().then((user) => {
      if (!cancelled) setCurrentSplunkUser(user);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SplunkCurrentUserContext.Provider value={currentSplunkUser}>
      {children}
    </SplunkCurrentUserContext.Provider>
  );
}
