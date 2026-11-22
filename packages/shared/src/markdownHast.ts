import { normalizeMarkdownLinkDestination } from "./markdownLinks.ts";
import {
  elToHtml,
  elToReact,
  elToReactProps,
  HREF_PROTOCOLS,
  htmlAttributeName,
  normalizeLocalEditorLinksOnTree,
  preserveImageSourceMetaOnTree,
  renderMathSvg,
  SAFE_HTML_TAGS,
  sanitizeElTree,
  SRC_PROTOCOLS,
  URL_ATTRIBUTES,
  VOID_HTML_TAGS,
  wrapMathSvg,
  type ElContent,
  type ElElement,
  type ElNode,
  type ElProperties,
  type ElRoot,
  type ElText,
  type ReactRuntimeLike,
} from "./markdown/index.ts";

export {
  elToHtml,
  elToReact,
  elToReactProps,
  htmlAttributeName,
  renderMathSvg,
  URL_ATTRIBUTES,
  VOID_HTML_TAGS,
  wrapMathSvg,
  type ElContent,
  type ElElement,
  type ElNode,
  type ElProperties,
  type ElRoot,
  type ElText,
  type ReactRuntimeLike,
};

export function rehypePreserveImageSourceMeta() {
  return (tree: ElRoot) => {
    preserveImageSourceMetaOnTree(tree);
  };
}

export function rehypeNormalizeLocalEditorLinks() {
  return (tree: ElRoot) => {
    normalizeLocalEditorLinksOnTree(tree);
  };
}

export const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  tagNames: [...SAFE_HTML_TAGS],
  protocols: {
    href: [...HREF_PROTOCOLS],
    src: [...SRC_PROTOCOLS],
    dataDarkSrc: [...SRC_PROTOCOLS],
    dataLightSrc: [...SRC_PROTOCOLS],
  },
} as const;

/** Sanitizes an Element/HAST tree using T3 Code's strict allowlist sanitizer. */
export const sanitizeChatHast = (tree: ElRoot): ElRoot => sanitizeElTree(tree);

export type ChatMarkdownImageProperties = {
  readonly src?: unknown;
  readonly dataLocalSrc?: unknown;
  readonly dataDarkSrc?: unknown;
  readonly dataLightSrc?: unknown;
};

/** Keep the authored path for file links and normalize Windows separators for classification. */
export function chatMarkdownImageSource(
  properties?: ChatMarkdownImageProperties,
  theme?: "dark" | "light",
) {
  const themeSrc =
    theme === undefined
      ? undefined
      : properties?.[theme === "dark" ? "dataDarkSrc" : "dataLightSrc"];
  const localSrc = typeof themeSrc === "string" ? undefined : properties?.dataLocalSrc;
  const source =
    typeof themeSrc === "string"
      ? themeSrc
      : typeof localSrc === "string"
        ? localSrc
        : properties?.src;
  if (typeof source !== "string") return null;
  const authoredSrc = normalizeMarkdownLinkDestination(source);
  return {
    authoredSrc,
    classifiedSrc: typeof localSrc === "string" ? authoredSrc.replaceAll("\\", "/") : authoredSrc,
  };
}
