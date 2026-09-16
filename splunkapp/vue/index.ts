/**
 * Vue bindings for the template runtime.
 *
 *     import { apiGet, useSplunkUser } from "@splunkapp/vue";
 *
 * Same surface as `@splunkapp/react`, with Vue refs where React has hooks. Everything
 * Splunk-specific and framework-neutral lives in `@splunkapp/lib` and is re-exported here.
 */

export { mountSplunkPage, type SplunkPageModule } from "./splunk-page";
export { createSplunkAppPlugin, useSplunkUser, useSplunkTheme } from "./splunk-app";
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
