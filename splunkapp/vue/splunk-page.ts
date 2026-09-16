import { default as splunkReactLayout } from "@splunk/react-page/18";
import { getUserTheme } from "@splunk/splunk-utils/themes";
import { createElement, useEffect, useRef } from "react";
import { createApp, type Component } from "vue";

import { SPLUNK_LAYOUT_DEFAULTS, type SplunkPageOptions } from "../lib/splunk-layout";
import { applyColorScheme, colorSchemeOf, type SplunkColorScheme } from "../lib/splunk-theme";
import { createSplunkAppPlugin } from "./splunk-app";

export type { SplunkPageOptions };

export type SplunkPageModule = {
  default: Component;
  /** Optional per-page layout config: `export const splunkPageOptions = { hideAppBar: true }`. */
  splunkPageOptions?: SplunkPageOptions;
};

/*
 Splunk's app chrome - the sidebar, the bar across the top, the footer - is React, and
 `@splunk/react-page` is the only supported way to draw it. There is no Vue equivalent.

 So a Vue page runs inside a one-component React host: React owns the chrome, Vue owns
 everything from `<div data-splunk-vue-root>` down. The two never talk. React never re-renders
 this element (it has no props that change), so Vue keeps full control of its own subtree.

 The consequence is that a Vue bundle still carries React.
 */
function VueHost({ page, colorScheme }: { page: SplunkPageModule; colorScheme: SplunkColorScheme }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const app = createApp(page.default);
    app.use(createSplunkAppPlugin(colorScheme));
    app.mount(element);

    return () => {
      app.unmount();
    };
  }, [page, colorScheme]);

  return createElement("div", { ref: host, "data-splunk-vue-root": "" });
}

/**
 * Mounts a Vue page module into Splunk's app layout.
 *
 * Called by the entry module that `pluginSplunk` generates for each `.vue` entry in
 * `source.entry` - you should not need to call this by hand. It takes the whole module
 * namespace, not the component, so that `splunkPageOptions` can stay optional.
 */
export function mountSplunkPage(page: SplunkPageModule) {
  if (!page.default) {
    throw new Error("A page module must have a default export (its Vue component).");
  }

  getUserTheme().then((theme) => {
    // Resolved once, here, and handed to both halves: Splunk's chrome takes the raw theme
    // *name*, Tailwind and the page take the light/dark scheme derived from it.
    const colorScheme = colorSchemeOf(theme);
    applyColorScheme(colorScheme);

    splunkReactLayout(createElement(VueHost, { page, colorScheme }), {
      ...SPLUNK_LAYOUT_DEFAULTS,
      theme,
      ...(page.splunkPageOptions || {}),
    });
  });
}
