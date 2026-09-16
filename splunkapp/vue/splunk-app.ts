import { inject, readonly, ref, type App, type InjectionKey, type Plugin, type Ref } from "vue";

import { fetchSplunkUser, type SplunkUser } from "../lib/splunk-user";
import type { SplunkColorScheme } from "../lib/splunk-theme";

const SPLUNK_USER: InjectionKey<Ref<SplunkUser | undefined>> = Symbol("splunkapp.user");
const SPLUNK_THEME: InjectionKey<Ref<SplunkColorScheme>> = Symbol("splunkapp.theme");

/**
 * The currently signed-in Splunk user, as a ref that starts `undefined` and fills in when the
 * lookup resolves. Always guard on it: `user?.realname`.
 *
 * ```vue
 * <script setup lang="ts">
 * import { useSplunkUser } from "@splunkapp/vue";
 * const user = useSplunkUser();
 * </script>
 * <template>Hello, {{ user?.realname ?? "world" }}!</template>
 * ```
 */
export function useSplunkUser(): Readonly<Ref<SplunkUser | undefined>> {
  const user = inject(SPLUNK_USER, undefined);
  if (!user) {
    throw new Error(
      "useSplunkUser() was called outside a page mounted by @splunkapp/vue. The build wraps " +
        "each entry in the Splunk plugin for you - this usually means the component was " +
        "mounted by hand with createApp()."
    );
  }
  return readonly(user) as Readonly<Ref<SplunkUser | undefined>>;
}

/** The user's Splunk colour scheme: `"light"` or `"dark"`. */
export function useSplunkTheme(): Readonly<Ref<SplunkColorScheme>> {
  const theme = inject(SPLUNK_THEME, undefined);
  if (!theme) {
    throw new Error(
      "useSplunkTheme() was called outside a page mounted by @splunkapp/vue. The build wraps " +
        "each entry in the Splunk plugin for you - this usually means the component was " +
        "mounted by hand with createApp()."
    );
  }
  return readonly(theme);
}

/**
 * Vue plugin supplying what `SplunkPage` supplies on the React side: the signed-in user and
 * the resolved colour scheme.
 *
 * The scheme is passed in rather than resolved here because the mount already had to await it
 * - Splunk's own chrome needs the raw theme *name* at the same moment. Resolving it twice
 * would risk the page and the chrome disagreeing for a frame.
 */
export function createSplunkAppPlugin(colorScheme: SplunkColorScheme): Plugin {
  return {
    install(app: App) {
      const user = ref<SplunkUser | undefined>(undefined);
      fetchSplunkUser().then((resolved) => {
        user.value = resolved;
      });

      app.provide(SPLUNK_USER, user);
      app.provide(SPLUNK_THEME, ref(colorScheme));
    },
  };
}
