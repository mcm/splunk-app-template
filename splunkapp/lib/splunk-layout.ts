/**
 * Options passed through to `@splunk/react-page`'s `layout()`, which draws the Splunk chrome
 * around a page.
 *
 * A page opts into any of these by exporting them:
 *
 * ```ts
 * export const splunkPageOptions = { hideAppBar: true };
 * ```
 *
 * Framework-neutral: the React and Vue mounts both take the same object, because both are
 * mounted inside the same Splunk layout.
 */
export type SplunkPageOptions = {
  pageTitle?: string;
  hideAppBar?: boolean;
  hideAppsList?: boolean;
  hideChrome?: boolean;
  hideFooter?: boolean;
  hideSplunkBar?: boolean;
  /** `"scrolling"` (default) or `"fixed"` to pin navigation bars to the page edge. */
  layout?: string;
  /**
   * Which navigation chrome to load. `"auto"` uses Splunk 10.4's modern sidebar when the
   * instance supports it and falls back to the classic bar when it does not; `"classic"`
   * always loads the old bar.
   *
   * `@splunk/react-page` defaults this to `"classic"`, which is why a React view renders the
   * pre-10.4 bar while a plain Splunk view in the same app gets the sidebar. This template
   * defaults it to `"auto"` instead - see `SPLUNK_LAYOUT_DEFAULTS`.
   */
  navLayout?: "auto" | "classic";
  useGlobalLayerStack?: boolean;
  /** `"enterprise"` (default) or `"prisma"`. */
  themeFamily?: string;
  /** `"comfortable"` or `"compact"`. Defaults per theme family. */
  themeDensity?: string;
  loader?: string;
  lazyLoadLayout?: boolean;
  SplunkBarFallback?: any;
  AppBarFallback?: any;
  onLayoutComplete?: Function;
  onLayoutStart?: Function;
};

/**
 * What this template asks for when a page says nothing.
 *
 * `navLayout: "auto"` opts into Splunk 10.4's modern sidebar. `@splunk/react-page` defaults it
 * to `"classic"`, which renders the pre-10.4 bar even on 10.4 - so an app's own pages would
 * disagree with every other view in the same Splunk. `"auto"` degrades to the classic bar on
 * older releases, so it is safe as a floor-independent default.
 */
export const SPLUNK_LAYOUT_DEFAULTS: SplunkPageOptions = { navLayout: "auto" };
