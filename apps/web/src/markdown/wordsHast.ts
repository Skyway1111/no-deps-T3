import { expandGithubEmojiAliases } from "@t3tools/client-runtime/pull-request-markdown";
import { resolveChangeRequestMediaUrl } from "@t3tools/client-runtime/pull-request-references";
import type { ReferenceAutolink } from "@t3tools/client-runtime/source-control-clients";
import {
  wrapMathSvg,
  type ElContent,
  type ElElement,
  type ElRoot,
} from "@t3tools/shared/markdownHast";
import { markdownMathRanges as sharedMarkdownMathRanges } from "@t3tools/shared/markdownMath";
import {
  extractCodexDirectives,
  extractHtmlComments,
  extractReferenceDefinitions,
  renderMarkdownToElements,
  type ExtractedCodexDirective,
} from "@t3tools/shared/markdownPipeline";

import { rehypeChipPunctuation } from "../components/chat/markdownChipPunctuation";
import { rehypeHeadingIds } from "../components/chat/markdownFragments";
import { rehypeTextDirection } from "../components/chat/markdownTextDirection";

/** What a kind of message adds to chat Markdown. Pass a stable object: renderers cache by it. */
export interface MarkdownExtensions {
  /**
   * A sent user message: a single `~` stays text, and a written list number that breaks the
   * sequence stays, so the bubble shows what the composer showed.
   */
  readonly userMessage?: boolean;
  /** Spaces typed at the start of a line show, as the composer showed them (keepLeadingWhitespace). */
  readonly leadingWhitespace?: boolean;
  /** A saved file's Markdown, which must not load URLs or act: links, images and HTML are text. */
  readonly inert?: boolean;
  /** The whole message flattened to one line of text and math, or `fallback` when empty. */
  readonly preview?: { readonly fallback: string; readonly maxLength: number };
  /** A change request's body: root-relative media resolve on its host, and references link. */
  readonly changeRequest?: {
    readonly repositoryUrl: string;
    readonly autolinks: ((text: string) => ReadonlyArray<ReferenceAutolink>) | null;
  };
  /** Expand GitHub `:alias:` emoji shortcodes in prose outside code. */
  readonly githubEmoji?: boolean;
}

export interface WordsHastOptions {
  /** `$…$`, `$$…$$` and `math` code blocks render as SVG. */
  readonly math: boolean;
  /** Soft line breaks render as `<br>`, as remark-breaks does. */
  readonly breaks: boolean;
  /** Raw HTML shows as the text it was written as. */
  readonly escapeHtml: boolean;
  /** `★ Insight ───` blocks render as insight callouts. */
  readonly insights: boolean;
  readonly extensions: MarkdownExtensions;
}

export type CodexDirectiveSource = ExtractedCodexDirective;

const addHeadingIds = rehypeHeadingIds();
const addTextDirection = rehypeTextDirection();
const groupChipPunctuation = rehypeChipPunctuation();

const textOf = (node: ElContent): string =>
  node.type === "text" ? node.value : node.children.map(textOf).join("");

const PREVIEW_SEPARATED = new Set([
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
]);

/** Flattens a message to one line of text and inline math, bounded by `maxLength`. */
function flattenPreview(tree: ElRoot, preview: NonNullable<MarkdownExtensions["preview"]>): ElRoot {
  const children: ElContent[] = [];
  let remaining = preview.maxLength;
  let fragments: string[] = [];

  const flush = () => {
    if (fragments.length === 0) return;
    children.push({ type: "text", value: fragments.join("").replace(/\s+/g, " ") });
    fragments = [];
  };

  const take = (value: string) => {
    const text = value.slice(0, remaining);
    remaining = text.length < value.length ? 0 : remaining - text.length;
    return text.replace(/[\uD800-\uDBFF]$/, "");
  };

  const visit = (node: ElRoot | ElContent) => {
    if (remaining === 0) return;
    if (node.type === "text") {
      fragments.push(take(node.value));
      return;
    }
    if (node.type === "element" && node.properties.dataMarkdownMath !== undefined) {
      flush();
      const svg = node.children[0];
      if (node.properties.dataMarkdownMath === "display" && svg?.type === "element") {
        const inlineSvg: ElElement = {
          ...svg,
          properties: {
            ...svg.properties,
            style: "display:inline;vertical-align:middle;overflow:visible",
          },
        };
        children.push(wrapMathSvg(inlineSvg, String(svg.properties.ariaLabel ?? ""), false));
      } else {
        children.push(node);
      }
      return;
    }
    if (node.type === "element" && node.tagName === "img") {
      fragments.push(take(String(node.properties.alt ?? "")));
      return;
    }
    if (node.type === "element" && node.tagName === "br") {
      fragments.push(take(" "));
      return;
    }
    const separates = node.type === "root" || PREVIEW_SEPARATED.has(node.tagName);
    let first = true;
    for (const child of node.children) {
      if (remaining === 0) break;
      if (child.type === "text" && child.value.trim() === "" && separates) continue;
      if (!first && separates) fragments.push(take(" "));
      first = false;
      visit(child);
    }
  };

  visit(tree);
  flush();
  const head = children[0];
  const tail = children.at(-1);
  if (head?.type === "text") head.value = head.value.trimStart();
  if (tail?.type === "text") tail.value = tail.value.trimEnd();
  const visible = children.some((child) => child.type !== "text" || child.value);
  return {
    type: "root",
    children: visible ? children : [{ type: "text", value: preview.fallback }],
  };
}

