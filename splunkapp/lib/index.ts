/**
 * Framework-agnostic half of the template runtime.
 *
 * Nothing in here imports React or Vue. `@splunkapp/react` and `@splunkapp/vue` are thin
 * adapters over this, which is what keeps the two frontends genuinely comparable - they differ
 * in presentation, not in what they know about Splunk.
 */

export {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  createSplunkApiClient,
  SplunkApiError,
  type SplunkApiClient,
  type SplunkApiRequestOptions,
} from "./splunk-api";
export { fetchSplunkUser, type SplunkUser } from "./splunk-user";
export {
  applyColorScheme,
  colorSchemeOf,
  resolveColorScheme,
  type SplunkColorScheme,
} from "./splunk-theme";
export { SPLUNK_LAYOUT_DEFAULTS, type SplunkPageOptions } from "./splunk-layout";
