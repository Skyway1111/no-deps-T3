import { getSharedHighlighter, type Highlighter } from "@t3tools/shared/highlight";

import { DIFF_THEME_NAMES } from "./diffTheme";

let highlighterPromise: Promise<Highlighter> | undefined;

/** Every grammar is bundled, so one stable promise serves every language (`use()` needs that). */
export function getSyntaxHighlighterPromise(_language?: string): Promise<Highlighter> {
  // Both palettes, so switching appearance never needs a new highlighter.
  return (highlighterPromise ??= getSharedHighlighter({ themes: Object.values(DIFF_THEME_NAMES) }));
}
