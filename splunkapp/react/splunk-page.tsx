import { default as splunkReactLayout } from "@splunk/react-page/18";
import { getUserTheme } from "@splunk/splunk-utils/themes";
import React from "react";

import { SplunkCurrentUserProvider } from "./splunk-current-user";
import { SplunkThemeProvider } from "./splunk-theme";

export function SplunkPage(
  root: React.ReactNode,
  options?: {
    pageTitle?: string;
    hideAppBar?: boolean;
    hideAppsList?: boolean;
    hideChrome?: boolean;
    hideFooter?: boolean;
    hideSplunkBar?: boolean;
    layout?: string;
    useGlobalLayerStack?: boolean;
    loader?: string;
    lazyLoadLayout?: boolean;
    SplunkBarFallback?: any;
    AppBarFallback?: any;
    onLayoutComplete?: Function;
  }
) {
  if (options === undefined) {
    options = {}
  }

  getUserTheme().then((theme) => {
    splunkReactLayout(
        <SplunkCurrentUserProvider>
          <SplunkThemeProvider>
            {root}
          </SplunkThemeProvider>
        </SplunkCurrentUserProvider>,
      { theme, ...options }
    )
  });
}