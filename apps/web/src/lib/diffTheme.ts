// t3-light is pierre-light darkened until syntax reads on every light code surface.
export const DIFF_THEME_NAMES = {
  light: "t3-light",
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return DIFF_THEME_NAMES[theme];
}
