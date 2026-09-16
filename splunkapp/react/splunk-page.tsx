import { default as splunkReactLayout } from "@splunk/react-page/18";
import { getUserTheme } from "@splunk/splunk-utils/themes";
import type { ComponentType, PropsWithChildren } from "react";

import { SPLUNK_LAYOUT_DEFAULTS, type SplunkPageOptions } from "../lib/splunk-layout";
import { SplunkCurrentUserProvider } from "./splunk-current-user";
import { TailwindThemeSync } from "./splunk-theme";

export type { SplunkPageOptions };

/**
 * Providers every page inside this app needs. The build wraps your page in this
 * automatically, so you do not normally render it yourself.
 */
export function SplunkPage({ children }: PropsWithChildren) {
  return (
    <SplunkCurrentUserProvider>
      <TailwindThemeSync>{children}</TailwindThemeSync>
    </SplunkCurrentUserProvider>
  );
}

export type SplunkPageModule = {
  default: ComponentType;
  /** Optional per-page layout config: `export const splunkPageOptions = { hideAppBar: true }`. */
  splunkPageOptions?: SplunkPageOptions;
};

/**
 * Mounts a React page module into Splunk's app layout.
 *
 * Called by the entry module that `pluginSplunk` generates for each `source.entry` -
 * you should not need to call this by hand. It takes the whole module namespace, not the
 * component, so that `splunkPageOptions` can stay optional.
 */
export function mountSplunkPage(page: SplunkPageModule) {
  const Page = page.default;
  if (!Page) {
    throw new Error("A page module must have a default export (its React component).");
  }

  getUserTheme().then((theme) => {
    splunkReactLayout(
      <SplunkPage>
        <Page />
      </SplunkPage>,
      { ...SPLUNK_LAYOUT_DEFAULTS, theme, ...(page.splunkPageOptions || {}) }
    );
  });
}
