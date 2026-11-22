// Kept free of @pierre/diffs so code that only needs a theme name stays off the diff bundle.
/** pierre-light with every syntax color darkened until it reads on every light code surface. */
export const READABLE_LIGHT_THEME_NAME = "t3-light";

// Light mode uses a darker pierre-light so syntax stays readable on every code surface.
export const DIFF_THEME_NAMES = {
  light: READABLE_LIGHT_THEME_NAME,
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return DIFF_THEME_NAMES[theme];
}
