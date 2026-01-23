import { getUserTheme } from "@splunk/splunk-utils/themes";
import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";


const SplunkThemeContext = createContext('light')
export const getSplunkTheme = () => useContext(SplunkThemeContext);

export function SplunkThemeProvider({ children }: PropsWithChildren) {
  const [theme, setTheme] = useState<string>();

  useEffect(() => {
    getUserTheme().then((theme) => {
      const isDark = theme === 'dark';
      document.documentElement.classList[isDark ? 'add' : 'remove']('dark');
      setTheme(theme)
    });
  }, []);

  if (theme === undefined) return <></>;

  return (
    <SplunkThemeContext.Provider value={theme}>
      {children}
    </SplunkThemeContext.Provider>
  )
}