import {
  chatMarkdownImageSource,
  type ChatMarkdownImageProperties,
} from "./markdownHast.ts";
import {
  decodeHtmlEntities,
  decodeMarkdownLinkEscapes,
  elToHtml,
  extractCodexDirectives,
  extractHtmlComments,
  extractReferenceDefinitions,
  mdToElements,
  parseMarkdown,
  plainTextOf,
  renderMarkdownToElements,
  renderMarkdownToHtml,
  type ElContent,
  type ElElement,
  type ElNode,
  type ElProperties,
  type ElRoot,
  type ElText,
  type EmitOptions,
  type ExtractedCodexDirective,
  type MdNode,
  type MdRoot,
  type ParseOptions,
  type TextAutolink,
} from "./markdown/index.ts";

export {
  chatMarkdownImageSource,
  decodeHtmlEntities,
  decodeMarkdownLinkEscapes,
  elToHtml,
  extractCodexDirectives,
  extractHtmlComments,
  extractReferenceDefinitions,
  mdToElements,
  parseMarkdown,
  plainTextOf,
  renderMarkdownToElements,
  renderMarkdownToHtml,
  type ChatMarkdownImageProperties,
  type ElContent,
  type ElElement,
  type ElNode,
  type ElProperties,
  type ElRoot,
  type ElText,
  type EmitOptions,
  type ExtractedCodexDirective,
  type MdNode,
  type MdRoot,
  type ParseOptions,
  type TextAutolink,
};

/**
 * Collect the fallback and every theme variant so images are available to all viewers.
 */
export function chatMarkdownImageSources(markdown: string): Array<string> {
  if (!markdown.includes("![") && !/<(?:img|picture)\b/i.test(markdown)) return [];
  const tree = renderMarkdownToElements(
    markdown,
    {
      gfm: true,
      directives: true,
      windowsPaths: true,
      githubAlerts: true,
      normalizeListIndentation: true,
      autolinkBoundaries: true,
    },
    {
      sanitize: true,
      preserveImageMeta: true,
      normalizeLocalEditorLinks: true,
      normalizeWindowsLinks: true,
      linkFilePaths: true,
      tagInlineCode: true,
      breakAroundImageLines: true,
    },
  );
  const sources: Array<string> = [];
  const visit = (node: ElNode) => {
    if (node.type === "element" && node.tagName === "img") {
      const properties = node.properties as ChatMarkdownImageProperties;
      const fallback = chatMarkdownImageSource(properties);
      if (fallback) sources.push(fallback.classifiedSrc);
      for (const [theme, variant] of [
        ["dark", properties.dataDarkSrc],
        ["light", properties.dataLightSrc],
      ] as const) {
        if (typeof variant !== "string") continue;
        const source = chatMarkdownImageSource(properties, theme);
        if (source) sources.push(source.classifiedSrc);
      }
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(tree);
  return sources;
}
