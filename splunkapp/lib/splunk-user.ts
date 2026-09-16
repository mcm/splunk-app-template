import { createRESTURL } from "@splunk/splunk-utils/url";

/**
 * The Splunk user the page is running as, as returned by
 * `/services/authentication/current-context`.
 */
export interface SplunkUser {
  capabilities: string[];
  defaultApp: string;
  defaultAppIsUserOverride: boolean;
  defaultAppSourceRole: string;
  display_new_search_banner: boolean | null;
  email: string;
  lang: string;
  last_successful_login: number;
  "locked-out": boolean;
  realname: string;
  restart_background_jobs: boolean | null;
  roles: string[];
  search_assistant: string;
  search_auto_format: boolean;
  search_line_numbers: boolean;
  search_syntax_highlighting: string;
  search_use_advanced_editor: boolean;
  theme: string;
  type: string;
  tz: string;
  username: string;
}

/**
 * Look up the signed-in user. Resolves to `undefined` rather than throwing when the lookup
 * fails - identity is decoration on most pages, and a page that cannot say "Hello, Steve"
 * should still render.
 *
 * Framework-agnostic on purpose: `@splunkapp/react` and `@splunkapp/vue` both wrap this, so
 * there is one definition of what "the current user" means.
 */
export async function fetchSplunkUser(): Promise<SplunkUser | undefined> {
  const response = await fetch(createRESTURL("authentication/current-context?output_mode=json"));
  if (!response.ok) return undefined;

  const data = (await response.json()) as { entry?: Array<{ content?: SplunkUser }> };
  return data?.entry?.[0]?.content;
}
