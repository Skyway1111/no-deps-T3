import { normalizeMarkdownLinkDestination } from "./markdownLinks.ts";
import {
  elToHtml,
  elToReact,
  elToReactProps,
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
