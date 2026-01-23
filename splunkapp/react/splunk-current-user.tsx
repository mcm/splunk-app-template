import { createRESTURL } from "@splunk/splunk-utils/url";
import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";

const SplunkCurrentUserContext = createContext<SplunkUser | undefined>(undefined)
export const getCurrentSplunkUser = () => useContext(SplunkCurrentUserContext);

export interface SplunkUser {
  capabilities: string[]
  defaultApp: string
  defaultAppIsUserOverride: boolean
  defaultAppSourceRole: string
  display_new_search_banner: boolean | null
  email: string
  lang: string
  last_successful_login: number
  "locked-out": boolean
  realname: string
  restart_background_jobs: boolean | null
  roles: string[]
  search_assistant: string
  search_auto_format: boolean
  search_line_numbers: boolean
  search_syntax_highlighting: string
  search_use_advanced_editor: boolean
  theme: string
  type: string
  tz: string
  username: string
}

export function SplunkCurrentUserProvider({ children }: PropsWithChildren) {
  const [currentSplunkUser, setCurrentSplunkUser] = useState<SplunkUser>();

  useEffect(() => {
    const url = createRESTURL("authentication/current-context?output_mode=json");
    fetch(url)
      .then((response) => {
        if (response.ok) {
          response.json().then((data) => {
            const context = data["entry"][0]["content"]
            setCurrentSplunkUser(context)
          })
        }
      })
  }, []);

  return (
    <SplunkCurrentUserContext.Provider value={currentSplunkUser}>
      {children}
    </SplunkCurrentUserContext.Provider>
  )
}