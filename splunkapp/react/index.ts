/**
 * React bindings for the template runtime.
 *
 *     import { apiGet, useSplunkUser } from "@splunkapp/react";
 *
 * Everything Splunk-specific and framework-neutral lives in `@splunkapp/lib` and is
 * re-exported here, so a React page has one import to remember.
 */

export { SplunkPage, mountSplunkPage, type SplunkPageModule } from "./splunk-page";
export { SplunkCurrentUserProvider, useSplunkUser } from "./splunk-current-user";
export { TailwindThemeSync, useSplunkTheme } from "./splunk-theme";
export {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  createSplunkApiClient,
  SplunkApiError,
  fetchSplunkUser,
  type SplunkApiClient,
  type SplunkApiRequestOptions,
  type SplunkColorScheme,
  type SplunkPageOptions,
  type SplunkUser,
} from "../lib";
