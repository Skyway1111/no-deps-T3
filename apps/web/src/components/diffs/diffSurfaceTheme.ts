import { DIFF_SURFACE_THEME_UNSAFE_CSS } from "~/lib/diffRendering";

// The surface theme keeps its one home in diffRendering; every component that renders a code
// surface imports this module, which scopes the theme to those surfaces once.
if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.dataset.diffSurfaceTheme = "";
  style.textContent = `@scope (.diff-render-surface, .file-preview-virtualizer) {${DIFF_SURFACE_THEME_UNSAFE_CSS}}`;
  document.head.append(style);
}
