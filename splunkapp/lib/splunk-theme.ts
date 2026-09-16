import { getThemeOptions, getUserTheme } from "@splunk/splunk-utils/themes";

/** Whether the user is in a light or dark theme. */
export type SplunkColorScheme = "light" | "dark";

/**
 * Resolve a Splunk theme name to a colour scheme.
 *
 * `getUserTheme()` does NOT resolve to `"light"` or `"dark"` - it resolves to a theme *name*,
 * and Splunk has seven: `enterprise`, `enterpriseDark`, `light`, `dark`, `prismaLight`,
 * `prismaDark` and `lite`. Splunk Enterprise's dark theme reports `enterpriseDark`, so
 * comparing the name against `"dark"` is false in exactly the case that matters - the user is
 * in dark mode on the product this template targets, and nothing switches over.
 *
 * `getThemeOptions` is Splunk's own name-to-scheme mapping, which is why it is used here
 * instead of a hand-maintained list: it already covers the prisma family and falls back to
 * enterprise/light for names it does not recognise.
 */
export function colorSchemeOf(theme: string): SplunkColorScheme {
  const { colorScheme } = getThemeOptions(theme) as { colorScheme?: string };
  return colorScheme === "dark" ? "dark" : "light";
}

/** The colour scheme of the signed-in user's current Splunk theme. */
export async function resolveColorScheme(): Promise<SplunkColorScheme> {
  return colorSchemeOf(await getUserTheme());
}

/**
 * Put Tailwind's `dark` class on `<html>` (or take it off) to match `scheme`.
 *
 * It goes on `<html>` rather than the page root so that portalled content - dialogs, dropdown
 * menus, anything rendered into `document.body` instead of in place - sits inside it too.
 */
export function applyColorScheme(scheme: SplunkColorScheme): void {
  document.documentElement.classList.toggle("dark", scheme === "dark");
}