/** Links become their text, images their alt text, inline code plain text, Mermaid plain code. */
function makeInert(node: ElRoot | ElElement) {
  const children = node.children;
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type !== "element") continue;
    if (child.tagName === "a") {
      children.splice(index, 1, ...child.children);
      index--;
      continue;
    }
    if (child.tagName === "img") {
      children[index] = { type: "text", value: String(child.properties.alt ?? "") };
      continue;
    }
    if (child.tagName === "code" && child.properties.dataInlineCode !== undefined) {
      children[index] = { type: "text", value: textOf(child) };
      continue;
    }
    if (
      child.tagName === "code" &&
      String(child.properties.className ?? "").includes("language-mermaid")
    ) {
      child.properties.className = ["language-text"];
    }
    makeInert(child);
  }
}

/** ChatMarkdown's sanitized Element Tree for `text`, built directly from the unified parser. */
export function wordsHast(text: string, options: WordsHastOptions): ElRoot {
  const { extensions } = options;
  const changeRequest = extensions.changeRequest;
  const skipHtml = Boolean(extensions.preview || extensions.inert);

  const tree = renderMarkdownToElements(
    text,
    {
      gfm: true,
      singleTilde: !extensions.userMessage,
      math: options.math,
      directives: true,
      insights: options.insights,
      windowsPaths: true,
      githubAlerts: true,
      normalizeListIndentation: true,
      keepOrderedListNumbers: extensions.userMessage === true,
      leadingWhitespace: extensions.leadingWhitespace === true,
      autolinkBoundaries: true,
    },
    {
      breaks: options.breaks,
      math: options.math,
      skipHtml,
      escapeHtml: !skipHtml && options.escapeHtml,
      sanitize: true,
      linkFilePaths: true,
      breakAroundImageLines: true,
      tagInlineCode: true,
      normalizeWindowsLinks: true,
      preserveImageMeta: true,
      normalizeLocalEditorLinks: true,
      resolveMediaUrl: changeRequest
        ? (src) => resolveChangeRequestMediaUrl(src, changeRequest.repositoryUrl)
        : undefined,
      textAutolinks: changeRequest?.autolinks,
      transformText: extensions.githubEmoji
        ? (value) => (value.includes(":") ? expandGithubEmojiAliases(value) : value)
        : undefined,
    },
  );

  if (extensions.inert) makeInert(tree);
  if (extensions.preview) return flattenPreview(tree, extensions.preview);

  addHeadingIds(tree as never);
  addTextDirection(tree as never);
  groupChipPunctuation(tree as never);
  return tree;
}

/** The Codex directives in `markdown` with exact UTF-16 source offsets. */
export function codexDirectiveSources(markdown: string): CodexDirectiveSource[] {
  return extractCodexDirectives(markdown);
}

/** Unsanitized Element Tree for structural queries (excerpts, minimap, clipboard). */
export function markdownTree(
  markdown: string,
  options: { skipHtml?: boolean; singleTilde?: boolean; math?: boolean } = {},
): ElRoot {
  return renderMarkdownToElements(
    markdown,
    {
      gfm: true,
      windowsPaths: true,
      autolinkBoundaries: true,
      singleTilde: options.singleTilde !== false,
      math: options.math === true,
    },
    {
      skipHtml: options.skipHtml === true,
      math: options.math === true,
      sanitize: false,
    },
  );
}

/** Source offsets of parsed math formulas in `text`. */
export function markdownMathRanges(text: string): Array<{ start: number; end: number }> {
  return sharedMarkdownMathRanges(text).map(({ start, end }) => ({ start, end }));
}

/** Source offsets of real HTML comments outside code blocks/spans. */
export function markdownHtmlComments(markdown: string): Array<{ start: number; end: number }> {
  return extractHtmlComments(markdown);
}

/** First reference definition of each label in `markdown`, normalized to one line each. */
export function markdownReferenceDefinitions(markdown: string): string[] {
  return extractReferenceDefinitions(markdown);
}
