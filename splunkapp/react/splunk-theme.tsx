import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";

import {
  applyColorScheme,
  resolveColorScheme,
  type SplunkColorScheme,
} from "../lib/splunk-theme";

export type { SplunkColorScheme };

const SplunkThemeContext = createContext<SplunkColorScheme>("light");

/** The user's Splunk colour scheme: `"light"` or `"dark"`. */
export const useSplunkTheme = () => useContext(SplunkThemeContext);

/**
 * Mirrors the user's Splunk theme onto Tailwind's `dark` class.
 *
 * Deliberately NOT called `SplunkThemeProvider`: `@splunk/themes` exports a component by
 * that name which does something entirely different (it supplies the design-token context
 * that `@splunk/react-ui` components require). If you use `@splunk/react-ui`, you will have
 * both in scope - compose them, don't choose between them.
 */
export function TailwindThemeSync({ children }: PropsWithChildren) {
  const [colorScheme, setColorScheme] = useState<SplunkColorScheme>();

  useEffect(() => {
    resolveColorScheme().then((scheme) => {
      applyColorScheme(scheme);
      setColorScheme(scheme);
    });
  }, []);

  if (colorScheme === undefined) return <></>;

  return (
    <SplunkThemeContext.Provider value={colorScheme}>{children}</SplunkThemeContext.Provider>
  );
}
